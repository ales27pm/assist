import AVFoundation
import Contacts
import CoreLocation
import EventKit
import Foundation
import ImageIO
import LocalAuthentication
import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import Vision

/// A native-owned EventKit destination captured before a tool preview. The
/// identifier is used for the eventual explicit save; the title is transient
/// preview data and must never be persisted in a transaction journal.
struct AssistDeviceCalendarDestination: Sendable {
    let identifier: String
    let title: String
}

/// OCR is deliberately a compact, non-authoritative observation. It is created
/// only for the one image selected in the current tool interaction and never
/// carries the image, a file URL, or a Vision framework error across the bridge.
private struct AssistDeviceOCRSummary: Sendable {
    let status: String
    let text: String?
    let lines: Int
    let truncated: Bool
}

/// Owns the one Vision request that is currently executing for a tool image.
/// `VNRequest.cancel()` is the framework's supported cancellation entry point.
/// This deliberately narrow `@unchecked Sendable` boundary is safe because the
/// request is never returned or shared with other code, every access here is
/// serialized by `lock`, and the worker keeps its own strong reference until
/// `perform` returns. It exists solely so cancellation can reach Vision while
/// the worker is blocked in its synchronous framework call.
private final class AssistVisionRequestGate: @unchecked Sendable {
    private let lock = NSLock()
    private var request: VNRecognizeTextRequest?
    private var cancelled = false

    /// Registers before `perform`. A cancellation that wins this race prevents
    /// the request from beginning at all.
    func install(_ request: VNRecognizeTextRequest) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled, self.request == nil else { return false }
        self.request = request
        return true
    }

    /// Releases the extra ownership after the worker has returned from Vision.
    func clear() {
        lock.lock()
        request = nil
        lock.unlock()
    }

    /// This is idempotent and may run before registration. It first removes
    /// the gate's ownership, then invokes Vision's documented cancellation API.
    func cancel() {
        lock.lock()
        cancelled = true
        let request = self.request
        self.request = nil
        lock.unlock()
        request?.cancel()
    }
}

/// A user-invoked iOS capability gateway. It deliberately does not persist or
/// transmit personal data: callers receive only the result requested for the
/// current action, and iOS owns every consent prompt.
@MainActor
@objc(AssistDeviceCapabilities)
// Core Location invokes this delegate on the run loop where its manager was
// created; this class creates and configures that manager on the main actor.
// Keep the preconcurrency adapter until the iOS SDK annotates the protocol's
// delegate requirements with the same actor isolation.
final class AssistDeviceCapabilities: NSObject, @preconcurrency CLLocationManagerDelegate,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate, PHPickerViewControllerDelegate {

    typealias Completion = @MainActor @Sendable (String?, NSError?) -> Void

    private let contacts = CNContactStore()
    private let events = EKEventStore()
    private let notificationCenter = UNUserNotificationCenter.current()
    private var invalidated = false
    private var locationManager: CLLocationManager?
    private var locationPermissionCompletion: Completion?
    private var locationCompletion: Completion?
    private var locationTimeout: Task<Void, Never>?
    private var attachmentCompletion: Completion?
    private var attachmentAuthorizationPending = false
    private var pendingCameraCaptureCompletion: Completion?
    private var pendingCameraCaptureOCR = false
    private var pendingCameraCaptureToken: UUID?
    private var attachmentOCRRequested = false
    private var attachmentOCRTask: Task<Void, Never>?
    private var attachmentOCRToken: UUID?
    private var attachmentOCRRequestGate: AssistVisionRequestGate?
    /// Every system picker/camera presentation receives a fresh identity. A
    /// delayed provider completion can therefore never consume a newer tool's
    /// completion or OCR mode after cancellation/re-presentation.
    private var attachmentGeneration: UUID?
    private var activeBiometricContext: LAContext?
    private var activeBiometricToken: UUID?
    private weak var attachmentPicker: UIViewController?
    private var generatedAttachmentURLs = Set<URL>()

    private static let maxResults = 50
    private static let maxPayloadBytes = 16 * 1024
    private static let temporaryAttachmentDirectory = "AssistAttachments"
    private static let maximumAttachmentDimension: CGFloat = 2_048
    private static let maximumAttachmentBytes = 10 * 1024 * 1024
    /// Metadata is inspected before `UIImage(data:)` so a small compressed
    /// image cannot trigger an unbounded bitmap decode in the app process.
    private static let maximumInputImageDimension = 4_096
    private static let maximumInputImagePixels = 16 * 1_024 * 1_024
    private nonisolated static let maximumOCRTextBytes = 8 * 1024
    private nonisolated static let maximumOCRLines = 40

    // MARK: Permission discovery and requests

