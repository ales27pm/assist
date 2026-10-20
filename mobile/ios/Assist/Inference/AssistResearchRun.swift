import Foundation

/// Evidence is emitted only by the validated reader, never parsed from prose.
struct AssistResearchSource: Codable, Equatable, Sendable {
    let id: String
    let title: String
    let url: String
    let readAt: String
    let truncated: Bool
}

struct AssistResearchRunOutcome<Value: Sendable>: Sendable {
    let value: Value
    let visibleText: String
    let sources: [AssistResearchSource]
    let degraded: Bool
}

/// One isolated public question, bounded web profile, no device executor.
/// Calls/results remain local/transient and are never resumed automatically.
enum AssistResearchRun {
    static let maximumDurationSeconds = 120
    static let maximumToolCalls = 5
    static let maximumPageReads = 4
    static let outputTokenBudget = 1_024
    static let maximumAggregateResultBytes = 24 * 1_024

    static func request(from json: String) throws -> AssistGenerationRequest {
        guard json.utf8.count <= 16 * 1_024,
              let row = try AssistToolValue.decodeJSON(json).objectDictionary,
              Set(row.keys).isSubset(of: ["schemaVersion", "requestId", "messages", "temperature", "maxTokens"]),
              row["schemaVersion"]?.integerValue == 1,
              case .array(let messages) = row["messages"], messages.count == 1,
              let message = messages[0].objectDictionary, Set(message.keys) == ["role", "content"] else {
            throw AssistToolContractError.invalidArguments
        }
        let request = try JSONDecoder().decode(AssistGenerationRequest.self, from: Data(json.utf8))
        try validate(request: request)
        return request
    }

