import CoreFoundation
import Foundation

enum AssistAgentCalendarFailure: String, Error, LocalizedError, Sendable {
    case invalidScope = "E_AGENT_CALENDAR_SCOPE"
    case invalidArguments = "E_AGENT_CALENDAR_ARGUMENTS"
    case invalidResult = "E_AGENT_CALENDAR_RESULT"

    var errorDescription: String? {
        switch self {
        case .invalidScope: return "La période locale du calendrier est invalide."
        case .invalidArguments: return "La demande ne correspond pas à la lecture du calendrier autorisée pour ce tour."
        case .invalidResult: return "La réponse locale du calendrier est invalide."
        }
    }
}

/// Native-owned day boundaries, captured once for the tactile user action.
/// Model arguments may repeat these instants; they cannot widen this scope.
struct AssistAgentCalendarScope: Codable, Sendable {
    let startISO: String
    let endISO: String
    let timeZoneIdentifier: String

    static func today(now: Date = Date(), timeZone: TimeZone = .current) throws -> Self {
        guard now.timeIntervalSinceReferenceDate.isFinite else { throw AssistAgentCalendarFailure.invalidScope }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let day = calendar.dateInterval(of: .day, for: now) else { throw AssistAgentCalendarFailure.invalidScope }
        let scope = Self(startISO: AssistAgentCalendarValidation.iso(day.start),
                         endISO: AssistAgentCalendarValidation.iso(day.end), timeZoneIdentifier: timeZone.identifier)
        _ = try scope.validatedInterval()
        return scope
    }

    func validatedInterval() throws -> (start: Date, end: Date) {
        guard timeZoneIdentifier.utf8.count <= 128, let zone = TimeZone(identifier: timeZoneIdentifier),
              let start = try? AssistAgentCalendarValidation.timestamp(startISO),
              let end = try? AssistAgentCalendarValidation.timestamp(endISO), start < end else {
            throw AssistAgentCalendarFailure.invalidScope
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        guard let day = calendar.dateInterval(of: .day, for: start), day.start == start, day.end == end else {
            throw AssistAgentCalendarFailure.invalidScope
        }
        return (start, end)
    }

    func validateArguments(_ value: [String: Any]) throws {
        _ = try validatedInterval()
        guard Set(value.keys) == ["start_iso", "end_iso", "limit"],
              value["start_iso"] as? String == startISO, value["end_iso"] as? String == endISO,
              let limit = value["limit"] as? NSNumber,
              CFGetTypeID(limit) != CFBooleanGetTypeID(), limit.doubleValue == 5 else {
            throw AssistAgentCalendarFailure.invalidArguments
        }
    }
}

struct AssistAgentCalendarObservation: Codable, Sendable {
    struct Event: Codable, Sendable {
        let title: String
        let startISO: String
        let endISO: String
        let allDay: Bool
    }

    let scope: AssistAgentCalendarScope
    let events: [Event]
    /// A five-row prefix may omit other matching events. No ordering guarantee.
    let possiblyTruncated: Bool

    var modelResponse: [String: any Sendable] {
        let period: [String: any Sendable] = ["startISO": scope.startISO, "endISO": scope.endISO,
                                             "timeZoneIdentifier": scope.timeZoneIdentifier]
        let rows: [[String: any Sendable]] = events.map { event in
            ["title": event.title, "startISO": event.startISO, "endISO": event.endISO, "allDay": event.allDay]
        }
        return ["scope": period, "events": rows, "count": events.count, "possiblyTruncated": possiblyTruncated]
    }

    static func validated(json: String, scope: AssistAgentCalendarScope) throws -> Self {
        let interval = try scope.validatedInterval()
        guard json.utf8.count <= 16 * 1024,
              let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(value.keys) == ["events"], let rawRows = value["events"] as? [[String: Any]], rawRows.count <= 5 else {
            throw AssistAgentCalendarFailure.invalidResult
        }
        let expected: Set<String> = ["id", "calendarId", "calendarTitle", "title", "startISO", "endISO", "allDay"]
        let rows = try rawRows.map { row -> Event in
            guard Set(row.keys) == expected,
                  AssistAgentCalendarValidation.text(row["id"], maximumBytes: 512, allowEmpty: false) != nil,
                  AssistAgentCalendarValidation.text(row["calendarId"], maximumBytes: 512, allowEmpty: false) != nil,
                  AssistAgentCalendarValidation.text(row["calendarTitle"], maximumBytes: 1_024) != nil,
                  let title = AssistAgentCalendarValidation.text(row["title"], maximumBytes: 2_048),
                  let startISO = row["startISO"] as? String, let endISO = row["endISO"] as? String,
                  let start = try? AssistAgentCalendarValidation.timestamp(startISO),
                  let end = try? AssistAgentCalendarValidation.timestamp(endISO), start <= end,
                  let allDay = row["allDay"] as? NSNumber, CFGetTypeID(allDay) == CFBooleanGetTypeID() else {
                throw AssistAgentCalendarFailure.invalidResult
            }
            let overlaps = start == end
                ? start >= interval.start && start < interval.end
                : start < interval.end && end > interval.start
            guard overlaps else { throw AssistAgentCalendarFailure.invalidResult }
            // Deliberately drop identifiers and calendar names before model use.
            return Event(title: title, startISO: startISO, endISO: endISO, allDay: allDay.boolValue)
        }
        return Self(scope: scope, events: rows, possiblyTruncated: rows.count == 5)
    }
}

/// Closed UTC timestamp and byte bounds also used by deviceCapabilities.ts.
enum AssistAgentCalendarValidation {
    static func text(_ value: Any?, maximumBytes: Int, allowEmpty: Bool = true) -> String? {
        guard let raw = value as? String, (allowEmpty || !raw.isEmpty), raw.utf8.count <= maximumBytes else { return nil }
        return raw
    }

    static func timestamp(_ raw: String) throws -> Date {
        guard raw.utf8.count <= 24,
              raw.range(of: #"^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$"#,
                        options: .regularExpression) != nil else { throw AssistAgentCalendarFailure.invalidResult }
        let formatter = ISO8601DateFormatter()
        if raw.contains(".") { formatter.formatOptions.insert(.withFractionalSeconds) }
        guard let date = formatter.date(from: raw), formatter.string(from: date) == raw else {
            throw AssistAgentCalendarFailure.invalidResult
        }
        return date
    }

    static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}