    /// Status inspection is read-only and never creates an iOS permission prompt.
    @objc(capabilityStatus:)
    func capabilityStatus(_ completion: @escaping Completion) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            var capabilities = Self.capabilityStates()
            let settings = await self.notificationCenter.notificationSettings()
            capabilities[Capability.notifications.rawValue] = Self.notificationState(settings.authorizationStatus)
            completion(Self.encode([
                "capabilities": capabilities,
                "boundaries": Self.boundaries(),
            ]), nil)
        }
    }

    /// Requests one capability only after a user action in JavaScript. This
    /// class never batches unrelated consent dialogs.
    @objc(requestCapability:completion:)
    func requestCapability(_ capability: String, completion: @escaping Completion) {
        guard let capability = Capability(rawValue: capability) else {
            completion(nil, Self.error("E_CAPABILITY", "Cette capacité native n’est pas prise en charge."))
            return
        }

        switch capability {
        case .contacts:
            requestContacts(completion)
        case .calendar:
            requestCalendar(completion)
        case .reminders:
            requestReminders(completion)
        case .location:
            requestLocationPermission(completion)
        case .camera:
            requestCamera(completion)
        case .notifications:
            requestNotifications(completion)
        case .biometrics:
            let biometrics = Self.biometricStatus()
            completion(Self.encode([
                "capability": Capability.biometrics.rawValue,
                "status": (biometrics["available"] as? Bool) == true ? "authorized" : "unavailable",
                "biometrics": biometrics,
            ]), nil)
        }
    }

    // MARK: Contacts

    /// Searches the contacts matching a user supplied term. Empty searches are
    /// rejected so the bridge cannot silently enumerate an address book.
    @objc(searchContacts:limit:completion:)
    func searchContacts(_ query: String, limit: String, completion: Completion) {
        guard Self.contactsAuthorized else {
            completion(nil, Self.permissionError("contacts"))
            return
        }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, query.utf8.count <= 256 else {
            completion(nil, Self.error("E_CONTACT_QUERY", "La recherche de contacts doit contenir entre 1 et 256 caractères."))
            return
        }
        guard let limit = Self.resultLimit(limit) else {
            completion(nil, Self.error("E_RESULT_LIMIT", "La limite doit être comprise entre 1 et 50."))
            return
        }

        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
        ]
        do {
            let request = CNContactFetchRequest(keysToFetch: keys)
            request.predicate = CNContact.predicateForContacts(matchingName: query)
            var rows = [[String: Any]]()
            try contacts.enumerateContacts(with: request) { contact, stop in
                rows.append([
                    "id": contact.identifier,
                    "givenName": contact.givenName,
                    "familyName": contact.familyName,
                    "organizationName": contact.organizationName,
                    "phoneNumbers": contact.phoneNumbers.map { value in
                        ["label": CNLabeledValue<NSString>.localizedString(forLabel: value.label ?? ""),
                         "value": value.value.stringValue]
                    },
                    "emailAddresses": contact.emailAddresses.map { value in
                        ["label": CNLabeledValue<NSString>.localizedString(forLabel: value.label ?? ""),
                         "value": value.value as String]
                    },
                ])
                if rows.count >= limit { stop.pointee = true }
            }
            completion(Self.encode(["contacts": rows, "query": query]), nil)
        } catch {
            completion(nil, Self.error("E_CONTACTS_READ", "Impossible de lire ces contacts.", underlying: error))
        }
    }

    // MARK: Calendar and reminders

    /// Dedicated read-only seam for one native-owned user-turn scope. It never
    /// requests permission or promotes a model-provided period into authority.
    func readCalendarForAgent(
        scope: AssistAgentCalendarScope, admission: AssistAgentAdmission
    ) async throws -> AssistAgentCalendarObservation {
        try admission.check()
        try Task.checkCancellation()
        guard !invalidated else { throw Self.error("E_INVALIDATED", "Le module a été fermé.") }
        guard UIApplication.shared.applicationState == .active else {
            throw Self.error("E_CANCELLED", "La lecture du calendrier nécessite l’app au premier plan.")
        }
        _ = try scope.validatedInterval()
        guard Self.calendarAuthorized else { throw Self.permissionError("calendar") }
        let json: String = try await withCheckedThrowingContinuation { continuation in
            listCalendarEvents("", startISO: scope.startISO, endISO: scope.endISO, limit: "5") { value, error in
                if let error { continuation.resume(throwing: error) }
                else if let value { continuation.resume(returning: value) }
                else { continuation.resume(throwing: AssistAgentCalendarFailure.invalidResult) }
            }
        }
        try Task.checkCancellation()
        try admission.check()
        guard !invalidated else { throw Self.error("E_INVALIDATED", "Le module a été fermé.") }
        guard UIApplication.shared.applicationState == .active else {
            throw Self.error("E_CANCELLED", "La lecture du calendrier a été interrompue.")
        }
        guard Self.calendarAuthorized else { throw Self.permissionError("calendar") }
        return try AssistAgentCalendarObservation.validated(json: json, scope: scope)
    }

    /// Reads the current OS permission state without creating a prompt. The
    /// transaction coordinator calls this before it creates a confirmation
    /// token, so a model call can never turn into an implicit consent request.
    func toolPermissionStatus(for capability: String) async -> String {
        switch capability {
        case "contacts":
            return Self.contactsState(CNContactStore.authorizationStatus(for: .contacts))
        case "calendar":
            return Self.eventState(EKEventStore.authorizationStatus(for: .event))
        case "reminders":
            return Self.eventState(EKEventStore.authorizationStatus(for: .reminder))
        case "location":
            return Self.locationState(CLLocationManager().authorizationStatus)
        case "camera":
            return Self.cameraState(AVCaptureDevice.authorizationStatus(for: .video))
        case "notifications":
            let settings = await notificationCenter.notificationSettings()
            return Self.notificationState(settings.authorizationStatus)
        case "biometrics":
            return (Self.biometricStatus()["available"] as? Bool) == true ? "available" : "unavailable"
        case "none":
            return "notRequired"
        default:
            return "unsupported"
        }
    }

    /// Resolves a modifiable EventKit destination once, before confirmation.
    /// Later execution must use this exact identifier rather than asking
    /// EventKit for a potentially changed default calendar or reminder list.
    func captureCalendarDestination(
        calendarIdentifier: String?, forReminders: Bool
    ) throws -> AssistDeviceCalendarDestination {
        let authorized = forReminders ? Self.remindersAuthorized : Self.calendarAuthorized
        guard authorized else {
            throw Self.permissionError(forReminders ? "reminders" : "calendar")
        }
        let requested = calendarIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines)
        let calendar: EKCalendar?
        if let requested, !requested.isEmpty {
            calendar = events.calendar(withIdentifier: requested)
        } else if forReminders {
            calendar = events.defaultCalendarForNewReminders()
        } else {
            calendar = events.defaultCalendarForNewEvents
        }
        guard let calendar, calendar.allowsContentModifications else {
            throw Self.error(
                "E_CALENDAR",
                forReminders
                    ? "Aucune liste de rappels modifiable n’est disponible."
                    : "Aucun calendrier modifiable n’est disponible."
            )
        }
        return AssistDeviceCalendarDestination(
            identifier: calendar.calendarIdentifier,
            title: calendar.title
        )
    }

    @objc(listCalendarEvents:startISO:endISO:limit:completion:)
    func listCalendarEvents(_ calendarIdentifier: String, startISO: String, endISO: String,
                            limit: String, completion: Completion) {
        guard Self.calendarAuthorized else {
            completion(nil, Self.permissionError("calendar"))
            return
        }
        guard let interval = Self.dateInterval(startISO: startISO, endISO: endISO),
              let limit = Self.resultLimit(limit) else {
            completion(nil, Self.error("E_CALENDAR_QUERY", "La période ou la limite des événements est invalide."))
            return
        }
        let calendars: [EKCalendar]?
        if calendarIdentifier.isEmpty {
            calendars = nil
        } else if let calendar = events.calendar(withIdentifier: calendarIdentifier) {
            calendars = [calendar]
        } else {
            completion(nil, Self.error("E_CALENDAR", "Ce calendrier n’est pas disponible."))
            return
        }

        let predicate = events.predicateForEvents(withStart: interval.start, end: interval.end, calendars: calendars)
        var rows = [[String: Any]]()
        events.enumerateEvents(matching: predicate) { event, stop in
            rows.append([
                    "id": event.eventIdentifier ?? event.calendarItemIdentifier,
                    "calendarId": event.calendar.calendarIdentifier,
                    "calendarTitle": event.calendar.title,
                    "title": event.title ?? "",
                    "startISO": Self.isoString(event.startDate),
                    "endISO": Self.isoString(event.endDate),
                    "allDay": event.isAllDay,
            ])
            if rows.count >= limit { stop.pointee = true }
        }
        completion(Self.encode(["events": rows]), nil)
    }

    /// Creates a new event only. Updating and deleting existing events are not
    /// exposed in this first capability slice to prevent broad mutations.
    @objc(createCalendarEvent:completion:)
    func createCalendarEvent(_ payload: String, completion: Completion) {
        guard Self.calendarAuthorized else {
            completion(nil, Self.permissionError("calendar"))
            return
        }
        do {
            let value = try Self.payloadObject(payload)
            guard let title = Self.shortString(value["title"], maxLength: 512),
                  let start = Self.date(value["startISO"]), let end = Self.date(value["endISO"]),
                  start < end, end.timeIntervalSince(start) <= 366 * 24 * 60 * 60 else {
                throw Self.error("E_CALENDAR_EVENT", "Le titre ou les dates de l’événement sont invalides.")
            }
            let event = EKEvent(eventStore: events)
            event.title = title
            event.startDate = start
            event.endDate = end
            if let notes = Self.optionalString(value["notes"], maxLength: 4_000) { event.notes = notes }
            if let location = Self.optionalString(value["location"], maxLength: 512) { event.location = location }
            if let identifier = Self.optionalString(value["calendarId"], maxLength: 256) {
                guard let calendar = events.calendar(withIdentifier: identifier), calendar.allowsContentModifications else {
                    throw Self.error("E_CALENDAR", "Ce calendrier ne permet pas l’ajout d’événements.")
                }
                event.calendar = calendar
            } else if let calendar = events.defaultCalendarForNewEvents {
                event.calendar = calendar
            } else {
                throw Self.error("E_CALENDAR", "Aucun calendrier modifiable n’est disponible.")
            }
            try events.save(event, span: .thisEvent, commit: true)
            completion(Self.encode([
                "id": event.eventIdentifier ?? event.calendarItemIdentifier,
                "calendarId": event.calendar.calendarIdentifier,
                "title": title,
                "startISO": Self.isoString(start),
                "endISO": Self.isoString(end),
            ]), nil)
        } catch let error as NSError {
            completion(nil, error)
        } catch {
            completion(nil, Self.error("E_CALENDAR_WRITE", "Impossible d’ajouter cet événement.", underlying: error))
        }
    }

    @objc(listReminders:startISO:endISO:limit:completion:)
    func listReminders(_ includeCompleted: Bool, startISO: String, endISO: String,
                       limit: String, completion: @escaping Completion) {
        guard Self.remindersAuthorized else {
            completion(nil, Self.permissionError("reminders"))
            return
        }
        guard let interval = Self.reminderDateInterval(startISO: startISO, endISO: endISO),
              let limit = Self.resultLimit(limit) else {
            completion(nil, Self.error("E_REMINDER_QUERY", "La période des rappels ou la limite est invalide."))
            return
        }
        let incompletePredicate = events.predicateForIncompleteReminders(
            withDueDateStarting: interval.start, ending: interval.end, calendars: nil
        )
        events.fetchReminders(matching: incompletePredicate) { [weak self] reminders in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let incompleteRows = Self.reminderRows(reminders ?? [], limit: limit)
                guard includeCompleted, incompleteRows.count < limit else {
                    completion(Self.reminderResponse(incompleteRows, interval: interval), nil)
                    return
                }

                // EventKit does not provide a combined, date-bounded predicate
                // with a row limit. Ask for completed reminders only when there
                // is room after the equally bounded incomplete query.
                let completedPredicate = self.events.predicateForCompletedReminders(
                    withCompletionDateStarting: interval.start, ending: interval.end, calendars: nil
                )
                self.events.fetchReminders(matching: completedPredicate) { [weak self] completed in
                    Task { @MainActor [weak self] in
                        guard self != nil else { return }
                        let remaining = limit - incompleteRows.count
                        let rows = incompleteRows + Self.reminderRows(completed ?? [], limit: remaining)
                        completion(Self.reminderResponse(rows, interval: interval), nil)
                    }
                }
            }
        }
    }

    @objc(createReminder:completion:)
    func createReminder(_ payload: String, completion: Completion) {
        guard Self.remindersAuthorized else {
            completion(nil, Self.permissionError("reminders"))
            return
        }
        do {
            let value = try Self.payloadObject(payload)
            guard let title = Self.shortString(value["title"], maxLength: 512) else {
                throw Self.error("E_REMINDER", "Le titre du rappel est requis.")
            }
            let reminder = EKReminder(eventStore: events)
            reminder.title = title
            if let notes = Self.optionalString(value["notes"], maxLength: 4_000) { reminder.notes = notes }
            if let due = Self.optionalString(value["dueISO"], maxLength: 128) {
                guard let date = Self.parseDate(due) else {
                    throw Self.error("E_REMINDER", "La date d’échéance est invalide.")
                }
                reminder.dueDateComponents = Calendar.current.dateComponents(
                    in: TimeZone.current, from: date
                )
            }
            if let identifier = Self.optionalString(value["calendarId"], maxLength: 256) {
                guard let calendar = events.calendar(withIdentifier: identifier), calendar.allowsContentModifications else {
                    throw Self.error("E_REMINDER", "Cette liste ne permet pas l’ajout de rappels.")
                }
                reminder.calendar = calendar
            } else if let calendar = events.defaultCalendarForNewReminders() {
                reminder.calendar = calendar
            } else {
                throw Self.error("E_REMINDER", "Aucune liste de rappels modifiable n’est disponible.")
            }
            try events.save(reminder, commit: true)
            completion(Self.encode([
                "id": reminder.calendarItemIdentifier,
                "calendarId": reminder.calendar.calendarIdentifier,
                "title": title,
            ]), nil)
        } catch let error as NSError {
            completion(nil, error)
        } catch {
            completion(nil, Self.error("E_REMINDER_WRITE", "Impossible d’ajouter ce rappel.", underlying: error))
        }
    }

    // MARK: One-shot location

    /// Returns one foreground location sample. It never starts background or
    /// continuous tracking and drops the CLLocation immediately after encoding.
    @objc(currentLocation:)
    func currentLocation(_ completion: @escaping Completion) {
        guard locationCompletion == nil, locationPermissionCompletion == nil else {
            completion(nil, Self.error("E_LOCATION_BUSY", "Une demande de position est déjà en cours."))
            return
        }
        let manager = ensureLocationManager()
        locationCompletion = completion
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            requestOneLocation(manager)
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finishLocation(nil, Self.permissionError("location"))
        @unknown default:
            finishLocation(nil, Self.permissionError("location"))
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let state = Self.locationState(manager.authorizationStatus)
        if let completion = locationPermissionCompletion {
            locationPermissionCompletion = nil
            completion(Self.encode(["capability": Capability.location.rawValue, "status": state]), nil)
        }
        guard locationCompletion != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            requestOneLocation(manager)
        case .notDetermined:
            break
        case .denied, .restricted:
            finishLocation(nil, Self.permissionError("location"))
        @unknown default:
            finishLocation(nil, Self.permissionError("location"))
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else {
            finishLocation(nil, Self.error("E_LOCATION", "Aucune position n’a été reçue."))
            return
        }
        finishLocation(Self.encode([
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "horizontalAccuracy": location.horizontalAccuracy,
            "timestampISO": Self.isoString(location.timestamp),
        ]), nil)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finishLocation(nil, Self.error("E_LOCATION", "Impossible d’obtenir la position actuelle.", underlying: error))
    }

    // MARK: Photos and camera

    /// Uses the system photo picker. A full-library permission is not required
    /// for this narrow selection, and only the chosen image is copied to a
    /// temporary app-private file.
    @objc(selectPhoto:)
    func selectPhoto(_ completion: @escaping Completion) {
        beginPhotoSelection(completion, recognizesText: false)
    }

    /// Tool-only variant: Vision reads text locally from the one image chosen
    /// in this system picker. It never requests broad library access.
    func selectPhotoForToolOCR(_ completion: @escaping Completion) {
        beginPhotoSelection(completion, recognizesText: true)
    }

    private func beginPhotoSelection(_ completion: @escaping Completion, recognizesText: Bool) {
        guard !invalidated else {
            completion(nil, Self.error("E_INVALIDATED", "Le module a été fermé."))
            return
        }
        guard attachmentCompletion == nil, !attachmentAuthorizationPending else {
            completion(nil, Self.error("E_ATTACHMENT_BUSY", "Une sélection d’image est déjà ouverte."))
            return
        }
        guard let presenter = Self.presenter(), presenter.presentedViewController == nil else {
            completion(nil, Self.error("E_PRESENTATION", "Impossible d’ouvrir le sélecteur d’images actuellement."))
            return
        }
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        attachmentOCRRequested = recognizesText
        attachmentCompletion = completion
        attachmentGeneration = UUID()
        attachmentPicker = picker
        presenter.present(picker, animated: true)
    }

    /// Requests camera access only when the user explicitly asks to capture an
    /// image. Video recording is intentionally not exposed.
    @objc(capturePhoto:)
    func capturePhoto(_ completion: @escaping Completion) {
        beginCameraCapture(completion, recognizesText: false)
    }

    /// Tool-only camera variant. The broker preflights authorization, so this
    /// path never turns OCR into an implicit permission request.
    func capturePhotoForToolOCR(_ completion: @escaping Completion) {
        beginCameraCapture(completion, recognizesText: true)
    }

    private func beginCameraCapture(_ completion: @escaping Completion, recognizesText: Bool) {
        guard !invalidated else {
            completion(nil, Self.error("E_INVALIDATED", "Le module a été fermé."))
            return
        }
        guard attachmentCompletion == nil, !attachmentAuthorizationPending else {
            completion(nil, Self.error("E_ATTACHMENT_BUSY", "Une capture d’image est déjà ouverte."))
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            presentCamera(completion, recognizesText: recognizesText)
        case .notDetermined:
            // The broker preflights tool permission before it mints a
            // confirmation token. If this changes before execution, fail
            // closed rather than presenting an unexpected system prompt.
            guard !recognizesText else {
                completion(nil, Self.permissionError("camera"))
                return
            }
            let token = UUID()
            attachmentAuthorizationPending = true
            pendingCameraCaptureCompletion = completion
            pendingCameraCaptureOCR = recognizesText
            pendingCameraCaptureToken = token
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    guard self.pendingCameraCaptureToken == token else { return }
                    self.attachmentAuthorizationPending = false
                    guard let pendingCompletion = self.pendingCameraCaptureCompletion else { return }
                    self.pendingCameraCaptureCompletion = nil
                    let pendingOCR = self.pendingCameraCaptureOCR
                    self.pendingCameraCaptureOCR = false
                    self.pendingCameraCaptureToken = nil
                    guard !self.invalidated else {
                        pendingCompletion(nil, Self.error("E_CANCELLED", "La capture d’image a été fermée."))
                        return
                    }
                    if granted { self.presentCamera(pendingCompletion, recognizesText: pendingOCR) }
                    else { pendingCompletion(nil, Self.permissionError("camera")) }
                }
            }
        case .denied, .restricted:
            completion(nil, Self.permissionError("camera"))
        @unknown default:
            completion(nil, Self.permissionError("camera"))
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard let attachmentPicker, picker === attachmentPicker,
              let generation = attachmentGeneration, attachmentCompletion != nil else { return }
        picker.dismiss(animated: true)
        guard let result = results.first else {
            finishAttachment(nil, Self.error("E_CANCELLED", "Sélection d’image annulée."))
            return
        }
        // Keep the provider's concrete image type rather than asking it to
        // create a UIKit object on an arbitrary callback executor. The data
        // completion is Sendable; UIKit decoding remains on the main actor.
        guard let imageType = result.itemProvider.registeredContentTypes
            .first(where: { $0.conforms(to: .image) }) else {
            finishAttachment(nil, Self.error("E_ATTACHMENT", "Cette sélection ne contient pas une image lisible."))
            return
        }
        result.itemProvider.loadDataRepresentation(forTypeIdentifier: imageType.identifier) { [weak self] data, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard !self.invalidated, self.attachmentGeneration == generation,
                      self.attachmentCompletion != nil else { return }
                if let error {
                    self.finishAttachment(nil, Self.error("E_ATTACHMENT", "Impossible de lire cette image.", underlying: error))
                } else if let data {
                    guard data.count <= Self.maximumAttachmentBytes else {
                        self.finishAttachment(nil, Self.error("E_ATTACHMENT_SIZE", "L’image sélectionnée dépasse 10 Mo."))
                        return
                    }
                    guard Self.imageDataIsWithinInputBounds(data) else {
                        self.finishAttachment(nil, Self.error("E_ATTACHMENT_SIZE", "Les dimensions de l’image sélectionnée sont trop grandes."))
                        return
                    }
                    guard let image = UIImage(data: data) else {
                        self.finishAttachment(nil, Self.error("E_ATTACHMENT", "Cette sélection ne contient pas une image lisible."))
                        return
                    }
                    self.storeImage(image, source: "photoLibrary")
                } else {
                    self.finishAttachment(nil, Self.error("E_ATTACHMENT", "Cette sélection ne contient pas une image lisible."))
                }
            }
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        guard let attachmentPicker, picker === attachmentPicker,
              attachmentGeneration != nil, attachmentCompletion != nil else { return }
        picker.dismiss(animated: true)
        finishAttachment(nil, Self.error("E_CANCELLED", "Capture d’image annulée."))
    }

    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        guard let attachmentPicker, picker === attachmentPicker,
              attachmentGeneration != nil, attachmentCompletion != nil else { return }
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage else {
            finishAttachment(nil, Self.error("E_ATTACHMENT", "La caméra n’a pas retourné d’image."))
            return
        }
        storeImage(image, source: "camera")
    }

    // MARK: Local notifications and biometrics

    @objc(scheduleLocalNotification:completion:)
    func scheduleLocalNotification(_ payload: String, completion: @escaping Completion) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let value = try Self.payloadObject(payload)
                guard let title = Self.shortString(value["title"], maxLength: 512),
                      let body = Self.shortString(value["body"], maxLength: 2_000) else {
                    throw Self.error("E_NOTIFICATION", "Le titre et le message de la notification sont requis.")
                }
                let authorization = try await self.notificationAuthorization()
                guard authorization.allowed else {
                    throw Self.permissionError("notifications")
                }

                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                let trigger = try Self.notificationTrigger(value)
                let identifier = Self.shortString(value["id"], maxLength: 128) ?? UUID().uuidString
                try await self.notificationCenter.add(UNNotificationRequest(
                    identifier: identifier, content: content, trigger: trigger
                ))
                completion(Self.encode(["id": identifier, "scheduled": true]), nil)
            } catch let error as NSError {
                completion(nil, error)
            } catch {
                completion(nil, Self.error("E_NOTIFICATION", "Impossible de programmer cette notification.", underlying: error))
            }
        }
    }

    @objc(biometricStatus:)
    func biometricStatus(_ completion: Completion) {
        completion(Self.biometricStatusJSON(), nil)
    }

    @objc(authenticateWithBiometrics:completion:)
    func authenticateWithBiometrics(_ reason: String, completion: @escaping Completion) {
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty, reason.utf8.count <= 512 else {
            completion(nil, Self.error("E_BIOMETRIC_REASON", "Explique brièvement la confirmation demandée."))
            return
        }
        let context = LAContext()
        let token = UUID()
        context.localizedCancelTitle = "Annuler"
        context.localizedFallbackTitle = ""
        var statusError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &statusError) else {
            completion(nil, Self.error("E_BIOMETRIC_UNAVAILABLE", "L’authentification biométrique n’est pas disponible.", underlying: statusError))
            return
        }
        activeBiometricContext = context
        activeBiometricToken = token
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
            Task { @MainActor [weak self] in
                guard let self, self.activeBiometricToken == token else { return }
                self.activeBiometricContext = nil
                self.activeBiometricToken = nil
                if success {
                    completion(Self.encode(["authenticated": true]), nil)
                } else {
                    completion(nil, Self.error("E_BIOMETRIC_AUTH", "La confirmation biométrique a été annulée ou refusée.", underlying: error))
                }
            }
        }
    }

    // MARK: Explicit platform boundaries

    @objc(nativeCapabilityBoundary:completion:)
    func nativeCapabilityBoundary(_ feature: String, completion: Completion) {
        let boundary = Self.boundaries()[feature] as? [String: Any] ?? [
            "supported": false,
            "reason": "Cette fonction n’est pas exposée par la passerelle native.",
        ]
        completion(Self.encode(["feature": feature, "boundary": boundary]), nil)
    }

    /// Stops only an interaction owned by the tool broker. A late picker,
    /// Vision, or Face ID callback finds its token/completion cleared and is
    /// ignored; it cannot resume a cancelled tool request a second time.
    func cancelToolInteraction() {
        attachmentOCRRequestGate?.cancel()
        attachmentOCRRequestGate = nil
        attachmentOCRToken = nil
        attachmentOCRTask?.cancel()
        attachmentOCRTask = nil
        attachmentOCRRequested = false
        attachmentGeneration = nil
        attachmentPicker?.dismiss(animated: false)
        attachmentPicker = nil
        attachmentAuthorizationPending = false
        pendingCameraCaptureOCR = false
        pendingCameraCaptureToken = nil
        if let completion = pendingCameraCaptureCompletion {
            pendingCameraCaptureCompletion = nil
            completion(nil, Self.error("E_CANCELLED", "La capture d’image a été annulée."))
        } else if attachmentCompletion != nil {
            finishAttachment(nil, Self.error("E_CANCELLED", "La sélection d’image a été annulée."))
        }
        activeBiometricToken = nil
        activeBiometricContext?.invalidate()
        activeBiometricContext = nil
    }

    @objc func invalidate() {
        invalidated = true
        locationTimeout?.cancel()
        locationTimeout = nil
        locationManager?.stopUpdatingLocation()
        if let completion = locationCompletion {
            locationCompletion = nil
            completion(nil, Self.error("E_CANCELLED", "La demande de position a été fermée."))
        }
        if let completion = locationPermissionCompletion {
            locationPermissionCompletion = nil
            completion(nil, Self.error("E_CANCELLED", "La demande d’autorisation a été fermée."))
        }
        cancelToolInteraction()
        for url in generatedAttachmentURLs {
            try? FileManager.default.removeItem(at: url)
        }
        generatedAttachmentURLs.removeAll()
    }

    // MARK: Permission implementation

    private func requestContacts(_ completion: @escaping Completion) {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited:
            completion(Self.permissionJSON(.contacts), nil)
        case .notDetermined:
            contacts.requestAccess(for: .contacts) { [weak self] _, error in
                Task { @MainActor [weak self] in
                    guard self != nil else { return }
                    if let error { completion(nil, Self.error("E_CONTACTS_PERMISSION", "Impossible de demander l’accès aux contacts.", underlying: error)) }
                    else { completion(Self.permissionJSON(.contacts), nil) }
                }
            }
        case .denied, .restricted:
            completion(Self.permissionJSON(.contacts), nil)
        @unknown default:
            completion(Self.permissionJSON(.contacts), nil)
        }
    }

    private func requestCalendar(_ completion: @escaping Completion) {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess:
            completion(Self.permissionJSON(.calendar), nil)
        case .notDetermined, .writeOnly:
            events.requestFullAccessToEvents { [weak self] _, error in
                Task { @MainActor [weak self] in
                    guard self != nil else { return }
                    if let error { completion(nil, Self.error("E_CALENDAR_PERMISSION", "Impossible de demander l’accès aux calendriers.", underlying: error)) }
                    else { completion(Self.permissionJSON(.calendar), nil) }
                }
            }
        case .denied, .restricted:
            completion(Self.permissionJSON(.calendar), nil)
        @unknown default:
            completion(Self.permissionJSON(.calendar), nil)
        }
    }

    private func requestReminders(_ completion: @escaping Completion) {
        switch EKEventStore.authorizationStatus(for: .reminder) {
        case .fullAccess:
            completion(Self.permissionJSON(.reminders), nil)
        case .notDetermined, .writeOnly:
            events.requestFullAccessToReminders { [weak self] _, error in
                Task { @MainActor [weak self] in
                    guard self != nil else { return }
                    if let error { completion(nil, Self.error("E_REMINDERS_PERMISSION", "Impossible de demander l’accès aux rappels.", underlying: error)) }
                    else { completion(Self.permissionJSON(.reminders), nil) }
                }
            }
        case .denied, .restricted:
            completion(Self.permissionJSON(.reminders), nil)
        @unknown default:
            completion(Self.permissionJSON(.reminders), nil)
        }
    }

    private func requestLocationPermission(_ completion: @escaping Completion) {
        guard locationPermissionCompletion == nil, locationCompletion == nil else {
            completion(nil, Self.error("E_LOCATION_BUSY", "Une demande de position est déjà en cours."))
            return
        }
        let manager = ensureLocationManager()
        switch manager.authorizationStatus {
        case .notDetermined:
            locationPermissionCompletion = completion
            manager.requestWhenInUseAuthorization()
        default:
            completion(Self.permissionJSON(.location), nil)
        }
    }

    private func requestCamera(_ completion: @escaping Completion) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard self != nil else { return }
                    completion(Self.permissionJSON(.camera), nil)
                }
            }
        default:
            completion(Self.permissionJSON(.camera), nil)
        }
    }

    private func requestNotifications(_ completion: @escaping Completion) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let authorization = try await self.notificationAuthorization(requestIfNeeded: true)
                completion(Self.encode([
                    "capability": Capability.notifications.rawValue,
                    "status": Self.notificationState(authorization.status),
                ]), nil)
            } catch {
                completion(nil, Self.error("E_NOTIFICATION_PERMISSION", "Impossible de demander l’autorisation des notifications.", underlying: error))
            }
        }
    }

    // MARK: Helpers

    private func ensureLocationManager() -> CLLocationManager {
        if let locationManager { return locationManager }
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        locationManager = manager
        return manager
    }

    private func requestOneLocation(_ manager: CLLocationManager) {
        guard locationTimeout == nil else { return }
        manager.requestLocation()
        locationTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            self?.finishLocation(nil, Self.error("E_LOCATION_TIMEOUT", "La position actuelle n’a pas été reçue à temps."))
        }
    }

    private func finishLocation(_ result: String?, _ error: NSError?) {
        locationTimeout?.cancel()
        locationTimeout = nil
        locationManager?.stopUpdatingLocation()
        let completion = locationCompletion
        locationCompletion = nil
        completion?(result, error)
    }

    private func presentCamera(_ completion: @escaping Completion, recognizesText: Bool) {
        guard !invalidated else {
            completion(nil, Self.error("E_CANCELLED", "La capture d’image a été fermée."))
            return
        }
        guard let presenter = Self.presenter(), presenter.presentedViewController == nil else {
            completion(nil, Self.error("E_PRESENTATION", "Impossible d’ouvrir la caméra actuellement."))
            return
        }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            completion(nil, Self.error("E_CAMERA_UNAVAILABLE", "La caméra n’est pas disponible sur cet appareil."))
            return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.cameraCaptureMode = .photo
        picker.delegate = self
        attachmentOCRRequested = recognizesText
        attachmentCompletion = completion
        attachmentGeneration = UUID()
        attachmentPicker = picker
        presenter.present(picker, animated: true)
    }

    private func storeImage(_ image: UIImage, source: String) {
        guard Self.imageIsWithinInputBounds(image),
              let attachment = Self.downscaledImage(image),
              let data = attachment.jpegData(compressionQuality: 0.85) else {
            finishAttachment(nil, Self.error("E_ATTACHMENT", "Impossible de préparer cette image."))
            return
        }
        guard data.count <= Self.maximumAttachmentBytes else {
            finishAttachment(nil, Self.error("E_ATTACHMENT_SIZE", "L’image sélectionnée dépasse 10 Mo après compression."))
            return
        }
        if attachmentOCRRequested {
            recognizeToolText(data: data, orientation: attachment.imageOrientation, source: source)
            return
        }
        do {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent(Self.temporaryAttachmentDirectory, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("jpg")
            try data.write(to: url, options: .atomic)
            generatedAttachmentURLs.insert(url)
            finishAttachment(Self.encode([
                "uri": url.absoluteString,
                "mediaType": "image/jpeg",
                "byteCount": data.count,
                "source": source,
            ]), nil)
        } catch {
            finishAttachment(nil, Self.error("E_ATTACHMENT", "Impossible d’enregistrer l’image sélectionnée.", underlying: error))
        }
    }

    /// Vision is run from bounded JPEG data, not from a UIImage or a file URL,
    /// so UIKit never crosses the task boundary and the selected image is not
    /// retained after this one recognition completes.
    private func recognizeToolText(data: Data, orientation: UIImage.Orientation, source: String) {
        let token = UUID()
        let requestGate = AssistVisionRequestGate()
        attachmentOCRToken = token
        attachmentOCRRequestGate = requestGate
        let orientationRaw = Self.cgImageOrientation(for: orientation).rawValue
        attachmentOCRTask = Task { @concurrent [weak self, data, source, token, orientationRaw, requestGate] in
            let summary = Self.recognizeTextLocally(
                data: data, orientationRaw: orientationRaw, requestGate: requestGate
            )
            guard !Task.isCancelled else { return }
            await MainActor.run { [weak self] in
                guard let self, !self.invalidated, self.attachmentOCRToken == token,
                      self.attachmentCompletion != nil else { return }
                self.attachmentOCRTask = nil
                self.attachmentOCRToken = nil
                self.attachmentOCRRequestGate = nil
                var response: [String: Any] = [
                    "source": source,
                    "byteCount": data.count,
                    "visionAvailable": true,
                    "ocrStatus": summary.status,
                    "ocrLines": summary.lines,
                    "ocrTruncated": summary.truncated,
                    // OCR is untrusted extracted text, never an authority or
                    // an instruction. The broker labels it the same way.
                    "ocrReliable": false,
                ]
                if let text = summary.text { response["ocrText"] = text }
                self.finishAttachment(Self.encode(response), nil)
            }
        }
    }

    nonisolated private static func recognizeTextLocally(
        data: Data, orientationRaw: UInt32, requestGate: AssistVisionRequestGate
    ) -> AssistDeviceOCRSummary {
        do {
            guard let orientation = CGImagePropertyOrientation(rawValue: orientationRaw) else {
                return AssistDeviceOCRSummary(status: "failed", text: nil, lines: 0, truncated: false)
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            let preferredLanguages = ["fr-CA", "fr-FR", "en-CA"]
            if let supported = try? request.supportedRecognitionLanguages() {
                let selected = preferredLanguages.filter(supported.contains)
                if selected.isEmpty {
                    request.automaticallyDetectsLanguage = true
                } else {
                    request.recognitionLanguages = selected
                }
            } else {
                request.automaticallyDetectsLanguage = true
            }

            let handler = VNImageRequestHandler(data: data, orientation: orientation, options: [:])
            guard requestGate.install(request) else {
                return AssistDeviceOCRSummary(status: "failed", text: nil, lines: 0, truncated: false)
            }
            defer { requestGate.clear() }
            guard !Task.isCancelled else {
                request.cancel()
                return AssistDeviceOCRSummary(status: "failed", text: nil, lines: 0, truncated: false)
            }
            try handler.perform([request])
            var lines: [String] = []
            var bytes = 0
            var truncated = false
            for observation in request.results ?? [] {
                guard !Task.isCancelled else {
                    return AssistDeviceOCRSummary(status: "failed", text: nil, lines: 0, truncated: false)
                }
                guard let candidate = observation.topCandidates(1).first?.string else { continue }
                let line = candidate.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                guard !line.isEmpty else { continue }
                if lines.count >= maximumOCRLines {
                    truncated = true
                    break
                }
                let separatorBytes = lines.isEmpty ? 0 : 1
                let available = maximumOCRTextBytes - bytes - separatorBytes
                guard available > 0 else {
                    truncated = true
                    break
                }
                if line.utf8.count > available {
                    let prefix = prefixUTF8(line, maximumBytes: available)
                    guard !prefix.isEmpty else {
                        return AssistDeviceOCRSummary(status: "failed", text: nil, lines: 0, truncated: false)
                    }
                    lines.append(prefix)
                    truncated = true
                    break
                }
                lines.append(line)
                bytes += separatorBytes + line.utf8.count
            }
            guard !lines.isEmpty else {
                return AssistDeviceOCRSummary(status: "no_text", text: nil, lines: 0, truncated: false)
            }
            let text = lines.joined(separator: "\n")
            // Tool delimiters and control characters must not turn OCR output
            // into a protocol instruction; surface a bounded safe failure.
            guard (try? AssistToolContent.validate(text)) != nil else {
                return AssistDeviceOCRSummary(status: "failed", text: nil, lines: 0, truncated: false)
            }
            return AssistDeviceOCRSummary(status: "text", text: text, lines: lines.count, truncated: truncated)
        } catch {
            return AssistDeviceOCRSummary(status: "failed", text: nil, lines: 0, truncated: false)
        }
    }

    nonisolated private static func prefixUTF8(_ text: String, maximumBytes: Int) -> String {
        var result = ""
        var bytes = 0
        for character in text {
            let value = String(character)
            let next = value.utf8.count
            guard bytes + next <= maximumBytes else { break }
            result.append(character)
            bytes += next
        }
        return result
    }

    private static func cgImageOrientation(for orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .up: .up
        case .upMirrored: .upMirrored
        case .down: .down
        case .downMirrored: .downMirrored
        case .left: .left
        case .leftMirrored: .leftMirrored
        case .right: .right
        case .rightMirrored: .rightMirrored
        @unknown default: .up
        }
    }

    private func finishAttachment(_ result: String?, _ error: NSError?) {
        attachmentOCRRequestGate?.cancel()
        attachmentOCRRequestGate = nil
        attachmentOCRTask?.cancel()
        attachmentOCRTask = nil
        attachmentOCRToken = nil
        attachmentOCRRequested = false
        attachmentGeneration = nil
        let completion = attachmentCompletion
        attachmentCompletion = nil
        attachmentPicker = nil
        completion?(result, error)
    }

    private func notificationAuthorization(requestIfNeeded: Bool = false) async throws -> (allowed: Bool, status: UNAuthorizationStatus) {
        let settings = await notificationCenter.notificationSettings()
        if settings.authorizationStatus == .notDetermined, requestIfNeeded {
            let granted = try await notificationCenter.requestAuthorization(options: [.alert, .badge, .sound])
            let updated = await notificationCenter.notificationSettings()
            return (granted || Self.notificationAllowed(updated.authorizationStatus), updated.authorizationStatus)
        }
        return (Self.notificationAllowed(settings.authorizationStatus), settings.authorizationStatus)
    }

    private enum Capability: String, CaseIterable {
        case contacts, calendar, reminders, location, camera, notifications, biometrics
    }

    private static var contactsAuthorized: Bool {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited: return true
        case .notDetermined, .denied, .restricted: return false
        @unknown default: return false
        }
    }

    private static var calendarAuthorized: Bool {
        EKEventStore.authorizationStatus(for: .event) == .fullAccess
    }

    private static var remindersAuthorized: Bool {
        EKEventStore.authorizationStatus(for: .reminder) == .fullAccess
    }

    private static func capabilityStates() -> [String: Any] {
        [
            Capability.contacts.rawValue: contactsState(CNContactStore.authorizationStatus(for: .contacts)),
            Capability.calendar.rawValue: eventState(EKEventStore.authorizationStatus(for: .event)),
            Capability.reminders.rawValue: eventState(EKEventStore.authorizationStatus(for: .reminder)),
            Capability.location.rawValue: locationState(CLLocationManager().authorizationStatus),
            Capability.camera.rawValue: cameraState(AVCaptureDevice.authorizationStatus(for: .video)),
            Capability.notifications.rawValue: "checkRequired",
            Capability.biometrics.rawValue: biometricStatus(),
        ]
    }

    private static func permissionJSON(_ capability: Capability) -> String {
        let states = capabilityStates()
        return encode(["capability": capability.rawValue, "status": states[capability.rawValue] ?? "unavailable"])
    }

    private static func contactsState(_ status: CNAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .limited: return "limited"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unavailable"
        }
    }

    private static func eventState(_ status: EKAuthorizationStatus) -> String {
        switch status {
        case .fullAccess: return "authorized"
        case .writeOnly: return "writeOnly"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unavailable"
        }
    }

    private static func locationState(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .authorizedAlways: return "authorizedAlways"
        case .authorizedWhenInUse: return "authorizedWhenInUse"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unavailable"
        }
    }

    private static func cameraState(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "unavailable"
        }
    }

    private static func notificationAllowed(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: return true
        case .denied, .notDetermined: return false
        @unknown default: return false
        }
    }

    private static func notificationState(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        @unknown default: return "unavailable"
        }
    }

    private static func biometricStatus() -> [String: Any] {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let type: String
        switch context.biometryType {
        case .faceID: type = "faceId"
        case .touchID: type = "touchId"
        case .opticID: type = "opticId"
        case .none: type = "none"
        @unknown default: type = "unknown"
        }
        return ["available": available, "type": type, "errorCode": error?.code ?? 0]
    }

    private static func biometricStatusJSON() -> String { encode(biometricStatus()) }

    private static func boundaries() -> [String: Any] {
        [
            "telephony": [
                "supported": false,
                "reason": "iOS ne permet pas à une app d’accéder à l’historique d’appels, de composer un appel ou de le contrôler sans interaction explicite dans l’app Téléphone.",
            ],
            "sms": [
                "supported": false,
                "reason": "iOS ne permet pas de lire, envoyer ou surveiller les SMS. Un écran système peut seulement préremplir un message après une action explicite, ce qui n’est pas inclus ici.",
            ],
            "systemSettings": [
                "supported": false,
                "reason": "Assist ne peut pas lire ni modifier les réglages système. iOS peut seulement ouvrir la page Réglages de l’app après une action utilisateur.",
            ],
            "backgroundLocation": [
                "supported": false,
                "reason": "La passerelle ne demande que la position au premier plan et ne lance aucun suivi en arrière-plan.",
            ],
        ]
    }

    private static func notificationTrigger(_ value: [String: Any]) throws -> UNNotificationTrigger {
        if let seconds = value["timeIntervalSeconds"] as? NSNumber,
           CFGetTypeID(seconds) != CFBooleanGetTypeID() {
            let interval = seconds.doubleValue
            guard interval >= 1, interval <= 7 * 24 * 60 * 60 else {
                throw error("E_NOTIFICATION", "Le délai doit être compris entre 1 seconde et 7 jours.")
            }
            return UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        }
        if let dateString = optionalString(value["dateISO"], maxLength: 128), let date = parseDate(dateString) {
            guard date.timeIntervalSinceNow >= 1 else {
                throw error("E_NOTIFICATION", "La date de notification doit être dans le futur.")
            }
            let components = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: date
            )
            return UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        }
        throw error("E_NOTIFICATION", "Indique un délai ou une date de notification valide.")
    }

    private static func payloadObject(_ payload: String) throws -> [String: Any] {
        guard payload.utf8.count <= maxPayloadBytes,
              let data = payload.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data),
              let object = value as? [String: Any] else {
            throw error("E_PAYLOAD", "La demande native est invalide.")
        }
        return object
    }

    private static func dateInterval(startISO: String, endISO: String) -> (start: Date, end: Date)? {
        guard startISO.utf8.count <= 128, endISO.utf8.count <= 128,
              let start = parseDate(startISO), let end = parseDate(endISO), start < end,
              end.timeIntervalSince(start) <= 366 * 24 * 60 * 60 else { return nil }
        return (start, end)
    }

    /// EventKit fetchReminders has no row-limit API. Require a narrow, explicit
    /// time interval before asking it for results so the bridge cannot fetch a
    /// user's entire reminder store and then discard most of it locally.
    private static func reminderDateInterval(startISO: String, endISO: String) -> (start: Date, end: Date)? {
        guard startISO.utf8.count <= 128, endISO.utf8.count <= 128,
              let start = parseDate(startISO), let end = parseDate(endISO), start < end,
              end.timeIntervalSince(start) <= 31 * 24 * 60 * 60 else { return nil }
        return (start, end)
    }

    private static func reminderRows(_ reminders: [EKReminder], limit: Int) -> [[String: Any]] {
        reminders.prefix(limit).map { reminder in
            var row: [String: Any] = [
                "id": reminder.calendarItemIdentifier,
                "calendarId": reminder.calendar.calendarIdentifier,
                "calendarTitle": reminder.calendar.title,
                "title": reminder.title ?? "",
                "completed": reminder.isCompleted,
            ]
            if let dueDate = reminder.dueDateComponents,
               let due = Calendar.current.date(from: dueDate) {
                row["dueISO"] = isoString(due)
            }
            return row
        }
    }

    private static func reminderResponse(_ rows: [[String: Any]], interval: (start: Date, end: Date)) -> String {
        encode([
            "reminders": rows,
            "startISO": isoString(interval.start),
            "endISO": isoString(interval.end),
        ])
    }

    private static func date(_ value: Any?) -> Date? {
        guard let raw = value as? String else { return nil }
        return parseDate(raw)
    }

    private static func parseDate(_ raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: raw)
    }

    private static func isoString(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private static func resultLimit(_ raw: String) -> Int? {
        guard let value = Int(raw), (1...maxResults).contains(value) else { return nil }
        return value
    }

    private static func shortString(_ value: Any?, maxLength: Int) -> String? {
        guard let raw = value as? String else { return nil }
        let string = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !string.isEmpty && string.utf8.count <= maxLength ? string : nil
    }

    private static func optionalString(_ value: Any?, maxLength: Int) -> String? {
        guard let raw = value as? String else { return nil }
        return raw.utf8.count <= maxLength ? raw : nil
    }

    private static func imageDataIsWithinInputBounds(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
            return false
        }
        return imageDimensionsAreWithinBounds(width.intValue, height.intValue)
    }

    private static func imageIsWithinInputBounds(_ image: UIImage) -> Bool {
        if let cgImage = image.cgImage {
            return imageDimensionsAreWithinBounds(cgImage.width, cgImage.height)
        }
        let width = (image.size.width * image.scale).rounded()
        let height = (image.size.height * image.scale).rounded()
        guard width.isFinite, height.isFinite,
              width <= CGFloat(Int.max), height <= CGFloat(Int.max) else { return false }
        return imageDimensionsAreWithinBounds(Int(width), Int(height))
    }

    private static func imageDimensionsAreWithinBounds(_ width: Int, _ height: Int) -> Bool {
        guard width > 0, height > 0,
              width <= maximumInputImageDimension, height <= maximumInputImageDimension else { return false }
        return width <= maximumInputImagePixels / height
    }

    private static func downscaledImage(_ image: UIImage) -> UIImage? {
        let pointSize = image.size
        let imageScale = image.scale
        guard pointSize.width > 0, pointSize.height > 0, imageScale > 0,
              pointSize.width.isFinite, pointSize.height.isFinite, imageScale.isFinite else { return nil }
        let pixelSize = CGSize(width: pointSize.width * imageScale, height: pointSize.height * imageScale)
        let largest = max(pixelSize.width, pixelSize.height)
        let scale = min(1, maximumAttachmentDimension / largest)
        let target = CGSize(width: (pixelSize.width * scale).rounded(), height: (pixelSize.height * scale).rounded())
        guard target.width > 0, target.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }

    private static func encode(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"error\":\"encoding\"}"
        }
        return json
    }

    private static func permissionError(_ capability: String) -> NSError {
        error("E_PERMISSION", "Autorise « \(capability) » dans Réglages avant d’utiliser cette fonction.")
    }

    private static func error(_ code: String, _ message: String, underlying: Error? = nil) -> NSError {
        var userInfo: [String: Any] = [NSLocalizedDescriptionKey: message, "code": code]
        if let underlying { userInfo[NSUnderlyingErrorKey] = underlying }
        return NSError(domain: "Assist.DeviceCapabilities", code: 1, userInfo: userInfo)
    }

    private static func presenter() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        guard var presenter = scene?.windows.first(where: \.isKeyWindow)?.rootViewController else { return nil }
        while let presented = presenter.presentedViewController { presenter = presented }
        return presenter
    }
}
