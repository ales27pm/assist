import CoreFoundation
import Foundation

struct AssistDeviceToolRunOutcome<Value: Sendable>: Sendable {
    let value: Value
    let visibleText: String
}

/// The production loop owns one isolated request, not conversation history.
/// Model proposals are data until the closed adapter and the native broker have
/// validated them. A failed/uncertain effect terminates this run, never retries.
enum AssistDeviceToolRun {
    static let maximumToolCalls = 4
    static let maximumWrites = 1
    static let outputTokenBudget = 1_024

    static func request(from json: String) throws -> AssistGenerationRequest {
        guard json.utf8.count <= 48 * 1_024,
              let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(object.keys).isSubset(of: ["schemaVersion", "requestId", "messages", "temperature", "maxTokens"]),
              let version = object["schemaVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1 else {
            throw AssistInferenceError.invalid("Contrat des outils natifs incompatible.")
        }
        let request = try JSONDecoder().decode(AssistGenerationRequest.self, from: Data(json.utf8))
        try request.validate()
        guard request.temperature == 0, request.maxTokens.map({ $0 <= outputTokenBudget }) ?? true,
              request.messages.count == 1, request.messages[0].role == "user",
              request.messages[0].content.utf8.count <= 32 * 1_024,
              !request.requestId.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw AssistInferenceError.invalid("Les outils exigent une demande nouvelle et isolée, température zéro et au plus 1024 jetons.")
        }
        return request
    }

    static func run<Value: Sendable>(
        request: AssistGenerationRequest, deadline: ContinuousClock.Instant,
        model: @escaping @Sendable ([[String: any Sendable]], Int, [AssistDeviceToolCall]) async throws -> AssistAgentModelTurn<Value>,
        perform: @escaping @Sendable (AssistDeviceToolCall) async throws -> AssistToolValue,
        isCancelled: @escaping @Sendable () -> Bool = { false }
    ) async throws -> AssistDeviceToolRunOutcome<Value> {
        // The timeout cancels confirmation waits as well as model streaming.
        // Structured draining keeps engine ownership until non-preemptible
        // native work actually returns; it does not claim a hard OS deadline.
        try await withThrowingTaskGroup(of: AssistDeviceToolRunOutcome<Value>.self) { group in
            group.addTask {
                try await runLoop(request: request, deadline: deadline, model: model,
                                  perform: perform, isCancelled: isCancelled)
            }
            group.addTask {
                try await Task.sleep(until: deadline, clock: .continuous)
                throw AssistInferenceError.invalid("Le délai des outils natifs est atteint. Aucune relance automatique.")
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw CancellationError() }
            return result
        }
    }

    private static func runLoop<Value: Sendable>(
        request: AssistGenerationRequest, deadline: ContinuousClock.Instant,
        model: @Sendable ([[String: any Sendable]], Int, [AssistDeviceToolCall]) async throws -> AssistAgentModelTurn<Value>,
        perform: @Sendable (AssistDeviceToolCall) async throws -> AssistToolValue,
        isCancelled: @Sendable () -> Bool
    ) async throws -> AssistDeviceToolRunOutcome<Value> {
        func checkActive() throws {
            try Task.checkCancellation()
            if isCancelled() { throw CancellationError() }
            guard ContinuousClock.now < deadline else {
                throw AssistInferenceError.invalid("Le délai des outils natifs est atteint. Aucune relance automatique.")
            }
        }
        try checkActive()
        var messages = try AssistDeviceToolAdapter.planningMessages(request: request)
        var calls: [AssistDeviceToolCall] = []
        var writes = 0
        while true {
            try checkActive()
            let turn = try await model(messages, min(request.maxTokens ?? outputTokenBudget, outputTokenBudget), calls)
            try checkActive()
            guard turn.completed else {
                throw AssistInferenceError.invalid("La proposition des outils est incomplète. Aucun nouvel accès exécuté.")
            }
            switch try AssistDeviceToolAdapter.parse(raw: turn.rawText, stoppedAtToolResponse: turn.stoppedAtToolResponse) {
            case .answer(let text):
                return AssistDeviceToolRunOutcome(value: turn.value, visibleText: text)
            case .call(let call):
                guard calls.count < maximumToolCalls else {
                    throw AssistInferenceError.invalid("La limite de quatre accès natifs est atteinte. Aucun nouvel accès exécuté.")
                }
                if call.name.effect == .write {
                    guard writes < maximumWrites else {
                        throw AssistInferenceError.invalid("Une seule écriture native est permise par demande.")
                    }
                    writes += 1
                }
                try checkActive()
                let result = try await perform(call)
                try checkActive()
                if let status = result.objectDictionary?["status"]?.stringValue {
                    switch status {
                    case "permission_required":
                        return AssistDeviceToolRunOutcome(value: turn.value, visibleText:
                            "Cette action nécessite une autorisation iOS. Accorde-la explicitement dans les Outils de l’appareil, puis formule une nouvelle demande si tu le souhaites. Aucun nouvel accès automatique.")
                    case "outcome_unknown":
                        return AssistDeviceToolRunOutcome(value: turn.value, visibleText:
                            "L’action a peut-être eu lieu. Vérifie son état dans l’application concernée avant toute nouvelle tentative. Aucun nouvel essai automatique.")
                    default:
                        // Reserved native status values are never model data.
                        throw AssistInferenceError.invalid("L’outil n’a pas confirmé son résultat. Aucun nouvel essai automatique.")
                    }
                }
                messages = try AssistDeviceToolAdapter.continuationMessages(messages: messages, call: call, result: result)
                calls.append(call)
            }
        }
    }
}
