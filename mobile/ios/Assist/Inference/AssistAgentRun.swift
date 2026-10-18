import CoreFoundation
import Foundation
import Synchronization

/// Created synchronously by the main-actor bridge before any unstructured Task
/// is scheduled. Revocation therefore precedes even a delayed actor admission.
/// A cancellation acknowledgement waits for that exact outer operation to drain.
final class AssistAgentAdmission: Sendable {
    private struct State {
        var cancelled = false
        var finished = false
        var waiters: [CheckedContinuation<Void, Never>] = []
    }
    private let state = Mutex(State())
    var isCancelled: Bool { state.withLock { $0.cancelled } }
    var isFinished: Bool { state.withLock { $0.finished } }
    func cancel() { state.withLock { $0.cancelled = true } }
    func check() throws { if isCancelled { throw CancellationError() } }
    func finish() {
        let waiters = state.withLock { value in
            value.finished = true
            let waiters = value.waiters
            value.waiters.removeAll()
            return waiters
        }
        for waiter in waiters { waiter.resume() }
    }
    func waitForFinish() async {
        await withCheckedContinuation { continuation in
            let finished = state.withLock { value in
                if value.finished { return true }
                value.waiters.append(continuation)
                return false
            }
            if finished { continuation.resume() }
        }
    }
}

enum AssistAgentTaskPhase: String, Sendable {
    case planning, executing, observing, completed, cancelled, failed
}

struct AssistAgentTrace: Encodable, Sendable {
    let schemaVersion = 1
    let tool = "calendar.list"
    let callId: String
    let scope: AssistAgentCalendarScope
    let returnedCount: Int
    let possiblyTruncated: Bool
}

/// Closed live UI metadata, not a model transcript or a new execution grant.
/// This run has one linear path, so native stage ordinals are fixed at 1...3.
/// Terminal UI state comes from the task result/error, never this emitter.
struct AssistCalendarActivity: Encodable, Sendable {
    enum Phase: String, Encodable, Sendable { case planning, executing, observing }
    let schemaVersion = 1
    let requestId: String
    let sequence: Int
    let phase: Phase
    let scope: AssistAgentCalendarScope
    let receipt: AssistAgentTrace?

    private init(requestId: String, sequence: Int, phase: Phase,
                 scope: AssistAgentCalendarScope, receipt: AssistAgentTrace?) {
        self.requestId = requestId; self.sequence = sequence; self.phase = phase
        self.scope = scope; self.receipt = receipt
    }

    static func planning(requestId: String, scope: AssistAgentCalendarScope) -> Self {
        Self(requestId: requestId, sequence: 1, phase: .planning, scope: scope, receipt: nil)
    }
    static func executing(requestId: String, scope: AssistAgentCalendarScope) -> Self {
        Self(requestId: requestId, sequence: 2, phase: .executing, scope: scope, receipt: nil)
    }
    static func observing(requestId: String, receipt: AssistAgentTrace) -> Self {
        Self(requestId: requestId, sequence: 3, phase: .observing, scope: receipt.scope, receipt: receipt)
    }
}

struct AssistAgentModelTurn<Value: Sendable>: Sendable {
    let rawText: String
    let stoppedAtToolResponse: Bool
    let completed: Bool
    let value: Value
}

struct AssistAgentRunOutcome<Value: Sendable>: Sendable {
    let value: Value
    let visibleText: String
    let trace: AssistAgentTrace?
}

/// Native task policy, independent of model text and engine state. There is no
/// dispatch-by-name API: this first registry contains exactly one read closure.
/// Its transient observation is neither persisted nor replayed in another run.
enum AssistAgentRunController {
    static let planningTokenBudget = 384
    static let answerTokenBudget = 1_024
    static let resultTokenReserve = 2_048
    static let userPrompt = "Consulte mon calendrier d’aujourd’hui et résume les événements retournés, sans supposer que la liste est complète."

