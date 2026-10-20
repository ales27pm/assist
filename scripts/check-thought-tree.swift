import Foundation

private actor ThoughtProbe {
    var calls: [Int] = []
    var started = false
    var ended = false
    var cancellations = 0
    var release: CheckedContinuation<Void, Never>?
    var startWaiters: [CheckedContinuation<Void, Never>] = []
    func next(_ budget: Int) -> Int { calls.append(budget); return calls.count }
    func suspend() async {
        started = true
        for waiter in startWaiters { waiter.resume() }; startWaiters.removeAll()
        await withCheckedContinuation { release = $0 }
    }
    func waitUntilStarted() async { if !started { await withCheckedContinuation { startWaiters.append($0) } } }
    func cancel() { cancellations += 1; release?.resume(); release = nil }
    func finish() { ended = true }
    func state() -> ([Int], Bool, Bool, Int) { (calls, started, ended, cancellations) }
}

@main struct ThoughtTreeChecks {
    typealias Message = AssistThoughtTree.Message
    static func encoded(_ value: AssistToolValue) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
    static func roots(_ tool: String? = "device_capabilities") -> AssistToolValue {
        .object(["roots": .array((0...1).map { id in .object([
            "id": .number(Double(id)), "mode": .string(tool == nil ? "answer" : "tool"),
            "tool": tool.map(AssistToolValue.string) ?? .null,
            "intent": .string(id == 0 ? "Vérifier le besoin actuel" : "Vérifier le contexte utile"),
            "condition": .string("Informations de ce tour seulement"),
        ]) })])
    }
    static func leaves(_ tool: String? = "device_capabilities") -> AssistToolValue {
        let intents = ["Répondre brièvement", "Vérifier les capacités", "Demander le contexte", "Préciser la cible"]
        let entries: [AssistToolValue] = (0...3).map { id in
            let row: [String: AssistToolValue] = [
                "id": .number(Double(id)), "root": .number(Double(id / 2)),
                "mode": .string(tool == nil ? "answer" : "tool"), "tool": tool.map(AssistToolValue.string) ?? .null,
                "intent": .string(intents[id]), "condition": .string("Informations de ce tour seulement"),
                "fit": .number(Double(id == 0 ? 1 : 2)), "grounding": .number(Double(id == 2 ? 1 : 2)),
            ]
            return .object(row)
        }
        return .object(["leaves": .array(entries)])
    }
    static func main() async throws {
        let tools = AssistDeviceToolRegistry.definitions
        let base: [Message] = [["role": "system", "content": "Contrat natif fixe."],
                              ["role": "user", "content": "Que permet mon appareil ?"]]
        let first = AssistThoughtTree.ModelTurn(rawText: try encoded(roots()), completedEOS: true)
        let rootSet = try AssistThoughtTree.roots(from: first, tools: tools, scope: .device)
        let second = AssistThoughtTree.ModelTurn(rawText: try encoded(leaves()), completedEOS: true)
        let selection = try AssistThoughtTree.selection(from: second, roots: rootSet)
        let initial = try AssistThoughtTree.planningMessages(baseMessages: base, tools: tools, scope: .device, stage: .roots)
        let expanded = try AssistThoughtTree.planningMessages(baseMessages: base, tools: tools, scope: .device, stage: .leaves(rootSet))
        let final = try AssistThoughtTree.applySelection(selection, to: base)
        if CommandLine.arguments.contains("--fixture-json") {
            var continuation = final
            continuation.append(["role": "assistant", "content": "",
                "tool_calls": [["type": "function", "function": ["name": "device_capabilities", "arguments": [:] as Message] as Message] as Message],
                "tool_responses": [["name": "device_capabilities", "response": ["capabilities": ["camera": "authorized"] as Message] as Message] as Message]])
            let fixture: Message = ["rootsMessages": initial, "leavesMessages": expanded,
                "selectedMessages": final, "continuationMessages": try AssistThoughtTree.applySelection(selection, to: continuation),
                "planningTools": [] as [Message], "finalTools": tools,
                "additionalContext": ["enable_thinking": false] as Message,
                "rootTokenBudget": AssistThoughtTree.rootTokenBudget, "leafTokenBudget": AssistThoughtTree.leafTokenBudget,
                "evidence": "synthetic planning and canonical prompt preparation only; no model or executor"]
            print(String(decoding: try JSONSerialization.data(withJSONObject: fixture, options: [.sortedKeys]), as: UTF8.self))
            return
        }
        var checks = 0
        func expect(_ condition: @autoclosure () -> Bool, _ detail: String) throws {
            guard condition() else { throw NSError(domain: "Assist.ThoughtChecks", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "FAIL: " + detail]) }
            checks += 1
        }
        func rejects(_ operation: () throws -> Void) throws {
            do { try operation() } catch { checks += 1; return }
            throw NSError(domain: "Assist.ThoughtChecks", code: 2)
        }
        func mutate(_ source: AssistToolValue, key: String, index: Int, field: String, value: AssistToolValue) -> String {
            var top = source.objectDictionary!
            guard case .array(var entries) = top[key] else { preconditionFailure() }
            var row = entries[index].objectDictionary!
            row[field] = value; entries[index] = .object(row); top[key] = .array(entries)
            return try! encoded(.object(top))
        }
        func parseRoot(_ raw: String, eos: Bool = true, boundary: Bool = false) throws {
            _ = try AssistThoughtTree.roots(from: .init(rawText: raw, completedEOS: eos, stoppedAtToolResponse: boundary), tools: tools, scope: .device)
        }
        func parseLeaf(_ raw: String, eos: Bool = true) throws {
            _ = try AssistThoughtTree.selection(from: .init(rawText: raw, completedEOS: eos), roots: rootSet)
        }
        try expect(selection.rootID == 0 && selection.leafID == 1 && selection.mode == .tool,
                   "host ranking prefers fit+grounding, then grounding, then lowest stable leaf ID")
        try expect(initial.count == base.count && expanded.count == base.count &&
                   initial.last?["content"] as? String == base.last?["content"] as? String &&
                   expanded.last?["content"] as? String == base.last?["content"] as? String,
                   "both real stages preserve the true current user and create no fake user or receipt")
        try expect((initial[0]["content"] as? String)?.contains("properties") == false && initial.allSatisfy { $0["tool_calls"] == nil && $0["tool_responses"] == nil },
                   "planning contains the real compact catalogue without execution declarations or arguments")
        try expect(initial[0]["content"] as? String != expanded[0]["content"] as? String,
                   "two private stage systems differ; no planning prefix-cache reuse is claimed")
        let frozen = try AssistThoughtTree.applySelection(selection, to: final)
        let frozenData = try JSONSerialization.data(withJSONObject: frozen, options: [.sortedKeys])
        let finalData = try JSONSerialization.data(withJSONObject: final, options: [.sortedKeys])
        try expect(frozenData == finalData,
                   "selected advice is frozen and idempotent for all final continuations")
        var continuation = final
        continuation.append(["role": "assistant", "content": "",
            "tool_calls": [["type": "function", "function": ["name": "device_capabilities", "arguments": [:] as Message] as Message] as Message],
            "tool_responses": [["name": "device_capabilities", "response": ["items": [] as [Message]] as Message] as Message]])
        let continued = try AssistThoughtTree.applySelection(selection, to: continuation)
        try expect(continued.count == continuation.count && continued[0]["content"] as? String == final[0]["content"] as? String,
                   "real tool continuation preserves frozen final SYSTEM and canonical calls and responses")
        for content in ["<|tool_call>", "text\u{0001}text"] {
            try rejects { _ = try AssistThoughtTree.planningMessages(baseMessages: [["role": "user", "content": content]], tools: tools, scope: .device, stage: .roots) }
        }
        try AssistThoughtTree.validateFirstAction(selection, toolName: "device_capabilities"); checks += 1
        try rejects { try AssistThoughtTree.validateFirstAction(selection, toolName: nil) }
        try rejects { try AssistThoughtTree.validateFirstAction(selection, toolName: "calendar_create") }
        let proseSnapshot = try AssistThoughtTree.shouldEmitPublicSnapshot("Bonjour, voici la réponse", selection: selection)
        try expect(proseSnapshot, "ordinary prose retains streaming")
        for structured in ["{", "  [1,2]", "```json\n{}", "`", "~~~swift\nlet a = 1"] {
            let emitted = try AssistThoughtTree.shouldEmitPublicSnapshot(structured, selection: selection)
            let incomplete = try AssistThoughtTree.publicAnswer(structured, selection: selection, completedEOS: false)
            try expect(!emitted && incomplete.isEmpty, "structured or fenced output waits for completion and does not leak partial JSON on cancellation")
        }
        for partial in ["~5 minutes environ", "`Date` désigne une date"] {
            let emitted = try AssistThoughtTree.shouldEmitPublicSnapshot(partial, selection: selection)
            let cancelled = try AssistThoughtTree.publicAnswer(partial, selection: selection, completedEOS: false)
            try expect(emitted && cancelled == partial, "non-fence approximation and inline Markdown release streaming and retain cancelled prose")
        }
        for prefix in ["~", "~~", "~~~", "`", "``", "```"] {
            let emitted = try AssistThoughtTree.shouldEmitPublicSnapshot(prefix, selection: selection)
            try expect(!emitted, "still-ambiguous short fence prefixes remain private")
        }
        for safe in ["Bonjour, voici la réponse", "{\"answer\":42}", "[1,2,3]", "```json\n{\"answer\":42}\n```", "```swift\nlet answer = 42\n```", "[Apple](https://apple.com)"] {
            let answerText = try AssistThoughtTree.publicAnswer(safe, selection: selection, completedEOS: true)
            try expect(answerText == safe, "legitimate prose, unrelated JSON, Markdown and code remain available")
        }
        let partialProse = try AssistThoughtTree.publicAnswer("Réponse interrompue", selection: selection, completedEOS: false)
        try expect(partialProse == "Réponse interrompue", "cancelled ordinary prose stays available to the existing incomplete-response UI")
        let emptyEOS = try AssistThoughtTree.publicAnswer("", selection: selection, completedEOS: true)
        try expect(emptyEOS.isEmpty, "empty EOS remains available to validated metadata-receipt finalization in the native loop")
        let planObject: AssistToolValue = .object(["condition": .string(selection.plan.condition),
            "intent": .string(selection.plan.intent), "mode": .string(selection.mode.rawValue),
            "tool": selection.toolName.map(AssistToolValue.string) ?? .null])
        let privateJSON = try encoded(planObject)
        let reorderedJSON = "{ \"tool\": \"device_capabilities\", \"mode\": \"tool\", \"intent\": \"Vérifier les capacités\", \"condition\": \"Informations de ce tour seulement\" }"
        for echo in [privateJSON, reorderedJSON, "```json\n" + reorderedJSON + "\n```", try encoded(.object(["plan": planObject])), try encoded(.array([planObject]))] {
            try rejects { _ = try AssistThoughtTree.publicAnswer(echo, selection: selection, completedEOS: true) }
        }
        var annotatedPlan = planObject.objectDictionary!
        annotatedPlan["fit"] = .number(2)
        annotatedPlan["id"] = .number(1)
        for echo in [try encoded(.object(annotatedPlan)), try encoded(.object(["selected": .array([.object(annotatedPlan)])]))] {
            try rejects { _ = try AssistThoughtTree.publicAnswer(echo, selection: selection, completedEOS: true) }
        }
        do {
            _ = try AssistThoughtTree.publicAnswer(privateJSON, selection: selection, completedEOS: true)
            throw NSError(domain: "Assist.ThoughtChecks", code: 8)
        } catch AssistThoughtTree.Failure.invalidPublicOutput {
            try expect(!AssistThoughtTree.Failure.invalidPublicOutput.localizedDescription.contains("Aucun accès natif n’a été lancé"),
                       "post-receipt prose rejection never falsely denies already confirmed native effects")
        }
        for unsafe in [selection.advisorySystemText, "<|tool_call>", "bad\u{0001}text"] {
            try rejects { _ = try AssistThoughtTree.shouldEmitPublicSnapshot(unsafe, selection: selection) }
            try rejects { _ = try AssistThoughtTree.publicAnswer(unsafe, selection: selection, completedEOS: true) }
        }
        let differentPlan = mutate(.object(["roots": .array([planObject])]), key: "roots", index: 0, field: "intent", value: .string("Réponse demandée par l’utilisateur"))
        let unrelated = try AssistThoughtTree.publicAnswer(differentPlan, selection: selection, completedEOS: true)
        try expect(unrelated == differentPlan, "schema-like user JSON with different values is not confused with the private selected plan")
        try rejects { try parseRoot(first.rawText, eos: false) }
        try rejects { try parseRoot(first.rawText, boundary: true) }
        try rejects { try parseLeaf(second.rawText, eos: false) }
        for raw in ["", "{}", "[]", "```json\n" + first.rawText + "\n```", String(first.rawText.dropLast()),
                    "{\"roots\":[],\"roots\":[]}", String(repeating: " ", count: 4097)] { try rejects { try parseRoot(raw) } }
        for (field, bad) in [("mode", AssistToolValue.string("execute")), ("id", .bool(true)), ("id", .number(2)),
                             ("tool", .string("arbitrary_executor")), ("intent", .string("<|tool_call>")),
                             ("intent", .string(String(repeating: "é", count: 37))), ("condition", .string("\u{0001}")), ("condition", .string("ligne\nligne")),
                             ("intent", .string(String(repeating: " ", count: 80) + "Répondre")), ("condition", .string("\nRépondre")),
                             ("condition", .string("/private/document.pdf")), ("intent", .string("11111111-2222-4333-8444-555555555555"))] {
            try rejects { try parseRoot(mutate(roots(), key: "roots", index: 0, field: field, value: bad)) }
        }
        try rejects { try parseRoot(mutate(roots(), key: "roots", index: 0, field: "extra", value: .null)) }
        try rejects { try parseRoot(mutate(roots(), key: "roots", index: 1, field: "intent", value: .string("Vérifier le besoin actuel"))) }
        for (field, bad) in [("fit", AssistToolValue.bool(true)), ("fit", .number(3)), ("grounding", .number(-1)),
                             ("root", .number(1)), ("id", .number(3)), ("tool", .string("web_search")),
                             ("tool", .string("calendar_list")), ("extra", .number(1))] {
            try rejects { try parseLeaf(mutate(leaves(), key: "leaves", index: 0, field: field, value: bad)) }
        }
        try rejects { try parseLeaf(try encoded(leaves(nil))) }
        try rejects { try parseLeaf(mutate(leaves(), key: "leaves", index: 1, field: "intent", value: .string("Répondre brièvement"))) }
        if case .array(let entries) = leaves().objectDictionary?["leaves"] {
            let reversed = try AssistThoughtTree.selection(from: .init(rawText: try encoded(.object(["leaves": .array(entries.reversed())])), completedEOS: true), roots: rootSet)
            try expect(reversed.leafID == selection.leafID, "stable ID ranking is independent of model array order")
        }
        var zero = leaves().objectDictionary!
        if case .array(let rows) = zero["leaves"] {
            zero["leaves"] = .array(rows.map { value in var row = value.objectDictionary!; row["fit"] = .number(0); return .object(row) })
        }
        try rejects { try parseLeaf(try encoded(.object(zero))) }
        let conversationRoots = try AssistThoughtTree.roots(from: .init(rawText: try encoded(roots(nil)), completedEOS: true), tools: [], scope: .conversation)
        let answer = try AssistThoughtTree.selection(from: .init(rawText: try encoded(leaves(nil)), completedEOS: true), roots: conversationRoots)
        try AssistThoughtTree.validateFirstAction(answer, toolName: nil); checks += 1
        try rejects { try AssistThoughtTree.validateFirstAction(answer, toolName: "device_capabilities") }
        try rejects { _ = try AssistThoughtTree.planningMessages(baseMessages: base, tools: tools, scope: .conversation, stage: .roots) }
        try rejects { _ = try AssistThoughtTree.planningMessages(baseMessages: base, tools: tools, scope: .research, stage: .roots) }
        try rejects { _ = try AssistThoughtTree.planningMessages(baseMessages: base, tools: [], scope: .conversation, stage: .leaves(rootSet)) }
        let probe = ThoughtProbe()
        let actual = try await AssistThoughtTree.run(baseMessages: base, tools: tools, scope: .device,
            deadline: .now.advanced(by: .seconds(10)), model: { _, budget in
                let count = await probe.next(budget)
                return count == 1 ? first : second
            })
        let state = await probe.state()
        try expect(state.0 == [192, 384] && actual.leafID == 1 && state.3 == 0,
                   "exactly two serial model passes expand then select; no executor API or speculative effects")
        let stopped = ThoughtProbe()
        do {
            _ = try await AssistThoughtTree.run(baseMessages: base, tools: tools, scope: .device,
                deadline: .now.advanced(by: .seconds(10)), model: { _, budget in
                    _ = await stopped.next(budget); return first
                }, isCancelled: { true }, cancelModel: { await stopped.cancel() })
            throw NSError(domain: "Assist.ThoughtChecks", code: 5)
        } catch is CancellationError { checks += 1 }
        let neverStarted = await stopped.state()
        try expect(neverStarted.0.isEmpty && neverStarted.3 == 0, "cancelled admission invokes no model or speculative effect")
        let malformed = ThoughtProbe()
        do {
            _ = try await AssistThoughtTree.run(baseMessages: base, tools: tools, scope: .device,
                deadline: .now.advanced(by: .seconds(10)), model: { _, budget in
                    _ = await malformed.next(budget); return .init(rawText: "{}", completedEOS: true)
                }, cancelModel: { await malformed.cancel() })
            throw NSError(domain: "Assist.ThoughtChecks", code: 6)
        } catch AssistThoughtTree.Failure.invalidOutput { checks += 1 }
        let malformedState = await malformed.state()
        try expect(malformedState.0 == [192] && malformedState.3 == 1,
                   "malformed roots fail closed with no retry, second pass or executor")
        let timeout = ThoughtProbe()
        do {
            _ = try await AssistThoughtTree.run(baseMessages: base, tools: tools, scope: .device,
                deadline: .now.advanced(by: .milliseconds(40)), model: { _, budget in
                    _ = await timeout.next(budget)
                    await timeout.suspend() // deliberately ignores Task cancellation like a suspended SDK prefill
                    await timeout.finish()
                    return first
                }, cancelModel: { await timeout.cancel() })
            throw NSError(domain: "Assist.ThoughtChecks", code: 3)
        } catch AssistThoughtTree.Failure.deadline { checks += 1 }
        let drained = await timeout.state()
        try expect(drained.0 == [192] && drained.2 && drained.3 == 1,
                   "deadline invokes and awaits SDK cancellation before structured worker drain and return")
        let parentCancel = ThoughtProbe()
        let task = Task {
            try await AssistThoughtTree.run(baseMessages: base, tools: tools, scope: .device,
                deadline: .now.advanced(by: .seconds(10)), model: { _, budget in
                    _ = await parentCancel.next(budget); await parentCancel.suspend(); await parentCancel.finish(); return first
                }, cancelModel: { await parentCancel.cancel() })
        }
        await parentCancel.waitUntilStarted()
        task.cancel()
        do { _ = try await task.value; throw NSError(domain: "Assist.ThoughtChecks", code: 4) }
        catch is CancellationError { checks += 1 }
        let cancelled = await parentCancel.state()
        try expect(cancelled.2 && cancelled.3 == 1, "parent cancellation drains the exact suspended model and leaves no late cancellation task")
        let leafCancel = ThoughtProbe()
        let leafTask = Task {
            try await AssistThoughtTree.run(baseMessages: base, tools: tools, scope: .device,
                deadline: .now.advanced(by: .seconds(10)), model: { _, budget in
                    if await leafCancel.next(budget) == 1 { return first }
                    await leafCancel.suspend(); await leafCancel.finish(); return second
                }, cancelModel: { await leafCancel.cancel() })
        }
        await leafCancel.waitUntilStarted()
        leafTask.cancel()
        do { _ = try await leafTask.value; throw NSError(domain: "Assist.ThoughtChecks", code: 7) }
        catch is CancellationError { checks += 1 }
        let leafState = await leafCancel.state()
        try expect(leafState.0 == [192, 384] && leafState.2 && leafState.3 == 1,
                   "second-pass cancellation drains before any selected strategy or executor can escape")
        print("PASS: \(checks) bounded two-pass thought-tree checks; scripted model only, no executor/device/inference qualification")
    }
}
