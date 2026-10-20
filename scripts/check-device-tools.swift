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
         call(.device_capabilities), call(.native_boundary, ["feature": .string("systemSettings")]),
         call(.maps_search, ["query": .string("Bibliothèque Québec"), "limit": .number(5)]),
         call(.maps_directions, ["origin_latitude": .number(46.8139), "origin_longitude": .number(-71.2080), "destination_latitude": .number(46.8), "destination_longitude": .number(-71.3), "transport": .string("walking")]),
         call(.weather_forecast, ["latitude": .number(46.8139), "longitude": .number(-71.2080), "unit": .string("celsius"), "hourly_count": .number(12), "daily_count": .number(5)]),
         call(.alarm_list),
         call(.alarm_create, ["kind": .string("timer"), "title": .string("Minuteur"), "duration_seconds": .number(300)]),
         call(.alarm_update, ["alarm_id": .string("12345678-1234-1234-1234-123456789ABC"), "kind": .string("timer"), "title": .string("Minuteur corrigé"), "duration_seconds": .number(60)]),
         call(.alarm_stop, ["alarm_id": .string("12345678-1234-1234-1234-123456789ABC")]),
         call(.alarm_cancel, ["alarm_id": .string("12345678-1234-1234-1234-123456789ABC")]),
         call(.translation_languages, ["source_language": .string(""), "target_language": .string("en")]),
         call(.text_translate, ["text": .string("Bonjour"), "source_language": .string("fr"), "target_language": .string("en"), "allow_download": .bool(false)]),
         call(.document_scan, ["max_pages": .number(8)]),
         call(.document_export_pdf, ["inbox_id": .string("12345678-1234-1234-1234-123456789abc"), "filename": .string("document.pdf")]),
         call(.document_preview, ["inbox_id": .string("12345678-1234-1234-1234-123456789abc")]),
         call(.document_read, ["inbox_id": .string("12345678-1234-1234-1234-123456789abc")]),
         call(.document_search, ["query": .string("Rapport"), "limit": .number(5)]),
         call(.document_index, ["inbox_id": .string("12345678-1234-1234-1234-123456789abc"), "title": .string("Rapport"), "expiration_days": .number(1)]),
         call(.document_unindex, ["inbox_id": .string("12345678-1234-1234-1234-123456789abc")]),
         call(.message_compose, ["channel": .string("email"), "recipients": .string("a@example.test"), "subject": .string("Objet"), "body": .string("Texte exact à vérifier")])]
    }
    static func raw(_ call: AssistDeviceToolCall) -> String {
        let arguments = call.arguments.keys.sorted().map { key in
            let value: String
            switch call.arguments[key]! {
            case .string(let text): value = "<|\"|>\(text)<|\"|>"
            case .number(let number): value = number.rounded() == number ? String(Int(number)) : String(number)
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
        let context = AssistDeviceReferenceContext(turns: [
            .init(user: "Je serai à Québec demain.", assistant: "Le lieu de référence est Québec."),
            .init(user: "Je préfère les trajets à pied.", assistant: "Tu préfères la marche pour cette conversation."),
            .init(user: "Et les températures en Celsius.", assistant: "L’unité mentionnée est Celsius."),
        ], omittedTurns: 2)
        let contextual = try AssistDeviceToolAdapter.planningMessages(request: request, referenceContext: context,
            now: now, timeZone: TimeZone(identifier: "America/Toronto")!)
        let contextualContinuation = try AssistDeviceToolAdapter.continuationMessages(messages: contextual,
            call: examples[1], result: calendarResult)
        let maximumContext = AssistDeviceReferenceContext(turns: [
            .init(user: String(repeating: "a", count: 2_048), assistant: String(repeating: "b", count: 2_048)),
            .init(user: String(repeating: "c", count: 2_047), assistant: String(repeating: "d", count: 2_047)),
            .init(user: "e", assistant: "f"),
        ], omittedTurns: 0)
        let maximal = try AssistDeviceToolAdapter.planningMessages(request: request, referenceContext: maximumContext,
            now: now, timeZone: TimeZone(identifier: "America/Toronto")!)
        return ["planningMessages": planning, "continuationMessages": continuation, "multiMessages": multi,
                "stepPlanningMessages": try AssistDeviceToolAdapter.generationMessages(messages: planning, completedCalls: []),
                "stepContinuationMessages": try AssistDeviceToolAdapter.generationMessages(messages: continuation, completedCalls: [examples[1]]),
                "stepMultiMessages": try AssistDeviceToolAdapter.generationMessages(messages: multi,
                    completedCalls: [examples[1], examples[0], examples[3], examples[11]]),
                "contextPlanningMessages": try AssistDeviceToolAdapter.generationMessages(messages: contextual, completedCalls: []),
                "contextContinuationMessages": try AssistDeviceToolAdapter.generationMessages(messages: contextualContinuation, completedCalls: [examples[1]]),
                "maximumContextMessages": try AssistDeviceToolAdapter.generationMessages(messages: maximal, completedCalls: []),
                "multiNames": ["calendar_list", "contacts_search", "reminders_list", "device_capabilities"],
                "subsetTools": AssistDeviceToolAdapter.closedToolSchema(allowedTools: [.calendar_list]),
                "tools": AssistDeviceToolAdapter.closedToolSchema(), "additionalContext": AssistDeviceToolAdapter.additionalContext,
                "bosToken": "<bos>", "eosToken": "<eos>"]
    }

    /// Exports the compiled registry, not an evaluation oracle. No executor,
    /// permission UI, model weights, network or external state is involved.
    static func evaluationContract() -> [String: Any] {
        ["schemaVersion": 1, "catalogRevision": AssistToolHost.catalogRevision,
         "tools": zip(AssistToolName.allCases, AssistDeviceToolRegistry.definitions).map { name, definition in
             ["name": name.rawValue, "effect": name.effect.rawValue,
              "execution": name.execution, "definition": definition] as [String: Any]
         },
         "limits": ["maximumToolCalls": AssistDeviceToolAdapter.maximumToolCalls,
                    "maximumWrites": AssistDeviceToolAdapter.maximumWrites,
                    "maximumPublicBytes": AssistDeviceToolAdapter.maximumPublicBytes],
         "canonicalTemplateSHA256": AssistDeviceToolAdapter.canonicalTemplateSHA256]
    }

    static func evaluationLine(_ raw: String) throws -> [String: Any] {
        // The real bounded duplicate-key reader runs before any Foundation cast.
        guard let row = try AssistToolValue.decodeJSON(raw).objectDictionary,
              Set(row.keys) == ["schemaVersion", "id", "fixedEnvironment", "prompt", "referenceContext", "calls"],
              row["schemaVersion"]?.integerValue == 1,
              let id = row["id"]?.stringValue, !id.isEmpty, id.utf8.count <= 128,
              let environment = row["fixedEnvironment"]?.objectDictionary,
              Set(environment.keys) == ["nowUTC", "timeZone"],
              let instant = environment["nowUTC"]?.stringValue,
              let zone = environment["timeZone"]?.stringValue, let timeZone = TimeZone(identifier: zone),
              let prompt = row["prompt"]?.stringValue,
              let context = row["referenceContext"], case .array(let calls) = row["calls"],
              calls.count <= 64 else { throw AssistToolContractError.invalidArguments }
        let now = try AssistToolContent.timestamp(instant)
        let host: [String: Any] = ["schemaVersion": 1, "hostProtocolVersion": 3,
            "catalogRevision": AssistToolHost.catalogRevision,
            "requiredTools": AssistToolName.allCases.map { ["id": $0.rawValue, "version": 1] as [String: Any] },
            "profile": "device_context_v1", "requestId": "eval-" + id,
            "messages": [["role": "user", "content": prompt]], "temperature": 0,
            "referenceContext": context.foundationObject]
        let hostJSON = String(decoding: try JSONSerialization.data(withJSONObject: host, options: [.sortedKeys]), as: UTF8.self)
        let selection = try AssistToolHost.selection(from: hostJSON)
        let planning = try AssistDeviceToolAdapter.planningMessages(request: selection.request,
            referenceContext: selection.referenceContext, now: now, timeZone: timeZone)
        let messages = try AssistDeviceToolAdapter.generationMessages(messages: planning, completedCalls: [])
        let results: [[String: Any]] = try calls.map { value in
            guard let call = value.objectDictionary, Set(call.keys) == ["name", "arguments"],
                  let name = call["name"]?.stringValue, let arguments = call["arguments"]?.objectDictionary else {
                throw AssistToolContractError.invalidArguments
            }
            guard let tool = AssistToolName(rawValue: name) else { return ["accepted": false] }
            do {
                let validated = try AssistDeviceToolRegistry.validate(call: .init(name: tool, arguments: arguments), now: now)
                return ["accepted": true, "normalizedArguments": validated.arguments.mapValues(\.foundationObject)]
            } catch { return ["accepted": false] }
        }
        return ["id": id, "inputJSON": raw, "inputAccepted": true,
                "messages": messages, "tools": AssistDeviceToolAdapter.closedToolSchema(allowedTools: selection.allowedTools),
                "additionalContext": AssistDeviceToolAdapter.additionalContext,
                "systemUTF8Bytes": (messages.first?["content"] as? String)?.utf8.count ?? 0,
                "calls": results]
    }

    static func evaluationReport(path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard data.count <= 2 * 1_024 * 1_024,
              let text = String(data: data, encoding: .utf8) else { throw AssistToolContractError.oversizedValue }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        guard !lines.isEmpty, lines.count <= 1_000 else { throw AssistToolContractError.invalidArguments }
        var ids = Set<String>()
        let rows: [[String: Any]] = try lines.map { line in
            let result = try evaluationLine(String(line))
            guard let id = result["id"] as? String, ids.insert(id).inserted else { throw AssistToolContractError.invalidArguments }
            return result
        }
        return ["schemaVersion": 1, "contract": evaluationContract(), "cases": rows,
                "evidence": "compiled_production_validation_and_prompt_preparation_only_no_model_or_tool_execution"]
    }

    static func evaluationChecks() throws {
        func encode(_ value: [String: Any]) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
        }
        let input: [String: Any] = ["schemaVersion": 1, "id": "evaluation-regression",
            "fixedEnvironment": ["nowUTC": "2030-01-15T15:00:00Z", "timeZone": "America/Toronto"],
            "prompt": "Crée un minuteur de dix minutes nommé Test.",
            "referenceContext": ["schemaVersion": 1, "turns": [], "omittedTurns": 0],
            "calls": [["name": "alarm_create", "arguments": ["kind": "timer", "title": "Test", "duration_seconds": 600]]]]
        let result = try evaluationLine(encode(input))
        try expect((result["calls"] as? [[String: Any]])?.first?["accepted"] as? Bool == true, "evaluation calls use real native validation")
        try expect((result["messages"] as? [[String: any Sendable]])?.last?["content"] as? String == input["prompt"] as? String, "evaluation prompt is current request without oracle")
        guard let prepared = result["messages"] as? [[String: any Sendable]] else { throw AssistToolContractError.invalidValue }
        try expect(prepared.filter { $0["role"] as? String == "system" }.count == 1 && prepared.first?["role"] as? String == "system", "one system role in actual preparation")
        try expect(result["systemUTF8Bytes"] as? Int == (prepared.first?["content"] as? String)?.utf8.count, "system byte measurement uses the actual prepared text")
        var referenced = input
        referenced["referenceContext"] = ["schemaVersion": 1, "omittedTurns": 0,
            "turns": [["user": "Demain je prépare un atelier.", "assistant": "Les détails restent une référence."]]]
        let contextual = try evaluationLine(encode(referenced))
        guard let contextualMessages = contextual["messages"] as? [[String: any Sendable]] else { throw AssistToolContractError.invalidValue }
        try expect(contextualMessages.map { $0["role"] as? String } == ["system", "user", "assistant", "user"], "references retain distinct user/assistant roles before the unchanged active request")
        try expect((contextualMessages[1]["content"] as? String)?.hasSuffix("Demain je prépare un atelier.") == true &&
                   (contextualMessages[2]["content"] as? String)?.hasSuffix("Les détails restent une référence.") == true &&
                   contextualMessages.allSatisfy { $0["tool_calls"] == nil && $0["tool_responses"] == nil }, "reference quotations never fabricate a tool receipt")
        let read = call(.biometrics_status)
        let continued = try AssistDeviceToolAdapter.continuationMessages(messages: contextualMessages, call: read,
            result: .object(["available": .bool(true)]), now: now)
        let view = try AssistDeviceToolAdapter.generationMessages(messages: continued, completedCalls: [read])
        try expect(try JSONSerialization.data(withJSONObject: Array(view.prefix(contextualMessages.count)), options: [.sortedKeys]) ==
                   JSONSerialization.data(withJSONObject: contextualMessages, options: [.sortedKeys]), "a completed call leaves the previous structural message prefix unchanged")
        var invalid = input
        invalid["calls"] = [["name": "alarm_create", "arguments": ["kind": "alarm", "title": "Test", "duration_seconds": 600]]]
        let rejected = try evaluationLine(encode(invalid))
        try expect((rejected["calls"] as? [[String: Any]])?.first?["accepted"] as? Bool == false, "native conditional constraint is not just JSON schema")
        invalid = input; invalid["oracle"] = "must never enter model input"
        try rejects({ _ = try evaluationLine(encode(invalid)) }, "evaluation oracle field must fail closed")
        invalid = input; invalid["fixedEnvironment"] = ["nowUTC": "2030-02-30T15:00:00Z", "timeZone": "America/Toronto"]
        try rejects({ _ = try evaluationLine(encode(invalid)) }, "evaluation clock must be a real UTC timestamp")
        invalid = input; invalid["fixedEnvironment"] = ["nowUTC": "2030-01-15T15:00:00Z", "timeZone": "invented/timezone"]
        try rejects({ _ = try evaluationLine(encode(invalid)) }, "evaluation timezone cannot be invented")
        invalid = input; invalid["referenceContext"] = ["schemaVersion": 1, "omittedTurns": 0,
            "turns": [["user": "ID 12345678-1234-1234-1234-123456789abc", "assistant": "Ancien document."]]]
        try rejects({ _ = try evaluationLine(encode(invalid)) }, "evaluation context passes real Host3 privacy policy")
        let raw = try encode(input)
        try rejects({ _ = try evaluationLine(raw.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":1,\"schemaVersion\":1")) }, "evaluation duplicate decoded keys cannot be hidden")
    }

    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--evaluation-contract" {
            print(String(decoding: try JSONSerialization.data(withJSONObject: evaluationContract(), options: [.sortedKeys]), as: UTF8.self)); return
        }
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--prepare-evaluation" {
            print(String(decoding: try JSONSerialization.data(withJSONObject: evaluationReport(path: CommandLine.arguments[2]), options: [.sortedKeys]), as: UTF8.self)); return
        }
        if CommandLine.arguments.dropFirst().first == "--fixture-json" {
            print(String(decoding: try JSONSerialization.data(withJSONObject: fixture(), options: [.sortedKeys]), as: UTF8.self)); return
        }
        try evaluationChecks()
        try expect(AssistToolName.allCases.count == 31 && Set(examples.map(\.name)) == Set(AssistToolName.allCases), "all thirty-one tools covered")
        let schemas = AssistDeviceToolRegistry.definitions
        try expect(schemas.count == 31, "thirty-one explicit definitions")
        try expect(AssistDeviceToolAdapter.closedToolSchema().count == 31, "v1 schema default remains complete")
        func parameter(_ tool: AssistToolName, _ key: String) throws -> [String: Any] {
            let schema = schemas[AssistToolName.allCases.firstIndex(of: tool)!]
            guard let function = schema["function"] as? [String: Any],
                  let parameters = function["parameters"] as? [String: Any],
                  let properties = parameters["properties"] as? [String: Any],
                  let value = properties[key] as? [String: Any] else { throw AssistToolContractError.invalidValue }
            return value
        }
        // The canonical Gemma template omits minimum/maximum/maxLength. These
        // checks protect the operational facts that must survive in text.
        for (key, bounds) in [("hourly_count", "0 à 12"), ("daily_count", "0 à 5")] {
            let detail = try parameter(.weather_forecast, key)["description"] as? String ?? ""
            try expect(detail.contains(bounds) && detail.contains("0 exclut") && detail.contains("conditions courantes"),
                       "current-only weather and numeric bounds survive in the model-visible description")
        }
        for name in [AssistToolName.alarm_create, .alarm_update] {
            try expect(try parameter(name, "kind")["enum"] as? [String] == ["alarm", "timer"], "alarm/timer choices survive Gemma rendering")
            let duration = try parameter(name, "duration_seconds")["description"] as? String ?? ""
            try expect(duration.contains("86400") && duration.contains("secondes") && duration.contains("minutes"), "timer bounds and conversion are visible to Gemma")
        }
        try expect(try parameter(.message_compose, "channel")["enum"] as? [String] == ["email", "sms"], "composer channel enum survives rendering")
        let scan = try parameter(.document_scan, "max_pages")["description"] as? String ?? ""
        try expect(scan.contains("1 à 8"), "scanner page bounds survive rendering")
        let expiry = try parameter(.document_index, "expiration_days")["description"] as? String ?? ""
        try expect(expiry.contains("1 à 7 jours"), "temporary index lifetime survives rendering")
        for name in AssistToolName.allCases where name.isExtended {
            for field in AssistExtendedToolsPolicy.fields(name) {
                let detail = try parameter(name, field.key)["description"] as? String ?? ""
                try expect(!detail.isEmpty, "extended parameter has model-visible meaning: \(name).\(field.key)")
            }
        }
        for (name, schema) in zip(AssistToolName.allCases, schemas) {
            guard let function = schema["function"] as? [String: Any], let parameters = function["parameters"] as? [String: Any] else {
                throw AssistToolContractError.invalidValue
            }
            try expect(function["name"] as? String == name.rawValue, "closed name \(name)")
            try expect(parameters["additionalProperties"] as? Bool == false, "no unknown properties \(name)")
            try expect(parameters["type"] as? String == "object" && parameters["properties"] is [String: Any], "explicit object schema")
        }
        for example in examples {
            do {
                try expect(try AssistDeviceToolAdapter.parse(raw: raw(example), stoppedAtToolResponse: true, now: now) == .call(example), "exact call \(example.name)")
            } catch {
                throw NSError(domain: "DeviceToolChecks", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed closed-schema example \(example.name.rawValue): \(error)"])
            }
            try rejects({ _ = try AssistDeviceToolAdapter.parse(raw: raw(example), stoppedAtToolResponse: false, now: now) }, "no call without observed token50")
            var unknown = example.arguments; unknown["calendarId"] = .string("model-chosen")
            try rejects({ _ = try AssistDeviceToolRegistry.validate(call: call(example.name, unknown), now: now) }, "host-only destination rejected \(example.name)")
        }
        try expect(AssistToolName.allCases.filter { $0.effect == .write } == [.calendar_create, .reminder_create, .notification_schedule, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel, .document_index, .document_unindex], "exact write classification")
        try expect(Set(AssistToolName.allCases.filter { $0.effect == .interactive }) == [.photo_select, .camera_capture, .biometrics_authenticate, .text_translate, .document_scan, .document_export_pdf, .document_preview, .message_compose], "exact interactive classification")
        let trimmed = call(.contacts_search, ["query": .string(" \nÉquipe \t"), "limit": .number(1)])
        try expect(try AssistDeviceToolRegistry.validate(call: trimmed, now: now).arguments["query"] == .string("Équipe"), "query normalized before host preview")
        for invalid in [
            call(.maps_search, ["query": .string("Québec\nParis"), "limit": .number(1)]),
            call(.maps_directions, ["origin_latitude": .number(91), "origin_longitude": .number(0), "destination_latitude": .number(0), "destination_longitude": .number(0), "transport": .string("walking")]),
            call(.maps_directions, ["origin_latitude": .number(0), "origin_longitude": .number(0), "destination_latitude": .number(0), "destination_longitude": .number(0), "transport": .string("transit")]),
            call(.weather_forecast, ["latitude": .number(0), "longitude": .number(0), "unit": .string("celsius"), "hourly_count": .number(13), "daily_count": .number(5)]),
            call(.weather_forecast, ["latitude": .number(0), "longitude": .number(0), "unit": .string("celsius"), "hourly_count": .number(1.5), "daily_count": .number(5)]),
        ] { try rejects({ _ = try AssistDeviceToolRegistry.validate(call: invalid) }, "closed Apple coordinates/counts/transport") }
        try expect(AssistToolName.legacyCases.count == 13, "legacy registry stays thirteen")
        try expect(AssistToolName.allCases.filter { $0.execution == "apple_network" } == [.maps_search, .maps_directions, .weather_forecast], "Apple network execution is explicit")
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
        // The broker may return after a short alarm's scheduled instant. Its
        // completed call is evidence, not a new proposal to schedule in the past.
        let pastAlarmISO = AssistToolContent.iso(now.addingTimeInterval(-1))
        for name in [AssistToolName.alarm_create, .alarm_update] {
            var arguments: [String: AssistToolValue] = ["kind": .string("alarm"), "title": .string("Alarme déjà programmée"), "date_iso": .string(pastAlarmISO)]
            if name == .alarm_update { arguments["alarm_id"] = .string("12345678-1234-1234-1234-123456789ABC") }
            let completedCall = call(name, arguments)
            _ = try AssistDeviceToolRegistry.validate(call: completedCall, now: now.addingTimeInterval(-60))
            try rejects({ _ = try AssistDeviceToolRegistry.validate(call: completedCall, now: now) }, "fresh past alarm admission rejected \(name)")
            try rejects({ _ = try AssistDeviceToolAdapter.parse(raw: raw(completedCall), stoppedAtToolResponse: true, now: now) }, "fresh past alarm proposal rejected \(name)")
            let receipt: AssistToolValue = .object(["result_status": .string("succeeded"), "appOwnedOnly": .bool(true)])
            let historical = try AssistDeviceToolAdapter.continuationMessages(messages: planning, call: completedCall, result: receipt, now: now)
            try expect(historical.count == planning.count + 1 && historical.last?["tool_responses"] != nil,
                       "completed past alarm reinjected once without new admission \(name)")
            var invalidArguments = arguments; invalidArguments["title"] = .string("")
            try rejects({ _ = try AssistDeviceToolAdapter.continuationMessages(messages: planning, call: call(name, invalidArguments), result: receipt, now: now) }, "historical alarm still validates static arguments \(name)")
        }
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
            guard let subsetPlanning = golden?["subsetPlanning"], let subsetContinuation = golden?["subsetContinuation"] else {
                throw AssistToolContractError.invalidValue
            }
            try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(subsetPlanning, allowedTools: [.calendar_list])
            try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(subsetContinuation, calls: [examples[1]], allowedTools: [.calendar_list])
            try rejects({ try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(planningText, allowedTools: [.calendar_list]) }, "extra declarations rejected for subset")
            try rejects({ try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(subsetPlanning) }, "v1 still requires complete catalogue")
            try rejects({ try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(subsetContinuation, calls: [examples[0]], allowedTools: [.calendar_list]) }, "unselected continuation rejected")
        }
        print("PASS: 31 closed tool schemas; strict single-call/boundary grammar; flat typed arguments; UTC/bounds/effects; bounded duplicate-safe JSON; data-marker rejection; historical completed alarms without fresh past admission; four chronological object continuations. Synthetic data only.")
    }
}