    static func validate(request: AssistGenerationRequest) throws {
        try request.validate()
        guard request.temperature == 0, request.maxTokens.map({ (1...outputTokenBudget).contains($0) }) ?? true,
              AssistResearchAdapter.identifier(request.requestId), request.messages.count == 1,
              request.messages[0].role == "user", request.messages[0].content.utf8.count <= 2_048,
              !request.messages[0].content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AssistInferenceError.invalid("La recherche exige une question publique isolée, au plus 2048 octets et 1024 jetons, sans historique privé.")
        }
        try AssistToolContent.validate(request.messages[0].content)
    }

    static func run<Value: Sendable>(
        request: AssistGenerationRequest, deadline requestedDeadline: ContinuousClock.Instant,
        model: @escaping @Sendable ([[String: any Sendable]], Int, [AssistResearchToolCall]) async throws -> AssistAgentModelTurn<Value>,
        perform: @escaping @Sendable (AssistResearchToolCall) async throws -> AssistToolValue,
        isCancelled: @escaping @Sendable () -> Bool = { false }
    ) async throws -> AssistResearchRunOutcome<Value> {
        try validate(request: request)
        let deadline = min(requestedDeadline, ContinuousClock.now.advanced(by: .seconds(maximumDurationSeconds)))
        // Structured draining holds the sole engine owner until synchronous or
        // non-preemptible work returns. This is not a hard OS timeout promise.
        return try await withThrowingTaskGroup(of: AssistResearchRunOutcome<Value>.self) { group in
            group.addTask {
                try await loop(request: request, deadline: deadline, model: model, perform: perform, isCancelled: isCancelled)
            }
            group.addTask {
                try await Task.sleep(until: deadline, clock: .continuous)
                throw AssistInferenceError.invalid("La recherche a atteint son délai. Aucun nouvel essai automatique.")
            }
            defer { group.cancelAll() }
            guard let outcome = try await group.next() else { throw CancellationError() }
            return outcome
        }
    }

    private static func loop<Value: Sendable>(
        request: AssistGenerationRequest, deadline: ContinuousClock.Instant,
        model: @Sendable ([[String: any Sendable]], Int, [AssistResearchToolCall]) async throws -> AssistAgentModelTurn<Value>,
        perform: @Sendable (AssistResearchToolCall) async throws -> AssistToolValue,
        isCancelled: @Sendable () -> Bool
    ) async throws -> AssistResearchRunOutcome<Value> {
        func checkActive() throws {
            try Task.checkCancellation()
            if isCancelled() { throw CancellationError() }
            guard ContinuousClock.now < deadline else {
                throw AssistInferenceError.invalid("La recherche a atteint son délai. Aucun nouvel essai automatique.")
            }
        }
        try checkActive()
        var messages = try AssistResearchAdapter.planningMessages(request: request)
        var calls: [AssistResearchToolCall] = []
        var results: [String: Hit] = [:]
        var sources: [AssistResearchSource] = []
        var aggregateBytes = 0
        var degraded = false
        var searched = false
        while true {
            try checkActive()
            let turn = try await model(messages, min(request.maxTokens ?? outputTokenBudget, outputTokenBudget), calls)
            try checkActive()
            guard turn.completed else { throw AssistToolContractError.invalidOutput }
            switch try AssistResearchAdapter.parse(raw: turn.rawText, stoppedAtToolResponse: turn.stoppedAtToolResponse) {
            case .answer(let text):
                try validateCitations(in: text, sources: sources)
                return AssistResearchRunOutcome(value: turn.value, visibleText: text, sources: sources, degraded: degraded)
            case .call(let call):
                guard calls.count < maximumToolCalls else { throw AssistToolContractError.invalidArguments }
                let requestedID: String?
                switch call.name {
                case .web_search:
                    guard !searched, calls.isEmpty else { throw AssistToolContractError.invalidArguments }
                    requestedID = nil
                case .web_read:
                    guard searched, sources.count < maximumPageReads,
                          let id = call.arguments["result_id"]?.stringValue, results[id] != nil,
                          !sources.contains(where: { $0.id == id }) else { throw AssistToolContractError.invalidArguments }
                    requestedID = call.arguments["result_id"]?.stringValue
                }
                try checkActive()
                let response = try await perform(call)
                try checkActive()
                _ = try response.validated()
                aggregateBytes += try JSONEncoder().encode(response).count
                guard aggregateBytes <= maximumAggregateResultBytes else { throw AssistToolContractError.oversizedValue }
                switch call.name {
                case .web_search:
                    let search = try validateSearch(response, requestId: request.requestId)
                    results = search.hits; degraded = search.degraded; searched = true
                case .web_read:
                    guard let id = requestedID, let hit = results[id] else { throw AssistToolContractError.invalidOutput }
                    sources.append(try validateRead(response, requestId: request.requestId, hit: hit))
                }
                messages = try AssistResearchAdapter.continuationMessages(messages: messages, call: call, result: response)
                calls.append(call)
            }
        }
    }

    private struct Hit: Sendable { let id: String; let title: String; let url: String }

    private static func validateSearch(_ value: AssistToolValue, requestId: String) throws -> (hits: [String: Hit], degraded: Bool) {
        guard let row = value.objectDictionary, Set(row.keys) == ["schemaVersion", "requestId", "results", "degraded"],
              row["schemaVersion"]?.integerValue == 1, row["requestId"]?.stringValue == requestId,
              let degraded = row["degraded"]?.boolValue, case .array(let items) = row["results"], items.count <= 10 else {
            throw AssistToolContractError.invalidOutput
        }
        var hits: [String: Hit] = [:]
        for item in items {
            guard let row = item.objectDictionary, Set(row.keys) == ["id", "title", "url", "snippet"],
                  let id = row["id"]?.stringValue, AssistResearchAdapter.identifier(id), hits[id] == nil,
                  let title = row["title"]?.stringValue, title.utf8.count <= 256,
                  let url = row["url"]?.stringValue, AssistPrivateServicePolicy.publicResultURL(url),
                  let snippet = row["snippet"]?.stringValue, snippet.utf8.count <= 1_024 else { throw AssistToolContractError.invalidOutput }
            hits[id] = Hit(id: id, title: title, url: url)
        }
        return (hits, degraded)
    }

    private static func validateRead(_ value: AssistToolValue, requestId: String, hit: Hit) throws -> AssistResearchSource {
        guard let row = value.objectDictionary,
              Set(row.keys) == ["schemaVersion", "requestId", "resultId", "title", "url", "text", "truncated", "readAt", "untrusted"],
              row["schemaVersion"]?.integerValue == 1, row["requestId"]?.stringValue == requestId,
              row["resultId"]?.stringValue == hit.id, row["title"]?.stringValue == hit.title,
              let finalURL = row["url"]?.stringValue, AssistPrivateServicePolicy.publicResultURL(finalURL),
              let text = row["text"]?.stringValue,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 8_192,
              let truncated = row["truncated"]?.boolValue, row["untrusted"]?.boolValue == true,
              let readAt = row["readAt"]?.stringValue else { throw AssistToolContractError.invalidOutput }
        _ = try AssistToolContent.timestamp(readAt)
        // The host-issued result handle binds the destination. A validated
        // reader may follow bounded public redirects and reports the final URL.
        return AssistResearchSource(id: hit.id, title: hit.title, url: finalURL, readAt: readAt, truncated: truncated)
    }

    private static func validateCitations(in text: String, sources: [AssistResearchSource]) throws {
        // Validate the complete small citation grammar; do not recover a valid
        // prefix from an unknown or unterminated model citation. A source card
        // still comes from native evidence, never this token in model prose.
        var lower = text.startIndex
        while let start = text.range(of: "[source:", range: lower..<text.endIndex) {
            guard let end = text[start.upperBound...].firstIndex(of: "]") else { throw AssistToolContractError.invalidOutput }
            let id = String(text[start.upperBound..<end])
            guard AssistResearchAdapter.identifier(id), sources.contains(where: { $0.id == id }) else {
                throw AssistToolContractError.invalidOutput
            }
            lower = text.index(after: end)
        }
    }
}
