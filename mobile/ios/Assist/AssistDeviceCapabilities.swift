import AVFoundation
import Contacts
import CoreLocation
import EventKit
import Foundation
import LocalAuthentication
import Photos
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import UserNotifications

/// A user-invoked iOS capability gateway. It deliberately does not persist or
/// transmit personal data: callers receive only the result requested for the
/// current action, and iOS owns every consent prompt.
@MainActor
@objc(AssistDeviceCapabilities)
final class AssistDeviceCapabilities: NSObject, CLLocationManagerDelegate,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate, PHPickerViewControllerDelegate {

    typealias Completion = (String?, NSError?) -> Void

    private let contacts = CNContactStore()
    private let events = EKEventStore()
    private let notificationCenter = UNUserNotificationCenter.current()
    private var locationManager: CLLocationManager?
    private var locationPermissionCompletion: Completion?
    private var locationCompletion: Completion?
    private var locationTimeout: Task<Void, Never>?
    private var attachmentCompletion: Completion?
    private var attachmentAuthorizationPending = false
    private weak var attachmentPicker: UIViewController?

    private static let maxResults = 50
    private static let maxPayloadBytes = 16 * 1024
    private static let temporaryAttachmentDirectory = "AssistAttachments"
    private static let maximumAttachmentDimension: CGFloat = 2_048
    private static let maximumAttachmentBytes = 10 * 1024 * 1024

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
        case .photoLibrary:
            requestPhotoLibrary(completion)
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
            let matches = try contacts.unifiedContacts(
                matching: CNContact.predicateForContacts(matchingName: query),
                keysToFetch: keys
            )
            let rows = matches.prefix(limit).map { contact in
                [
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
                ] as [String: Any]
            }
            completion(Self.encode(["contacts": rows, "query": query]), nil)
        } catch {
            completion(nil, Self.error("E_CONTACTS_READ", "Impossible de lire ces contacts.", underlying: error))
        }
    }

    // MARK: Calendar and reminders

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
        let rows = events.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }
            .prefix(limit)
            .map { event in
                [
                    "id": event.eventIdentifier ?? event.calendarItemIdentifier,
                    "calendarId": event.calendar.calendarIdentifier,
                    "calendarTitle": event.calendar.title,
                    "title": event.title ?? "",
                    "startISO": Self.isoString(event.startDate),
                    "endISO": Self.isoString(event.endDate),
                    "allDay": event.isAllDay,
                ] as [String: Any]
            }
        completion(Self.encode(["events": Array(rows)]), nil)
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

    @objc(listReminders:limit:completion:)
    func listReminders(_ includeCompleted: Bool, limit: String, completion: @escaping Completion) {
        guard Self.remindersAuthorized else {
            completion(nil, Self.permissionError("reminders"))
            return
        }
        guard let limit = Self.resultLimit(limit) else {
            completion(nil, Self.error("E_RESULT_LIMIT", "La limite doit être comprise entre 1 et 50."))
            return
        }
        let predicate = includeCompleted
            ? events.predicateForReminders(in: nil)
            : events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        events.fetchReminders(matching: predicate) { [weak self] reminders in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let rows = (reminders ?? []).prefix(limit).map { reminder in
                    var row: [String: Any] = [
                        "id": reminder.calendarItemIdentifier,
                        "calendarId": reminder.calendar.calendarIdentifier,
                        "calendarTitle": reminder.calendar.title,
                        "title": reminder.title ?? "",
                        "completed": reminder.isCompleted,
                    ]
                    if let dueDate = reminder.dueDateComponents,
                       let due = Calendar.current.date(from: dueDate) {
                        row["dueISO"] = Self.isoString(due)
                    }
                    return row
                }
                completion(Self.encode(["reminders": rows]), nil)
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
        attachmentCompletion = completion
        attachmentPicker = picker
        presenter.present(picker, animated: true)
    }

    /// Requests camera access only when the user explicitly asks to capture an
    /// image. Video recording is intentionally not exposed.
    @objc(capturePhoto:)
    func capturePhoto(_ completion: @escaping Completion) {
        guard attachmentCompletion == nil, !attachmentAuthorizationPending else {
            completion(nil, Self.error("E_ATTACHMENT_BUSY", "Une capture d’image est déjà ouverte."))
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            presentCamera(completion)
        case .notDetermined:
            attachmentAuthorizationPending = true
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.attachmentAuthorizationPending = false
                    if granted { self.presentCamera(completion) }
                    else { completion(nil, Self.permissionError("camera")) }
                }
            }
        case .denied, .restricted:
            completion(nil, Self.permissionError("camera"))
        @unknown default:
            completion(nil, Self.permissionError("camera"))
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard let attachmentPicker, picker === attachmentPicker else { return }
        picker.dismiss(animated: true)
        guard let result = results.first else {
            finishAttachment(nil, Self.error("E_CANCELLED", "Sélection d’image annulée."))
            return
        }
        guard result.itemProvider.canLoadObject(ofClass: UIImage.self) else {
            finishAttachment(nil, Self.error("E_ATTACHMENT", "Cette sélection ne contient pas une image lisible."))
            return
        }
        result.itemProvider.loadObject(ofClass: UIImage.self) { [weak self] object, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let error {
                    self.finishAttachment(nil, Self.error("E_ATTACHMENT", "Impossible de lire cette image.", underlying: error))
                } else if let image = object as? UIImage {
                    self.storeImage(image, source: "photoLibrary")
                } else {
                    self.finishAttachment(nil, Self.error("E_ATTACHMENT", "Cette sélection ne contient pas une image lisible."))
                }
            }
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        guard let attachmentPicker, picker === attachmentPicker else { return }
        picker.dismiss(animated: true)
        finishAttachment(nil, Self.error("E_CANCELLED", "Capture d’image annulée."))
    }

    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        guard let attachmentPicker, picker === attachmentPicker else { return }
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
                let authorization = await self.notificationAuthorization()
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
        context.localizedCancelTitle = "Annuler"
        context.localizedFallbackTitle = ""
        var statusError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &statusError) else {
            completion(nil, Self.error("E_BIOMETRIC_UNAVAILABLE", "L’authentification biométrique n’est pas disponible.", underlying: statusError))
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
            Task { @MainActor in
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

    @objc func invalidate() {
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
        attachmentPicker?.dismiss(animated: false)
        attachmentAuthorizationPending = false
        if let completion = attachmentCompletion {
            attachmentCompletion = nil
            completion(nil, Self.error("E_CANCELLED", "La sélection d’image a été fermée."))
        }
        attachmentPicker = nil
    }

    // MARK: Permission implementation

    private func requestContacts(_ completion: @escaping Completion) {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized:
            completion(Self.permissionJSON(.contacts), nil)
        case .notDetermined:
            contacts.requestAccess(for: .contacts) { [weak self] _, error in
                Task { @MainActor [weak self] in
                    guard let self else { return }
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
                    guard let self else { return }
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
                    guard let self else { return }
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
            AVCaptureDevice.requestAccess(for: .video) { [weak self] _, error in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if let error { completion(nil, Self.error("E_CAMERA_PERMISSION", "Impossible de demander l’accès à la caméra.", underlying: error)) }
                    else { completion(Self.permissionJSON(.camera), nil) }
                }
            }
        default:
            completion(Self.permissionJSON(.camera), nil)
        }
    }

    private func requestPhotoLibrary(_ completion: @escaping Completion) {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    completion(Self.permissionJSON(.photoLibrary), nil)
                }
            }
        default:
            completion(Self.permissionJSON(.photoLibrary), nil)
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

    private func presentCamera(_ completion: @escaping Completion) {
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
        attachmentCompletion = completion
        attachmentPicker = picker
        presenter.present(picker, animated: true)
    }

    private func storeImage(_ image: UIImage, source: String) {
        guard let attachment = Self.downscaledImage(image),
              let data = attachment.jpegData(compressionQuality: 0.85) else {
            finishAttachment(nil, Self.error("E_ATTACHMENT", "Impossible de préparer cette image."))
            return
        }
        guard data.count <= Self.maximumAttachmentBytes else {
            finishAttachment(nil, Self.error("E_ATTACHMENT_SIZE", "L’image sélectionnée dépasse 10 Mo après compression."))
            return
        }
        do {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent(Self.temporaryAttachmentDirectory, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension("jpg")
            try data.write(to: url, options: .atomic)
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

    private func finishAttachment(_ result: String?, _ error: NSError?) {
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
        case contacts, calendar, reminders, location, camera, photoLibrary, notifications, biometrics
    }

    private static var contactsAuthorized: Bool {
        CNContactStore.authorizationStatus(for: .contacts) == .authorized
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
            Capability.location.rawValue: locationState(CLLocationManager.authorizationStatus()),
            Capability.camera.rawValue: cameraState(AVCaptureDevice.authorizationStatus(for: .video)),
            Capability.photoLibrary.rawValue: photoState(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
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

    private static func photoState(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .limited: return "limited"
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

    private static func downscaledImage(_ image: UIImage) -> UIImage? {
        let size = image.size
        guard size.width > 0, size.height > 0,
              size.width.isFinite, size.height.isFinite else { return nil }
        let largest = max(size.width, size.height)
        let scale = min(1, maximumAttachmentDimension / largest)
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        guard target.width > 0, target.height > 0 else { return nil }
        let renderer = UIGraphicsImageRenderer(size: target)
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
