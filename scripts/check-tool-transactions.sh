#!/usr/bin/env bash
# Pure policy/journal harness. It uses declared gateway stubs solely to compile
# the coordinator; it does not execute UIKit, EventKit, contacts, permissions,
# pickers, biometrics, notifications, or any device operation.
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
        completion("{\"latitude\":45.5,\"longitude\":-73.5,\"horizontalAccuracy\":12,\"timestampISO\":\"2026-10-18T12:00:00Z\"}", nil)
    }
    func selectPhoto(_ completion: Completion) { calls.append("photo_select") }
    func selectPhotoForToolOCR(_ completion: @escaping Completion) { calls.append("photo_select"); pendingPhotoCompletion = completion }
    func capturePhoto(_ completion: Completion) { calls.append("camera_capture") }
    func capturePhotoForToolOCR(_ completion: Completion) {
        calls.append("camera_capture")
        completion("{\"source\":\"camera\",\"byteCount\":12,\"visionAvailable\":true,\"ocrStatus\":\"no_text\",\"ocrLines\":0,\"ocrTruncated\":false,\"ocrReliable\":false}", nil)
    }
    func scheduleLocalNotification(_ payload: String, completion: Completion) {
        calls.append("notification"); payloads["notification"] = payload
        let object = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any]
        let id = object?["id"] as? String ?? ""
        completion("{\"id\":\"\(id)\",\"scheduled\":true}", nil)
    }
    func biometricStatus(_ completion: Completion) { calls.append("biometric_status"); completion("{\"available\":true,\"type\":\"faceId\"}", nil) }
    func authenticateWithBiometrics(_ reason: String, completion: Completion) { calls.append("biometric_auth"); completion("{\"authenticated\":true}", nil) }
    func capabilityStatus(_ completion: Completion) {
        calls.append("capabilities")
        completion("{\"capabilities\":{\"contacts\":\"authorized\",\"calendar\":\"authorized\",\"reminders\":\"authorized\",\"location\":\"authorizedWhenInUse\",\"camera\":\"authorized\",\"notifications\":\"authorized\"}}", nil)
    }
    func nativeCapabilityBoundary(_ feature: String, completion: Completion) { calls.append("boundary"); completion("{\"boundary\":{\"supported\":false}}", nil) }
    func deliverLatePhotoResult() {
        pendingPhotoCompletion?("{\"source\":\"photoLibrary\",\"byteCount\":12,\"visionAvailable\":true,\"ocrStatus\":\"no_text\",\"ocrLines\":0,\"ocrTruncated\":false,\"ocrReliable\":false}", nil)
    }
}
EOF
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  -module-cache-path "$ASSIST_TOOL_TRANSACTION_DIR/module-cache" \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistToolTransactions.swift \
  "$ASSIST_TOOL_TRANSACTION_DIR/GatewayStub.swift" \
  scripts/check-tool-transactions.swift -o "$ASSIST_TOOL_TRANSACTION_DIR/check-tool-transactions"
"$ASSIST_TOOL_TRANSACTION_DIR/check-tool-transactions"
echo "NOTE: this pure harness does not execute UIKit, EventKit, permissions, pickers, biometrics, notifications, or device behavior."
