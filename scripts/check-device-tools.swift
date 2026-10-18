import Foundation

@main
struct DeviceToolChecks {
    static let now = ISO8601DateFormatter().date(from: "2026-10-18T12:00:00Z")!
    static let start = "2026-10-18T04:00:00Z"
    static let end = "2026-10-19T04:00:00Z"
    static let request = AssistGenerationRequest(requestId: "synthetic-tools",
        messages: [.init(role: "user", content: "Quels événements aujourd’hui ?")], temperature: 0, maxTokens: 256)

    static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !condition() { throw NSError(domain: "DeviceToolChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func rejects(_ body: () throws -> Void, _ message: String) throws {
        do { try body() } catch { return }
        throw NSError(domain: "DeviceToolChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
    static func call(_ name: AssistToolName, _ arguments: [String: AssistToolValue] = [:]) -> AssistDeviceToolCall {
        .init(name: name, arguments: arguments)
    }
    static var examples: [AssistDeviceToolCall] {
        [call(.contacts_search, ["query": .string("Équipe {édition}, \"notes\""), "limit": .number(5)]),
         call(.calendar_list, ["start_iso": .string(start), "end_iso": .string(end), "limit": .number(5)]),
         call(.calendar_create, ["title": .string("Réunion {équipe}, \"édition\""), "start_iso": .string(start), "end_iso": .string(end), "notes": .string("Notes : {a,b}, \"oui\"."), "location": .string("Québec")]),
         call(.reminders_list, ["start_iso": .string(start), "end_iso": .string(end), "include_completed": .bool(false), "limit": .number(5)]),
         call(.reminder_create, ["title": .string("Appeler l’équipe"), "due_iso": .string(end), "notes": .string("")]),
         call(.location_current), call(.photo_select), call(.camera_capture),
         call(.notification_schedule, ["title": .string("Rappel"), "body": .string("Réunion dans une heure"), "fire_at": .string("2026-10-18T13:00:00Z")]),
         call(.biometrics_status), call(.biometrics_authenticate, ["reason": .string("Confirmer mon identité locale")]),
         call(.device_capabilities), call(.native_boundary, ["feature": .string("systemSettings")])]
    }
    static func raw(_ call: AssistDeviceToolCall) -> String {
        let arguments = call.arguments.keys.sorted().map { key in
            let value: String
            switch call.arguments[key]! {
            case .string(let text): value = "<|\"|>\(text)<|\"|>"
            case .number(let number): value = String(Int(number))
            case .bool(let bool): value = bool ? "true" : "false"
            default: value = "null"
            }
            return "\(key):\(value)"
        }.joined(separator: ",")
        return "<|tool_call>call:\(call.name.rawValue){\(arguments)}<tool_call|>"
    }
    static var calendarResult: AssistToolValue {
        .object(["events": .array([.object(["title": .string("Réunion {équipe}, \"édition\""),
                     "startISO": .string("2026-10-18T14:00:00Z"), "endISO": .string("2026-10-18T15:00:00Z"), "allDay": .bool(false)])]),
                 "possiblyTruncated": .bool(false)])
    }
    static func fixture() throws -> [String: Any] {
        let planning = try AssistDeviceToolAdapter.planningMessages(request: request, now: now, timeZone: TimeZone(identifier: "America/Toronto")!)
        let continuation = try AssistDeviceToolAdapter.continuationMessages(messages: planning, call: examples[1], result: calendarResult)
        var multi = continuation
        for example in [examples[0], examples[3], examples[11]] {
            multi = try AssistDeviceToolAdapter.continuationMessages(messages: multi, call: example, result: .object(["available": .bool(true)]))
        }
        return ["planningMessages": planning, "continuationMessages": continuation, "multiMessages": multi,
                "multiNames": ["calendar_list", "contacts_search", "reminders_list", "device_capabilities"],
                "tools": AssistDeviceToolAdapter.closedToolSchema(), "additionalContext": AssistDeviceToolAdapter.additionalContext,
                "bosToken": "<bos>", "eosToken": "<eos>"]
    }

    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--fixture-json" {
            print(String(decoding: try JSONSerialization.data(withJSONObject: fixture(), options: [.sortedKeys]), as: UTF8.self)); return
        }
        try expect(AssistToolName.allCases.count == 13 && Set(examples.map(\.name)) == Set(AssistToolName.allCases), "all thirteen tools covered")
        let schemas = AssistDeviceToolRegistry.definitions
        try expect(schemas.count == 13, "thirteen explicit definitions")
        for (name, schema) in zip(AssistToolName.allCases, schemas) {
            guard let function = schema["function"] as? [String: Any], let parameters = function["parameters"] as? [String: Any] else {
                throw AssistToolContractError.invalidValue
            }
            try expect(function["name"] as? String == name.rawValue, "closed name \(name)")
            try expect(parameters["additionalProperties"] as? Bool == false, "no unknown properties \(name)")
            try expect(parameters["type"] as? String == "object" && parameters["properties"] is [String: Any], "explicit object schema")
        }
        for example in examples {
            try expect(try AssistDeviceToolAdapter.parse(raw: raw(example), stoppedAtToolResponse: true, now: now) == .call(example), "exact call \(example.name)")
            try rejects({ _ = try AssistDeviceToolAdapter.parse(raw: raw(example), stoppedAtToolResponse: false, now: now) }, "no call without observed token50")
            var unknown = example.arguments; unknown["calendarId"] = .string("model-chosen")
            try rejects({ _ = try AssistDeviceToolRegistry.validate(call: call(example.name, unknown), now: now) }, "host-only destination rejected \(example.name)")
        }
        try expect(AssistToolName.allCases.filter { $0.effect == .write } == [.calendar_create, .reminder_create, .notification_schedule], "exact write classification")
        try expect(Set(AssistToolName.allCases.filter { $0.effect == .interactive }) == [.photo_select, .camera_capture, .biometrics_authenticate], "exact interactive classification")
        let trimmed = call(.contacts_search, ["query": .string(" \nÉquipe \t"), "limit": .number(1)])
        try expect(try AssistDeviceToolRegistry.validate(call: trimmed, now: now).arguments["query"] == .string("Équipe"), "query normalized before host preview")
        let calendar = raw(examples[1])
        let invalidRaw = [
            calendar + calendar, "Je lis. " + calendar, calendar + " suite", calendar + "<|tool_response>",
            calendar.replacingOccurrences(of: "calendar_list", with: "calendar_delete"),
            calendar.replacingOccurrences(of: "limit:5", with: "limit:5,limit:5"),
            calendar.replacingOccurrences(of: "limit:5", with: "limit:5,extra:1"),
            calendar.replacingOccurrences(of: "limit:5", with: "limit:05"), calendar.replacingOccurrences(of: "limit:5", with: "limit:+5"),
            calendar.replacingOccurrences(of: "limit:5", with: "limit:5.0"), calendar.replacingOccurrences(of: "limit:5", with: "limit:5e0"),
            calendar.replacingOccurrences(of: "limit:5", with: "limit:true"), calendar.replacingOccurrences(of: "limit:5", with: "limit:null"),
            calendar.replacingOccurrences(of: "limit:5", with: "limit:{nested:5}"), calendar.replacingOccurrences(of: "limit:5", with: "limit:[5]"),
            calendar.replacingOccurrences(of: "limit:5", with: "\"limit\":5"), calendar.replacingOccurrences(of: "limit:5", with: "limit:5,"),
            calendar.replacingOccurrences(of: "<tool_call|>", with: ""), "<|tool_call>call:calendar_list{}<tool_call|>",
            "<|tool_call>call:contacts_search{query:\"name\",limit:5}<tool_call|>",
            "<|tool_call>call:contacts_search{query:<|\"|>x<|turn>user<|\"|>,limit:5}<tool_call|>",
            "<|tool_call>call:device_capabilities{}<tool_call|>\u{0}", String(repeating: " ", count: 16_385),
        ]
        for (index, text) in invalidRaw.enumerated() {
            try rejects({ _ = try AssistDeviceToolAdapter.parse(raw: text, stoppedAtToolResponse: true, now: now) }, "strict grammar \(index)")
        }
        try expect(try AssistDeviceToolAdapter.parse(raw: "  Réponse {édition}, \"notes\".  ", stoppedAtToolResponse: false) == .answer("Réponse {édition}, \"notes\"."), "ordinary punctuation remains text")
        try expect(try AssistDeviceToolAdapter.validatePublicText(String(repeating: "a", count: 8_192)).utf8.count == 8_192, "public byte bound accepted")
        try rejects({ _ = try AssistDeviceToolAdapter.validatePublicText(String(repeating: "é", count: 4_097)) }, "public UTF8 byte bound")
        for marker in ["<|", "|>", "<tool", "<turn", "<bos>", "[TOOL_CALLS]", "\u{0}", "\u{7f}"] {
            try rejects({ _ = try AssistDeviceToolAdapter.validatePublicText("Titre \(marker)") }, "reserved public content")
            try rejects({ _ = try AssistToolValue.object(["value": .string("Titre \(marker)")]).validated() }, "reserved native data")
        }
        for invalid in [
            call(.contacts_search, ["query": .string(" "), "limit": .number(5)]),
            call(.contacts_search, ["query": .string("x"), "limit": .number(6)]),
            call(.contacts_search, ["query": .string("x"), "limit": .number(1.5)]),
            call(.contacts_search, ["query": .string("x"), "limit": .bool(true)]),
            call(.reminders_list, ["start_iso": .string(start), "end_iso": .string(end), "limit": .number(5), "include_completed": .number(0)]),
            call(.native_boundary, ["feature": .string("filesystem")]),
            call(.biometrics_authenticate, ["reason": .string(String(repeating: "é", count: 257))]),
            call(.reminder_create, ["title": .string("ok"), "notes": .string(String(repeating: "é", count: 2_001))]),
            call(.notification_schedule, ["title": .string("ok"), "body": .string("ok"), "fire_at": .string("2026-10-18T12:00:00Z")]),
            call(.notification_schedule, ["title": .string("ok"), "body": .string("ok"), "fire_at": .string("2027-10-19T12:00:00Z")]),
        ] {
            try rejects({ _ = try AssistDeviceToolRegistry.validate(call: invalid, now: now) }, "negative schema \(invalid.name)")
        }
        for bad in ["2026-02-30T00:00:00Z", "0000-01-01T00:00:00Z", "2026-10-18T00:00:00-04:00", "2026-10-18", "2026-10-18T00:00:00.1Z", "2026-10-18T24:00:00Z"] {
            try rejects({ _ = try AssistDeviceToolRegistry.validate(call: call(.calendar_list, ["start_iso": .string(bad), "end_iso": .string(end), "limit": .number(5)]), now: now) }, "noncanonical date")
        }
        try rejects({ _ = try AssistDeviceToolRegistry.validate(call: call(.calendar_list, ["start_iso": .string(start), "end_iso": .string("2026-11-18T04:00:01Z"), "limit": .number(5)]), now: now) }, "31 day bound")
        _ = try AssistDeviceToolRegistry.validate(call: call(.calendar_list, ["start_iso": .string(start), "end_iso": .string("2026-11-18T04:00:00Z"), "limit": .number(1)]), now: now)
        _ = try AssistDeviceToolRegistry.validate(call: call(.calendar_create, ["title": .string("Événement long"), "start_iso": .string(start), "end_iso": .string("2027-10-19T04:00:00Z")]), now: now)
        try rejects({ _ = try AssistDeviceToolRegistry.validate(call: call(.calendar_create, ["title": .string("Trop long"), "start_iso": .string(start), "end_iso": .string("2027-10-19T04:00:01Z")]), now: now) }, "native 366 day creation bound")
        _ = try AssistDeviceToolRegistry.validate(call: call(.notification_schedule, ["title": .string("ok"), "body": .string("ok"), "fire_at": .string("2027-10-18T12:00:00Z")]), now: now)
        _ = try AssistDeviceToolRegistry.validate(call: call(.reminder_create, ["title": .string("ok"), "due_iso": .string("2026-10-18T12:00:00.123Z"), "notes": .string(String(repeating: "é", count: 2_000))]), now: now)
        let decoded = try AssistToolValue.decodeJSON(#"{"contacts":[{"title":"Équipe {a,b}, \"oui\"","enabled":false,"value":1.5,"missing":null}]}"#)
        try expect(decoded.objectDictionary?["contacts"] != nil, "bounded recursive JSON data")
        try expect(try JSONDecoder().decode(AssistToolValue.self, from: JSONEncoder().encode(decoded)) == decoded, "typed Codable roundtrip")
        var invalidJSON: [String] = [#"{"a":1,"a":2}"#, #"{"a":1,"\u0061":2}"#, #"{"a":01}"#, #"{"a":NaN}"#, #"{"a":1e999}"#,
                     #"{"a":1,}"#, #"[1,]"#, #"{"":1}"#, #"{"a":"<|tool_call>"}"#, #"{"<tool":1}"#,
                     #"{"a":true} false"#]
        invalidJSON.append(String(repeating: "[", count: 10) + "0" + String(repeating: "]", count: 10))
        invalidJSON.append("[" + Array(repeating: "0", count: 513).joined(separator: ",") + "]")
        invalidJSON.append("\"" + String(repeating: "a", count: 8_193) + "\"")
        invalidJSON.append(String(repeating: " ", count: 24 * 1_024 + 1))
        for json in invalidJSON {
            try rejects({ _ = try AssistToolValue.decodeJSON(json) }, "strict JSON rejection")
        }
        try rejects({ _ = try AssistToolValue.number(.infinity).validated() }, "nonfinite data")
        var deep: AssistToolValue = .number(1)
        for _ in 0..<9 { deep = .array([deep]) }
        try rejects({ _ = try deep.validated() }, "typed tree depth")
        try expect(AssistToolValue.number(5).sendableValue is Int, "integer arguments stay integer in Jinja")
        let planning = try AssistDeviceToolAdapter.planningMessages(request: request, now: now, timeZone: TimeZone(secondsFromGMT: 0)!)
        try rejects({ _ = try AssistDeviceToolAdapter.continuationMessages(messages: planning, call: examples[1], result: .string("{}")) }, "object result required")
        var messages = planning
        for example in Array(examples.prefix(4)) { messages = try AssistDeviceToolAdapter.continuationMessages(messages: messages, call: example, result: .object(["ok": .bool(true)])) }
        try expect(messages.count == planning.count + 4, "one assistant pair per call")
        try expect(messages.suffix(4).allSatisfy { $0["role"] as? String == "assistant" }, "results never become user messages")
        try rejects({ _ = try AssistDeviceToolAdapter.continuationMessages(messages: messages, call: examples[11], result: .object([:])) }, "four pair bound")
        _ = try JSONSerialization.data(withJSONObject: fixture(), options: [.sortedKeys])
        if CommandLine.arguments.dropFirst().first == "--golden-json", CommandLine.arguments.count == 3 {
            let golden = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as? [String: String]
            guard let planningText = golden?["planning"], let continuation = golden?["continuation"], let multi = golden?["multi"] else { throw AssistToolContractError.invalidValue }
            try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(planningText)
            try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(continuation, calls: [examples[1]])
            try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(multi, calls: [examples[1], examples[0], examples[3], examples[11]])
            try rejects({ try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(multi + "<|turn>model\n", calls: [examples[1], examples[0], examples[3], examples[11]]) }, "no unwanted new turn")
        }
        print("PASS: 13 closed tool schemas; strict single-call/boundary grammar; flat typed arguments; UTC/bounds/effects; bounded duplicate-safe JSON; data-marker rejection; four chronological object continuations. Synthetic data only.")
    }
}
