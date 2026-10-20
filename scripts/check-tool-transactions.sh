#!/usr/bin/env bash
# Pure broker/policy/journal harness. Production dispatch and all closed leaf
# policies execute; scripted framework-owner doubles replace AlarmKit,
# Translation, UIKit and the legacy device gateway. No device operation runs.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v swiftc >/dev/null 2>&1; then
  echo "ERROR: tool transaction contracts require Swift 6." >&2
  exit 69
fi
ASSIST_TOOL_TRANSACTION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-tool-transactions.XXXXXX")"
trap 'rm -rf "$ASSIST_TOOL_TRANSACTION_DIR"' EXIT
cat > "$ASSIST_TOOL_TRANSACTION_DIR/GatewayStub.swift" <<'EOF'
import Foundation

struct AssistDeviceCalendarDestination: Sendable {
    let identifier: String
    let title: String
}

final class AssistAgentAdmission: Sendable {
    func check() throws {}
}

@MainActor
final class AssistDeviceCapabilities {
    typealias Completion = @MainActor @Sendable (String?, NSError?) -> Void
    var permission = "authorized"
    var contactsWasInvoked = false
    var interactionCancelCount = 0
    var calls: [String] = []
    var payloads: [String: Any] = [:]
    var partialCalendarReceipt = false
    var partialReminderReceipt = false
    var locationReceiptOverride: String?
    var capabilityReceiptOverride: String?
    var imageErrorCode: String?
    var imageReceiptOverride: String?
    var notificationBooleanAsNumber = false
    var biometricReceiptOverride: String?
    var deferPermission = false
    private var permissionStarted = false
    private var permissionStartWaiter: CheckedContinuation<Void, Never>?
    private var permissionReleaseWaiter: CheckedContinuation<Void, Never>?
    private var pendingPhotoCompletion: Completion?
    func cancelToolInteraction() { interactionCancelCount += 1 }
    func toolPermissionStatus(for capability: String) async -> String {
        if deferPermission {
            permissionStarted = true
            permissionStartWaiter?.resume()
            permissionStartWaiter = nil
            await withCheckedContinuation { permissionReleaseWaiter = $0 }
        }
        if capability == "location", permission == "authorized" { return "authorizedWhenInUse" }
        if capability == "biometrics", permission == "authorized" { return "available" }
        return permission
    }
    func waitForPermissionCheck() async {
        if permissionStarted { return }
        await withCheckedContinuation { permissionStartWaiter = $0 }
    }
    func releasePermissionCheck() { permissionReleaseWaiter?.resume(); permissionReleaseWaiter = nil }
    func captureCalendarDestination(calendarIdentifier: String?, forReminders: Bool) throws -> AssistDeviceCalendarDestination {
        .init(identifier: "fixture", title: "Fixture")
    }
    func searchContacts(_ query: String, limit: String, completion: Completion) {
        calls.append("contacts"); contactsWasInvoked = true; completion("{\"contacts\":[]}", nil)
    }
    func listCalendarEvents(_ calendarIdentifier: String, startISO: String, endISO: String, limit: String, completion: Completion) {
        calls.append("calendar_list"); completion("{\"events\":[]}", nil)
    }
    func createCalendarEvent(_ payload: String, completion: Completion) {
        calls.append("calendar_create"); payloads["calendar_create"] = payload
        if partialCalendarReceipt { completion("{\"calendarId\":\"fixture\"}", nil) }
        else { completion("{\"id\":\"event-fixture\",\"calendarId\":\"fixture\"}", nil) }
    }
    func listReminders(_ includeCompleted: Bool, startISO: String, endISO: String, limit: String, completion: Completion) {
        calls.append("reminders_list"); completion("{\"reminders\":[]}", nil)
    }
    func createReminder(_ payload: String, completion: Completion) {
        calls.append("reminder_create"); payloads["reminder_create"] = payload
        if partialReminderReceipt { completion("{\"calendarId\":\"fixture\"}", nil) }
        else { completion("{\"id\":\"reminder-fixture\",\"calendarId\":\"fixture\"}", nil) }
    }
    func currentLocation(_ completion: Completion) {
        calls.append("location")
        completion(locationReceiptOverride ?? "{\"latitude\":45.5,\"longitude\":-73.5,\"horizontalAccuracy\":12,\"timestampISO\":\"2026-10-18T12:00:00Z\"}", nil)
    }
    func selectPhoto(_ completion: Completion) { calls.append("photo_select") }
    func selectPhotoForToolOCR(_ completion: @escaping Completion) {
        calls.append("photo_select")
        if let imageErrorCode { completion(nil, NSError(domain: "Assist.DeviceCapabilities", code: 1,
            userInfo: ["code": imageErrorCode, NSLocalizedDescriptionKey: "PRIVATE_FRAMEWORK_DESCRIPTION"])); return }
        pendingPhotoCompletion = completion
    }
    func capturePhoto(_ completion: Completion) { calls.append("camera_capture") }
    func capturePhotoForToolOCR(_ completion: Completion) {
        calls.append("camera_capture")
        if let imageErrorCode { completion(nil, NSError(domain: "Assist.DeviceCapabilities", code: 1,
            userInfo: ["code": imageErrorCode, NSLocalizedDescriptionKey: "PRIVATE_FRAMEWORK_DESCRIPTION"])); return }
        completion(imageReceiptOverride ?? "{\"source\":\"camera\",\"byteCount\":12,\"visionAvailable\":true,\"ocrStatus\":\"no_text\",\"ocrLines\":0,\"ocrTruncated\":false,\"ocrReliable\":false}", nil)
    }
    func scheduleLocalNotification(_ payload: String, completion: Completion) {
        calls.append("notification"); payloads["notification"] = payload
        let object = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any]
        let id = object?["id"] as? String ?? ""
        completion("{\"id\":\"\(id)\",\"scheduled\":\(notificationBooleanAsNumber ? "1" : "true")}", nil)
    }
    func biometricStatus(_ completion: Completion) { calls.append("biometric_status"); completion(biometricReceiptOverride ?? "{\"available\":true,\"type\":\"faceId\"}", nil) }
    func authenticateWithBiometrics(_ reason: String, completion: Completion) { calls.append("biometric_auth"); completion("{\"authenticated\":true}", nil) }
    func capabilityStatus(_ completion: Completion) {
        calls.append("capabilities")
        completion(capabilityReceiptOverride ?? "{\"capabilities\":{\"contacts\":\"authorized\",\"calendar\":\"authorized\",\"reminders\":\"authorized\",\"location\":\"authorizedWhenInUse\",\"camera\":\"authorized\",\"notifications\":\"authorized\"}}", nil)
    }
    func nativeCapabilityBoundary(_ feature: String, completion: Completion) { calls.append("boundary"); completion("{\"boundary\":{\"supported\":false}}", nil) }
    func deliverLatePhotoResult() {
        pendingPhotoCompletion?("{\"source\":\"photoLibrary\",\"byteCount\":12,\"visionAvailable\":true,\"ocrStatus\":\"no_text\",\"ocrLines\":0,\"ocrTruncated\":false,\"ocrReliable\":false}", nil)
    }
}

