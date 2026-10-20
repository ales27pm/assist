import Foundation

@main
struct ToolHostChecks {
    static func main() throws {
        var checks = 0
        func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
            guard try condition() else { throw AssistInferenceError.invalid("FAIL: \(message)") }
            checks += 1
        }
        func rejects(_ json: String) throws {
            do { _ = try AssistToolHost.selection(from: json) }
            catch { checks += 1; return }
            throw AssistInferenceError.invalid("FAIL: unsafe host selection accepted")
        }
        let valid = #"{"schemaVersion":1,"hostProtocolVersion":2,"catalogRevision":"device-v3-31","requiredTools":[{"id":"calendar_list","version":1}],"profile":"device_v1","requestId":"host-fixture","messages":[{"role":"user","content":"Quels événements demain matin ?"}],"temperature":0,"maxTokens":256}"#
        let selection = try AssistToolHost.selection(from: valid)
        try expect(selection.allowedTools == [.calendar_list], "one selected compiled capability")
        try expect(selection.request.requestId == "host-fixture" && selection.request.maxTokens == 256,
                   "isolated generation request preserved")
        try expect(selection.request.messages.count == 1 && selection.request.temperature == 0,
                   "no history or mutable generation policy")
        let withoutBudget = valid.replacingOccurrences(of: ",\"maxTokens\":256", with: "")
        try expect(try AssistToolHost.selection(from: withoutBudget).request.maxTokens == nil,
                   "output budget may be omitted")
        let allTools = AssistToolName.allCases.map { "{\"id\":\"\($0.rawValue)\",\"version\":1}" }.joined(separator: ",")
        let all = valid.replacingOccurrences(of: #"[{"id":"calendar_list","version":1}]"#, with: "[" + allTools + "]")
        try expect(try AssistToolHost.selection(from: all).allowedTools == Set(AssistToolName.allCases),
                   "full known catalogue remains selectable")

        var invalid: [String] = [
            valid.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":true"),
            valid.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":2"),
            valid.replacingOccurrences(of: "\"hostProtocolVersion\":2", with: "\"hostProtocolVersion\":true"),
            valid.replacingOccurrences(of: "\"hostProtocolVersion\":2", with: "\"hostProtocolVersion\":1"),
            valid.replacingOccurrences(of: "\"catalogRevision\":\"device-v3-31\"", with: "\"catalogRevision\":\"stale\""),
            valid.replacingOccurrences(of: "\"profile\":\"device_v1\"", with: "\"profile\":\"research_v1\""),
            valid.replacingOccurrences(of: "\"profile\":\"device_v1\"", with: "\"profile\":\"all\""),
            valid.replacingOccurrences(of: #"[{"id":"calendar_list","version":1}]"#, with: "[]"),
            valid.replacingOccurrences(of: #"[{"id":"calendar_list","version":1}]"#, with: "null"),
            valid.replacingOccurrences(of: #"[{"id":"calendar_list","version":1}]"#, with: #""calendar_list""#),
            valid.replacingOccurrences(of: #"[{"id":"calendar_list","version":1}]"#, with: #"[{"id":"calendar_list","version":1},{"id":"calendar_list","version":1}]"#),
            valid.replacingOccurrences(of: "\"id\":\"calendar_list\"", with: "\"id\":\"calendar_delete\""),
            valid.replacingOccurrences(of: "\"id\":\"calendar_list\"", with: "\"id\":\"web_search\""),
            valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":true"),
            valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"),
            valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":null"),
            valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"effect\":\"read\""),
            valid.replacingOccurrences(of: "\"temperature\":0", with: "\"temperature\":false"),
            valid.replacingOccurrences(of: "\"temperature\":0", with: "\"temperature\":1"),
            valid.replacingOccurrences(of: "\"maxTokens\":256", with: "\"maxTokens\":true"),
            valid.replacingOccurrences(of: "\"maxTokens\":256", with: "\"maxTokens\":1025"),
            valid.replacingOccurrences(of: "\"maxTokens\":256", with: "\"maxTokens\":0"),
            valid.replacingOccurrences(of: "\"maxTokens\":256", with: "\"maxTokens\":1.5"),
            valid.replacingOccurrences(of: "\"maxTokens\":256", with: "\"maxTokens\":null"),
            valid.replacingOccurrences(of: "\"role\":\"user\"", with: "\"role\":\"assistant\""),
            valid.replacingOccurrences(of: "\"role\":\"user\"", with: "\"role\":\"user\",\"tool_calls\":[]"),
            valid.replacingOccurrences(of: #"[{"role":"user","content":"Quels événements demain matin ?"}]"#,
                with: #"[{"role":"user","content":"premier"},{"role":"user","content":"autre"}]"#),
            valid.replacingOccurrences(of: "Quels événements demain matin ?", with: ""),
            valid.replacingOccurrences(of: "Quels événements demain matin ?", with: "  "),
            valid.replacingOccurrences(of: "Quels événements demain matin ?", with: "Texte <|tool_call>"),
            valid.replacingOccurrences(of: "\"requestId\":\"host-fixture\"", with: "\"requestId\":\"\""),
            valid.replacingOccurrences(of: "host-fixture", with: String(repeating: "é", count: 65)),
            valid.replacingOccurrences(of: "host-fixture", with: #"bad\u0000id"#),
            valid.replacingOccurrences(of: "host-fixture", with: #"bad\nid"#),
            valid.replacingOccurrences(of: "host-fixture", with: #"bad\tid"#),
            valid.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":1,\"confirmation\":\"never\""),
            valid.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":1,\"schemaVersion\":1"),
            valid.replacingOccurrences(of: "\"schemaVersion\":1", with: #""schemaVersion":1,"\u0073chemaVersion":1"#),
            valid.replacingOccurrences(of: "\"version\":1", with: #""version":1,"\u0076ersion":1"#),
            valid.replacingOccurrences(of: "\"role\":\"user\"", with: #""role":"user","\u0072ole":"user""#),
            String(valid.dropLast()), valid + " false", "[]", "null", String(repeating: " ", count: 24 * 1_024 + 1),
        ]
        invalid.append(valid.replacingOccurrences(of: "Quels événements demain matin ?", with: String(repeating: "a", count: 8_193)))
        invalid.append(valid.replacingOccurrences(of: "Quels événements demain matin ?", with: String(repeating: "é", count: 4_097)))
        invalid.append(valid.replacingOccurrences(of: #"[{"id":"calendar_list","version":1}]"#,
            with: "[" + Array(repeating: #"{"id":"calendar_list","version":1}"#, count: 14).joined(separator: ",") + "]"))
        for json in invalid { try rejects(json) }
        for field in ["schemaVersion", "hostProtocolVersion", "catalogRevision", "requiredTools", "profile", "requestId", "messages", "temperature"] {
            var object = try JSONSerialization.jsonObject(with: Data(valid.utf8)) as! [String: Any]
            object.removeValue(forKey: field)
            try rejects(String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self))
        }

        let capabilities = try AssistToolValue.decodeJSON(AssistToolHost.capabilitiesJSON()).objectDictionary!
        try expect(Set(capabilities.keys) == ["schemaVersion", "hostProtocolVersions", "policyVersion", "catalogRevision", "confirmation", "tools"],
                   "capabilities expose no runtime, server or unimplemented profile")
        try expect(capabilities["schemaVersion"] == .number(1) && capabilities["hostProtocolVersions"] == .array([.number(2)]),
                   "envelope and host protocol are distinct versions")
        try expect(capabilities["policyVersion"] == .number(1) && capabilities["catalogRevision"] == .string("device-v3-31"),
                   "exact compiled policy and catalogue revision")
        try expect(capabilities["confirmation"] == .string("all_accesses"), "native consent policy unchanged")
        guard case .array(let descriptors) = capabilities["tools"] else { throw AssistToolContractError.invalidValue }
        try expect(descriptors.count == AssistToolName.allCases.count, "only implemented native tools advertised")
        for (name, descriptor) in zip(AssistToolName.allCases, descriptors) {
            try expect(descriptor == .object(["id": .string(name.rawValue), "version": .number(1),
                "effect": .string(name.effect.rawValue), "execution": .string(name.execution), "availability": .string("available")]),
                "native descriptor \(name.rawValue) means compiled, not permission")
        }

        let schemas = AssistDeviceToolAdapter.closedToolSchema(allowedTools: [.calendar_list])
        try expect(schemas.count == 1 && (schemas[0]["function"] as? [String: any Sendable])?["name"] as? String == "calendar_list",
                   "schema contains only selected native declaration")
        let calendar = "<|tool_call>call:calendar_list{start_iso:<|\"|>2026-10-19T12:00:00Z<|\"|>,end_iso:<|\"|>2026-10-19T16:00:00Z<|\"|>,limit:5}<tool_call|>"
        guard case .call(let calendarCall) = try AssistDeviceToolAdapter.parse(raw: calendar, stoppedAtToolResponse: true,
            allowedTools: [.calendar_list]) else { throw AssistToolContractError.invalidOutput }
        checks += 1
        let declaration = "<|tool>declaration:calendar_list{}<tool|>"
        let planning = "<bos><|turn>system\n" + declaration + "<turn|>\n<|turn>user\nQuestion<turn|>\n<|turn>model\n"
        try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(planning, allowedTools: [.calendar_list])
        checks += 1
        for text in [
            planning.replacingOccurrences(of: declaration, with: ""),
            planning.replacingOccurrences(of: declaration, with: declaration + declaration),
            planning.replacingOccurrences(of: declaration, with: declaration + "<|tool>declaration:device_capabilities{}<tool|>"),
            planning.replacingOccurrences(of: declaration, with: declaration + "<|tool>declaration:not_allowed{}<tool|>"),
            planning.replacingOccurrences(of: declaration, with: declaration + "<|tool>declaration:unknown1{}<tool|>"),
        ] {
            do { try AssistDeviceToolAdapter.validateRenderedPlanningPrompt(text, allowedTools: [.calendar_list]) }
            catch { checks += 1; continue }
            throw AssistInferenceError.invalid("FAIL: rendered declaration scope widened")
        }
        let continuation = planning.replacingOccurrences(of: "<|turn>model\n", with:
            "<|turn>model\n" + calendar + "<|tool_response>response:calendar_list{events:[]}<tool_response|>")
        try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(continuation, calls: [calendarCall],
            allowedTools: [.calendar_list])
        checks += 1
        do {
            try AssistDeviceToolAdapter.validateRenderedContinuationPrompt(continuation, calls: [calendarCall],
                allowedTools: [.device_capabilities])
        } catch {
            checks += 1
            print("PASS: \(checks) Tool Host v2 capability/selection/scope checks; no model, permission or device access")
            return
        }
        throw AssistInferenceError.invalid("FAIL: unselected continuation accepted")
    }
}