    static func request(from json: String) throws -> AssistGenerationRequest {
        guard json.utf8.count <= 48 * 1_024,
              let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(object.keys).isSubset(of: ["schemaVersion", "requestId", "messages", "temperature", "maxTokens"]),
              let version = object["schemaVersion"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1 else {
            throw AssistInferenceError.invalid("Contrat agent local incompatible.")
        }
        let request = try JSONDecoder().decode(AssistGenerationRequest.self, from: Data(json.utf8))
        try request.validate()
        guard request.messages.count <= 64,
              request.messages.last?.content == userPrompt,
              request.messages.reduce(0, { $0 + $1.content.utf8.count }) <= 32 * 1_024 else {
            throw AssistInferenceError.invalid("Cette action exige la demande explicite de calendrier d’aujourd’hui.")
        }
        return request
    }

    /// Two model passes at most, one calendar read at most, no automatic retry.
    /// A cooperative deadline is checked at each boundary; synchronous EventKit
    /// cannot be forcibly preempted, and its late result is discarded on cancel.
    static func run<Value: Sendable>(
        request: AssistGenerationRequest,
        scope: AssistAgentCalendarScope,
        deadline: ContinuousClock.Instant,
        model: @Sendable ([[String: any Sendable]], Int, Bool) async throws -> AssistAgentModelTurn<Value>,
        readCalendar: @Sendable (AssistAgentCalendarScope) async throws -> AssistAgentCalendarObservation,
        isCancelled: @Sendable () -> Bool = { false },
        phase: @Sendable (AssistAgentTaskPhase) async -> Void = { _ in },
        activity: @Sendable (AssistCalendarActivity) async throws -> Void = { _ in }
    ) async throws -> AssistAgentRunOutcome<Value> {
        func checkActive() throws {
            try Task.checkCancellation()
            if isCancelled() { throw CancellationError() }
            guard ContinuousClock.now < deadline else {
                throw AssistInferenceError.invalid("La consultation locale a dépassé son délai. Aucune relance automatique.")
            }
        }
        do {
            try checkActive()
            await phase(.planning)
            try checkActive()
            try await activity(.planning(requestId: request.requestId, scope: scope))
            try checkActive()
            let proposal = try await model(
                AssistGemmaToolAdapter.planningMessages(request: request, scope: scope),
                planningTokenBudget, true)
            try checkActive()
            guard proposal.completed else {
                throw AssistInferenceError.invalid("La proposition du modèle est incomplète. Aucun outil exécuté.")
            }
            switch try AssistGemmaToolAdapter.parse(
                raw: proposal.rawText, stoppedAtToolResponse: proposal.stoppedAtToolResponse, scope: scope
            ) {
            case .answer(let text):
                await phase(.completed)
                return AssistAgentRunOutcome(value: proposal.value, visibleText: text, trace: nil)
            case .call(let call):
                // The call's identity is host-owned and scoped to this run. A
                // tool result cannot add a tool, alter scope or grant a write.
                let callId = UUID().uuidString
                try checkActive()
                await phase(.executing)
                try checkActive()
                try await activity(.executing(requestId: request.requestId, scope: scope))
                try checkActive()
                let observation = try await readCalendar(scope)
                try checkActive()
                guard observation.scope.startISO == scope.startISO,
                      observation.scope.endISO == scope.endISO,
                      observation.scope.timeZoneIdentifier == scope.timeZoneIdentifier,
                      observation.events.count <= 5,
                      observation.possiblyTruncated == (observation.events.count == 5) else {
                    throw AssistInferenceError.invalid("Résultat calendrier hors du périmètre autorisé.")
                }
                let receipt = AssistAgentTrace(callId: callId, scope: scope,
                                              returnedCount: observation.events.count,
                                              possiblyTruncated: observation.possiblyTruncated)
                await phase(.observing)
                try checkActive()
                try await activity(.observing(requestId: request.requestId, receipt: receipt))
                let continuation = try AssistGemmaToolAdapter.continuationMessages(
                    request: request, call: call, toolResponse: observation.modelResponse, scope: scope)
                try checkActive()
                let answer = try await model(
                    continuation, min(request.maxTokens ?? answerTokenBudget, answerTokenBudget), false)
                try checkActive()
                guard answer.completed, !answer.stoppedAtToolResponse else {
                    throw AssistInferenceError.invalid("La réponse finale est incomplète ou propose un deuxième outil. Aucun nouvel appel exécuté.")
                }
                let text = try AssistGemmaToolAdapter.validatePublicText(answer.rawText)
                await phase(.completed)
                return AssistAgentRunOutcome(
                    value: answer.value, visibleText: text,
                    trace: receipt)
            }
        } catch is CancellationError {
            await phase(.cancelled)
            throw CancellationError()
        } catch {
            await phase(.failed)
            throw error
        }
    }
}