@MainActor
final class AssistApplePlaces {
    static let shared = AssistApplePlaces()
    typealias Completion = (Result<String, Error>) -> Void
    var calls: [String] = []
    var deferResult = false
    var errorCode: Int?
    var cancelCount = 0
    var pending: Completion?
    func cancel() { cancelCount += 1; pending?(.failure(CancellationError())); pending = nil }
    private func send(_ request: String, tool: String, completion: @escaping Completion) {
        calls.append(tool)
        if let errorCode { completion(.failure(NSError(domain: "Assist.ApplePlaces", code: errorCode,
            userInfo: [NSLocalizedDescriptionKey: "PRIVATE_APPLE_FRAMEWORK_DESCRIPTION"]))); return }
        if deferResult { pending = completion; return }
        do {
            var row = try AssistToolValue.decodeJSON(request).objectDictionary!
            if tool == "maps_search" {
                row.removeValue(forKey: "query"); row.removeValue(forKey: "limit")
                row["provider"] = .string("Apple Maps"); row["results"] = .array([])
                row["truncated"] = .bool(false); row["untrusted"] = .bool(true)
            } else if tool == "maps_directions" {
                row["provider"] = .string("Apple Maps"); row["distanceMeters"] = .number(123)
                row["expectedTravelSeconds"] = .number(60); row["name"] = .string("Fixture")
                row["calculatedAt"] = .string("2026-10-19T12:00:00Z")
                row["estimateOnly"] = .bool(true); row["navigationStarted"] = .bool(false)
            } else {
                row["temperatureUnit"] = row.removeValue(forKey: "unit")
                row.removeValue(forKey: "hourlyCount"); row.removeValue(forKey: "dailyCount")
                row["retrievedAt"] = .string("2026-10-19T12:00:00Z")
                row["forecastNotGuarantee"] = .bool(true); row["hourly"] = .array([]); row["daily"] = .array([])
                row["attribution"] = .object(["serviceName": .string("Apple Weather"), "legalPageURL": .string("https://weatherkit.apple.com/legal-attribution.html"), "combinedMarkLightURL": .string("https://weatherkit.apple.com/light.png"), "combinedMarkDarkURL": .string("https://weatherkit.apple.com/dark.png"), "legalAttributionText": .string("Apple Weather")])
                row["current"] = .object(["date": .string("2026-10-19T12:00:00Z"), "condition": .string("Clear"), "symbolName": .string("sun.max"), "temperature": .number(10), "apparentTemperature": .number(9), "humidity": .number(0.5), "windKilometersPerHour": .number(3)])
            }
            completion(.success(try AssistJSON.encode(AssistToolValue.object(row))))
        } catch { completion(.failure(error)) }
    }
    func searchPlaces(_ request: String, completion: @escaping Completion) { send(request, tool: "maps_search", completion: completion) }
    func directions(_ request: String, completion: @escaping Completion) { send(request, tool: "maps_directions", completion: completion) }
    func forecast(_ request: String, completion: @escaping Completion) { send(request, tool: "weather_forecast", completion: completion) }
}

