import Foundation

@main struct AlarmChecks {
    static func main() throws {
        var count = 0
        func check(_ condition: Bool, _ label: String) {
            guard condition else { fatalError(label) }; count += 1
        }
        func rejected(_ label: String, _ body: () throws -> Void) {
            do { try body(); fatalError("accepted: \(label)") } catch { count += 1 }
        }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let id = "11111111-1111-4111-8111-111111111111"
        let other = "22222222-2222-4222-8222-222222222222"
        let base = "\"schemaVersion\":1,\"requestId\":\"\(id)\",\"operationId\":\"\(id)\""
        func raw(_ suffix: String) -> String { "{\(base),\(suffix)}" }
        let timerRaw = raw("\"action\":\"create\",\"alarm_id\":\"\(id)\",\"kind\":\"timer\",\"title\":\"Thé\",\"duration_seconds\":120")
        let timer = try AssistAlarmPolicy.request(timerRaw, now: now)
        check(timer.duration_seconds == 120 && timer.kind == .timer, "real timer request")
        let alarmRaw = raw("\"action\":\"create\",\"alarm_id\":\"\(id)\",\"kind\":\"alarm\",\"title\":\"Réveil\",\"date_iso\":\"2027-01-15T09:00:00Z\"")
        check(try AssistAlarmPolicy.request(alarmRaw, now: now).kind == .alarm, "absolute date")
        let pastRequestRaw = alarmRaw.replacingOccurrences(of: "2027-01-15", with: "2020-01-15")
        let pastRequest = try AssistAlarmPolicy.request(pastRequestRaw, now: nil)
        let completedAlarm = AssistAlarmPolicy.receipt(pastRequest, status: .succeeded, code: .ok,
            items: [AssistAlarmPolicy.Item(request: pastRequest, state: .not_present, uncertain: false)])
        check(try AssistAlarmPolicy.result(AssistAlarmPolicy.encode(completedAlarm), request: pastRequest).status == .succeeded,
              "receipt keeps acknowledged success after scheduled time passes")
        rejected("admission still rejects expired schedule") { _ = try AssistAlarmPolicy.request(pastRequestRaw, now: now) }

        let invalidRequests: [(String, String)] = [
            ("unknown field", String(timerRaw.dropLast()) + ",\"url\":\"https://example.com\"}"),
            ("negative", timerRaw.replacingOccurrences(of: ":120", with: ":-1")),
            ("zero", timerRaw.replacingOccurrences(of: ":120", with: ":0")),
            ("large", timerRaw.replacingOccurrences(of: ":120", with: ":86401")),
            ("fraction", timerRaw.replacingOccurrences(of: ":120", with: ":1.5")),
            ("bool", timerRaw.replacingOccurrences(of: ":120", with: ":true")),
            ("arbitrary ID", timerRaw.replacingOccurrences(of: "\"alarm_id\":\"\(id)\"", with: "\"alarm_id\":\"\(other)\"")),
            ("two schedules", String(timerRaw.dropLast()) + ",\"date_iso\":\"2027-01-15T09:00:00Z\"}"),
            ("past date", alarmRaw.replacingOccurrences(of: "2027-01-15", with: "2020-01-15")),
            ("control title", timerRaw.replacingOccurrences(of: "Thé", with: "a\\nb")),
            ("huge title", timerRaw.replacingOccurrences(of: "Thé", with: String(repeating: "é", count: 61))),
            ("schema", timerRaw.replacingOccurrences(of: "schemaVersion\":1", with: "schemaVersion\":2")),
            ("oversize", String(repeating: " ", count: 2049) + timerRaw),
        ]
        for (label, candidate) in invalidRequests { rejected(label) { _ = try AssistAlarmPolicy.request(String(candidate), now: now) } }
        var journal = AssistAlarmPolicy.Journal()
        try journal.reserve(timer)
        check(journal.items[id]?.kind == .timer, "ownership durably reserved first")
        check(journal.operations[id]?.submitted == false, "not submitted until caller persists")
        check(try journal.previous(timer) != nil, "same request replay has record")
        rejected("duplicate mutation") { try journal.reserve(timer) }
        var unknown = journal
        unknown.operations[id]!.submitted = true
        unknown.reconcile([id: .countdown, other: .scheduled])
        check(unknown.items[id]?.uncertain == true, "schedule without ack is uncertain even when observed")
        check(unknown.items[other] == nil, "foreign OS alarm not imported into ownership")
        let updateRaw = "{\"schemaVersion\":1,\"requestId\":\"\(other)\",\"operationId\":\"\(other)\",\"action\":\"update\",\"alarm_id\":\"\(id)\",\"kind\":\"timer\",\"title\":\"Thé\",\"duration_seconds\":60}"
        let update = try AssistAlarmPolicy.request(updateRaw, now: now)
        rejected("uncertain operation never retried") { try unknown.reserve(update) }
        let cancel = try AssistAlarmPolicy.request(updateRaw.replacingOccurrences(of: "\"action\":\"update\"", with: "\"action\":\"cancel\"").replacingOccurrences(of: ",\"kind\":\"timer\",\"title\":\"Thé\",\"duration_seconds\":60", with: ""), now: now)
        try unknown.reserve(cancel)
        check(unknown.operations[other]?.submitted == false, "explicit cancel can reconcile unknown")
        let receipt = AssistAlarmPolicy.receipt(timer, status: .outcome_unknown, code: .outcome_unknown, items: Array(unknown.items.values))
        let result = try AssistAlarmPolicy.encode(receipt)
        check(try AssistAlarmPolicy.result(result, request: timer) == receipt, "closed receipt roundtrip")
        for candidate in [result.replacingOccurrences(of: "outcome_unknown", with: "invented_success"), String(result.dropLast()) + ",\"extra\":true}", result.replacingOccurrences(of: "\"state\":\"countdown\"", with: "\"state\":\"fired_on_device\"")] {
            rejected("forged native result") { _ = try AssistAlarmPolicy.result(String(candidate), request: timer) }
        }
        var restored = try JSONDecoder().decode(AssistAlarmPolicy.Journal.self, from: JSONEncoder().encode(unknown))
        try AssistAlarmPolicy.validate(restored)
        check(restored == unknown, "restart retains pending ownership and requests")
        restored.reconcile([:])
        check(restored.items[id]?.state == .not_present && restored.items[id]?.uncertain == true, "absence is no fabricated successful schedule")
        var foreign = AssistAlarmPolicy.Journal()
        rejected("foreign cancel") { try foreign.reserve(cancel) }
        var conflict = timer
        conflict = try AssistAlarmPolicy.request(timerRaw.replacingOccurrences(of: "Thé", with: "Café"), now: now)
        rejected("identity collision") { _ = try journal.previous(conflict) }
        let list = try AssistAlarmPolicy.request(raw("\"action\":\"list\""), now: now)
        func changed(_ item: AssistAlarmPolicy.Item, _ changes: [String: Any]) throws -> AssistAlarmPolicy.Item {
            var row = try JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as! [String: Any]
            for (key, value) in changes { row[key] = value }
            return try JSONDecoder().decode(AssistAlarmPolicy.Item.self, from: JSONSerialization.data(withJSONObject: row))
        }
        for mutation in [timer, update, cancel,
            try AssistAlarmPolicy.request(raw("\"action\":\"stop\",\"alarm_id\":\"\(id)\""), now: now)] {
            let target = AssistAlarmPolicy.Item(request: timer, state: .countdown, uncertain: false)
            let foreign = try changed(target, ["alarm_id": other])
            var uncertain = target; uncertain.uncertain = true
            for items in [[], [foreign], [uncertain]] {
                rejected("mutation needs its certain target") {
                    _ = try AssistAlarmPolicy.result(AssistAlarmPolicy.encode(AssistAlarmPolicy.receipt(mutation, status: .succeeded, code: .ok, items: items)), request: mutation)
                }
            }
        }
        for mutation in [timer, update] {
            for field in ["title", "duration", "kind"] {
                let changes: [String: Any] = field == "title" ? ["title": "Café"] : field == "duration" ? ["duration_seconds": 600] :
                    ["kind": "alarm", "duration_seconds": NSNull(), "date_iso": "2027-01-15T09:00:00Z"]
                let target = try changed(AssistAlarmPolicy.Item(request: mutation, state: .countdown, uncertain: false), changes)
                rejected("success cannot change approved \(field)") {
                    _ = try AssistAlarmPolicy.result(AssistAlarmPolicy.encode(AssistAlarmPolicy.receipt(mutation, status: .succeeded, code: .ok, items: [target])), request: mutation)
                }
            }
        }
        let validSuccess = try AssistAlarmPolicy.encode(AssistAlarmPolicy.receipt(timer, status: .succeeded, code: .ok,
            items: [.init(request: timer, state: .countdown, uncertain: false)]))
        for key in ["status", "st\\u0061tus"] {
            rejected("duplicate decoded receipt key") {
                _ = try AssistAlarmPolicy.result("{\"\(key)\":\"failed_safe\"," + validSuccess.dropFirst(), request: timer)
            }
        }
        rejected("duplicate nested decoded title") {
            _ = try AssistAlarmPolicy.result(validSuccess.replacingOccurrences(of: "\"title\":\"Thé\"",
                with: "\"t\\u0069tle\":\"Changed\",\"title\":\"Thé\""), request: timer)
        }
        let certain = AssistAlarmPolicy.Item(request: timer, state: .countdown, uncertain: false)
        let multiple = AssistAlarmPolicy.receipt(timer, status: .succeeded, code: .ok,
            items: [certain, try changed(certain, ["alarm_id": other])])
        check(try AssistAlarmPolicy.result(AssistAlarmPolicy.encode(multiple), request: timer).items.count == 2,
              "success may include other app-owned alarms")
        check(try AssistAlarmPolicy.result(AssistAlarmPolicy.encode(AssistAlarmPolicy.receipt(list,
            status: .succeeded, code: .ok, items: [])), request: list).items.isEmpty, "empty app-owned list is valid")
        check(list.alarm_id == nil, "list has no permission or mutation args")
        rejected("list with mutation arg") { _ = try AssistAlarmPolicy.request(raw("\"action\":\"list\",\"alarm_id\":\"\(id)\""), now: now) }
        print("\(count) AlarmKit policy checks passed")
    }
}
