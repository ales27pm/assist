import Foundation

/// Foundation-only calendar contracts; never reads a device calendar.
@main
struct AgentCalendarChecks {
    static func check(_ value: Bool, _ message: String) {
        precondition(value, message)
    }

    static func rejected(_ operation: () throws -> Void) {
        do { try operation(); preconditionFailure("Invalid calendar data was accepted") }
        catch { check(error is AssistAgentCalendarFailure, "Calendar errors must remain fixed and bounded") }
    }

    static func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    static func main() throws {
        let zone = TimeZone(identifier: "America/Toronto")!
        let spring = try AssistAgentCalendarScope.today(
            now: AssistAgentCalendarValidation.timestamp("2026-03-08T12:00:00Z"), timeZone: zone)
        check(spring.startISO == "2026-03-08T05:00:00Z", "Use local midnight at the start of DST day")
        check(spring.endISO == "2026-03-09T04:00:00Z", "The spring civil day is 23 hours")
        let autumn = try AssistAgentCalendarScope.today(
            now: AssistAgentCalendarValidation.timestamp("2026-11-01T12:00:00Z"), timeZone: zone)
        check(autumn.startISO == "2026-11-01T04:00:00Z", "Capture the autumn day in the selected zone")
        check(autumn.endISO == "2026-11-02T05:00:00Z", "The autumn civil day is 25 hours")

        let scope = try AssistAgentCalendarScope.today(
            now: AssistAgentCalendarValidation.timestamp("2026-10-18T12:00:00Z"), timeZone: zone)
        let arguments: [String: Any] = ["start_iso": scope.startISO, "end_iso": scope.endISO, "limit": 5]
        try scope.validateArguments(arguments)
        for bad in [true, "5", 5.5, 6] as [Any] {
            var value = arguments; value["limit"] = bad
            rejected { try scope.validateArguments(value) }
        }
        var extra = arguments; extra["authorize"] = true
        rejected { try scope.validateArguments(extra) }
        var missing = arguments; missing.removeValue(forKey: "end_iso")
        rejected { try scope.validateArguments(missing) }
        var changed = arguments; changed["start_iso"] = "2026-10-17T04:00:00Z"
        rejected { try scope.validateArguments(changed) }
        for raw in ["2026-02-30T00:00:00Z", "2026-10-18", "2026-10-18T00:00:00", "2026-10-18T25:00:00Z"] {
            rejected { _ = try AssistAgentCalendarValidation.timestamp(raw) }
        }

        let row: [String: Any] = [
            "id": "PRIVATE_EVENT_ID", "calendarId": "PRIVATE_CALENDAR_ID", "calendarTitle": "PRIVATE_CALENDAR_TITLE",
            "title": "Dentiste", "startISO": "2026-10-18T10:00:00Z", "endISO": "2026-10-18T10:30:00Z", "allDay": false,
        ]
        let observation = try AssistAgentCalendarObservation.validated(json: json(["events": [row]]), scope: scope)
        check(observation.events.count == 1 && observation.events[0].title == "Dentiste", "Keep the requested event data")
        check(!observation.possiblyTruncated, "Fewer than five results do not claim truncation")
        check(Set(observation.modelResponse.keys) == ["scope", "events", "count", "possiblyTruncated"], "The model sees only the closed reduced response")
        let encoded = String(decoding: try JSONEncoder().encode(observation), as: UTF8.self)
        check(!encoded.contains("PRIVATE_"), "Identifiers and calendar names never reach the model observation")
        let five = try AssistAgentCalendarObservation.validated(json: json(["events": Array(repeating: row, count: 5)]), scope: scope)
        check(five.possiblyTruncated, "A full five-result response may be truncated")
        rejected { _ = try AssistAgentCalendarObservation.validated(json: json(["events": Array(repeating: row, count: 6)]), scope: scope) }
        rejected { _ = try AssistAgentCalendarObservation.validated(json: json(["events": [row], "notes": "private"]), scope: scope) }
        for (key, value) in [
            ("title", 42 as Any), ("allDay", 1 as Any), ("title", String(repeating: "é", count: 1_025) as Any),
            ("id", String(repeating: "x", count: 513) as Any), ("startISO", scope.endISO as Any),
        ] {
            var invalidRow = row; invalidRow[key] = value
            rejected { _ = try AssistAgentCalendarObservation.validated(json: json(["events": [invalidRow]]), scope: scope) }
        }
        var extraRow = row; extraRow["notes"] = "private"
        rejected { _ = try AssistAgentCalendarObservation.validated(json: json(["events": [extraRow]]), scope: scope) }
        var missingRow = row; missingRow.removeValue(forKey: "allDay")
        rejected { _ = try AssistAgentCalendarObservation.validated(json: json(["events": [missingRow]]), scope: scope) }
        var overlap = row; overlap["startISO"] = "2026-10-18T03:00:00Z"; overlap["endISO"] = "2026-10-18T05:00:00Z"
        var instant = row; instant["startISO"] = "2026-10-18T12:00:00.000Z"; instant["endISO"] = "2026-10-18T12:00:00.000Z"
        let unsorted = try AssistAgentCalendarObservation.validated(json: json(["events": [instant, overlap]]), scope: scope)
        check(unsorted.events.count == 2, "Accept overlapping/instant events without inventing an order guarantee")
        print("Agent calendar contracts passed: DST scope, closed arguments, bounded reduced observations. No EventKit/device access.")
    }
}