// Test doubles for the three framework owners only. The production dispatch,
// request construction, response validators and broker are compiled unchanged.
@MainActor
final class AssistAlarms {
    static let shared = AssistAlarms()
    typealias Completion = @Sendable (String?, NSError?) -> Void
    var calls: [String] = []
    var status: AssistAlarmPolicy.Status = .succeeded
    var code: AssistAlarmPolicy.Code = .ok
    var receiptMode = "valid"
    var journalURL: URL?
    var sawDurableSubmission = false
    var cancelCount = 0
    func execute(_ raw: String, completion: @escaping Completion) {
        calls.append(raw)
        do {
            let request = try AssistAlarmPolicy.request(raw)
            if let journalURL {
                let data = try Data(contentsOf: journalURL)
                let row = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let operations = row?["operations"] as? [[String: Any]] ?? []
                sawDurableSubmission = operations.contains {
                    $0["operationId"] as? String == request.operationId && $0["state"] as? String == "submitted"
                }
            }
            var item: [String: Any] = ["alarm_id": request.alarm_id ?? request.operationId,
                "kind": request.kind?.rawValue ?? "timer", "title": request.title ?? "Fixture",
                "state": request.action == .cancel ? "not_present" : request.kind == .alarm ? "scheduled" : "countdown",
                "uncertain": status == .outcome_unknown]
            if request.kind == .alarm { item["date_iso"] = request.date_iso }
            else { item["duration_seconds"] = request.duration_seconds ?? 120 }
            switch receiptMode {
            case "foreign": item["alarm_id"] = "22222222-2222-4222-8222-222222222222"
            case "title": item["title"] = "Changed"
            case "duration": item["duration_seconds"] = 600
            case "uncertain": item["uncertain"] = true
            default: break
            }
            let items = request.action == .list || status == .failed_safe || receiptMode == "empty" ? [] : [item]
            let row: [String: Any] = ["schemaVersion": 1, "requestId": request.requestId, "operationId": request.operationId,
                "action": request.action.rawValue, "status": status.rawValue, "code": code.rawValue, "items": items]
            completion(String(data: try JSONSerialization.data(withJSONObject: row), encoding: .utf8), nil)
        } catch { completion(nil, error as NSError) }
    }
    func cancel() { cancelCount += 1 }
}
@MainActor
final class AssistTranslation {
    static let shared = AssistTranslation()
    func execute(_ raw: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        completion(nil, NSError(domain: "ScriptedTranslationFixtureUnused", code: 1))
    }
    func cancel() {}
}
@MainActor
final class AssistDocumentActions {
    static let shared = AssistDocumentActions()
    enum Mode { case unused, deferred, nativeUnknown, malformed, userCancelled, preSubmissionError, succeeded, wrongReadMethod, longIndexExpiry }
    var mode = Mode.unused
    var calls: [String] = []
    var cancelCount = 0
    var journalURL: URL?
    var sawDurableSubmission = false
    var started = false
    private var startWaiter: CheckedContinuation<Void, Never>?
    private var pending: (@Sendable (String?, NSError?) -> Void)?
    private var pendingRequest: AssistDocumentActionsPolicy.Request?
    func execute(_ raw: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        calls.append(raw)
        do {
            let request = try AssistDocumentActionsPolicy.request(raw)
            if let journalURL {
                let row = try JSONSerialization.jsonObject(with: Data(contentsOf: journalURL)) as? [String: Any]
                let operations = row?["operations"] as? [[String: Any]] ?? []
                sawDurableSubmission = operations.contains {
                    $0["operationId"] as? String == request.requestId && $0["state"] as? String == "submitted"
                }
            }
            started = true; startWaiter?.resume(); startWaiter = nil
            switch mode {
            case .unused: completion(nil, NSError(domain: "ScriptedDocumentFixtureUnused", code: 1))
            case .deferred: pending = completion; pendingRequest = request
            case .nativeUnknown: completion(nil, AssistDocumentActionsPolicy.failure(.outcomeUnknown))
            case .malformed: completion("{}", nil)
            case .preSubmissionError: completion(nil, AssistDocumentActionsPolicy.failure(.unavailable))
            case .userCancelled:
                let fields: [String: AssistToolValue] = request.action == .compose
                    ? ["status": .string("cancelled_by_user"), "channel": .string(request.string("channel")), "deliveryVerified": .bool(false)]
                    : ["status": .string("cancelled")]
                completion(try AssistDocumentActionsPolicy.response(request, fields: fields), nil)
            case .succeeded: completion(try success(request), nil)
            case .wrongReadMethod, .longIndexExpiry:
                let fields: [String: AssistToolValue] = mode == .wrongReadMethod
                    ? ["status": .string("read"), "inboxId": .string(request.inboxId), "kind": .string("pdf"),
                       "text": .string("Fixture"), "method": .string("utf8"), "truncated": .bool(false),
                       "untrusted": .bool(true), "documentState": .string("text")]
                    : ["status": .string("indexed"), "inboxId": .string(request.inboxId), "expiresAt": .string("2099-01-01T00:00:00Z")]
                var row = fields; row["schemaVersion"] = .number(1); row["requestId"] = .string(request.requestId)
                row["action"] = .string(request.action.rawValue)
                completion(try AssistJSON.encode(AssistToolValue.object(row)), nil)
            }
        } catch { completion(nil, error as NSError) }
    }
    func waitForStart() async {
        if started { return }
        await withCheckedContinuation { startWaiter = $0 }
    }
    func cancel() {
        cancelCount += 1
        // Cancellation after OS handoff explicitly carries uncertainty. Keep
        // a scripted late callback to verify the broker gate cannot reopen it.
        pending?(nil, AssistDocumentActionsPolicy.failure(.outcomeUnknown))
    }
    func deliverLateSuccess() throws {
        guard let request = pendingRequest else { return }
        pending?(try success(request), nil)
    }
    func reset() {
        started = false; sawDurableSubmission = false
        pending = nil; pendingRequest = nil
    }
    private func success(_ request: AssistDocumentActionsPolicy.Request) throws -> String {
        let fields: [String: AssistToolValue]
        switch request.action {
        case .compose: fields = ["status": .string("queued_by_user"), "channel": .string(request.string("channel")), "deliveryVerified": .bool(false)]
        case .scan: fields = ["status": .string("scanned"), "inboxId": .string("b0123456-1234-4234-8234-123456789012"), "pageCount": .number(1), "byteCount": .number(100), "text": .string("OCR fixture"), "method": .string("vision_ocr"), "truncated": .bool(false), "untrusted": .bool(true), "documentState": .string("text")]
        case .export_pdf: fields = ["status": .string("exported"), "inboxId": .string(request.inboxId), "filename": .string(request.string("filename"))]
        default: throw AssistDocumentActionsPolicy.failure(.invalid)
        }
        return try AssistDocumentActionsPolicy.response(request, fields: fields)
    }
}
EOF
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$ASSIST_TOOL_TRANSACTION_DIR/module-cache" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistApplePlacesPolicy.swift \
  mobile/ios/Assist/Services/AssistAlarmPolicy.swift \
  mobile/ios/Assist/Services/AssistTranslationPolicy.swift \
  mobile/ios/Assist/Services/AssistDocumentActionsPolicy.swift \
  mobile/ios/Assist/Services/AssistCapabilityActions.swift \
  mobile/ios/Assist/Inference/AssistToolTransactions.swift \
  "$ASSIST_TOOL_TRANSACTION_DIR/GatewayStub.swift" \
  scripts/check-tool-transactions.swift -o "$ASSIST_TOOL_TRANSACTION_DIR/check-tool-transactions"
"$ASSIST_TOOL_TRANSACTION_DIR/check-tool-transactions"
echo "NOTE: framework-owner doubles replace AlarmKit, Translation, UIKit and the legacy gateway; this does not qualify device behavior."
