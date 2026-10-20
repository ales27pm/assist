import CoreFoundation
import Foundation

struct AssistDeviceToolRunOutcome<Value: Sendable>: Sendable {
    let value: Value
    let visibleText: String
    let weather: [AssistToolValue]
    let cancelled: Bool
    let referenceContextEligible: Bool

    init(value: Value, visibleText: String, weather: [AssistToolValue] = [], cancelled: Bool = false,
         referenceContextEligible: Bool = true) {
        self.value = value; self.visibleText = visibleText; self.weather = weather; self.cancelled = cancelled
        self.referenceContextEligible = referenceContextEligible
    }
}

/// The production loop owns one isolated request, not conversation history.
/// Model proposals are data until the closed adapter and the native broker have
/// validated them. A failed/uncertain effect terminates this run, never retries.
enum AssistDeviceToolRun {
    static let maximumToolCalls = AssistDeviceToolAdapter.maximumToolCalls
    static let maximumWrites = AssistDeviceToolAdapter.maximumWrites
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
        allowedTools: Set<AssistToolName> = Set(AssistToolName.allCases),
        referenceContext: AssistDeviceReferenceContext = .empty,
        model: @escaping @Sendable ([[String: any Sendable]], Int, [AssistDeviceToolCall]) async throws -> AssistAgentModelTurn<Value>,
        perform: @escaping @Sendable (AssistDeviceToolCall) async throws -> AssistToolValue,
        isCancelled: @escaping @Sendable () -> Bool = { false }
    ) async throws -> AssistDeviceToolRunOutcome<Value> {
        // The timeout cancels confirmation waits as well as model streaming.
        // Structured draining keeps engine ownership until non-preemptible
        // native work actually returns; it does not claim a hard OS deadline.
        try await withThrowingTaskGroup(of: AssistDeviceToolRunOutcome<Value>.self) { group in
            group.addTask {
                try await runLoop(request: request, deadline: deadline, allowedTools: allowedTools, referenceContext: referenceContext, model: model,
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
        allowedTools: Set<AssistToolName> = Set(AssistToolName.allCases),
        referenceContext: AssistDeviceReferenceContext,
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
        guard !allowedTools.isEmpty else { throw AssistToolContractError.invalidArguments }
        var messages = try AssistDeviceToolAdapter.planningMessages(request: request, referenceContext: referenceContext)
        var calls: [AssistDeviceToolCall] = []
        var writes = 0
        var weather: [AssistToolValue] = []
        var acknowledgements: [String] = []
        var lastResultIsMetadata = false
        var lastPreviewDocument: String?
        var documentsWithReadText: Set<String> = []
        func acknowledgedText(_ answer: String? = nil) throws -> String {
            try AssistDeviceToolAdapter.validatePublicText(
                (acknowledgements + (answer.map { [$0] } ?? [])).joined(separator: "\n\n"))
        }
        while true {
            try checkActive()
            let passMessages = try AssistDeviceToolAdapter.generationMessages(messages: messages, completedCalls: calls)
            let turn = try await model(passMessages, min(request.maxTokens ?? outputTokenBudget, outputTokenBudget), calls)
            try checkActive()
            guard turn.completed else {
                throw AssistInferenceError.invalid("La proposition des outils est incomplète. Aucun nouvel accès exécuté.")
            }
            if lastResultIsMetadata, !turn.stoppedAtToolResponse {
                // Preserve a further structured read proposal, but metadata
                // alone cannot support model-written details. A completed EOS
                // with no text is also sufficient to end with the real ACK.
                // Invalid public/protocol text still fails; this is not a catch
                // around model, tokenizer, deadline or engine errors.
                if !turn.rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let text = try AssistDeviceToolAdapter.validatePublicText(turn.rawText)
                    if let document = lastPreviewDocument, documentsWithReadText.contains(document) {
                        return AssistDeviceToolRunOutcome(value: turn.value, visibleText: try acknowledgedText(text), weather: weather)
                    }
                }
                return AssistDeviceToolRunOutcome(value: turn.value, visibleText: try acknowledgedText(), weather: weather)
            }
            switch try AssistDeviceToolAdapter.parse(raw: turn.rawText, stoppedAtToolResponse: turn.stoppedAtToolResponse,
                                                    allowedTools: allowedTools) {
            case .answer(let text):
                return AssistDeviceToolRunOutcome(value: turn.value,
                    visibleText: acknowledgements.isEmpty ? text : try acknowledgedText(text), weather: weather)
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
                guard allowedTools.contains(call.name) else { throw AssistToolContractError.invalidArguments }
                let result = try await perform(call)
                try checkActive()
                if let status = result.objectDictionary?["status"]?.stringValue {
                    switch status {
                    case "permission_required":
                        return AssistDeviceToolRunOutcome(value: turn.value, visibleText:
                            try acknowledgedText("Cette action nécessite une autorisation iOS. Accorde-la explicitement dans les Outils de l’appareil, puis formule une nouvelle demande si tu le souhaites. Aucun nouvel accès automatique."), weather: weather, referenceContextEligible: false)
                    case "outcome_unknown":
                        guard result.objectDictionary?.count == 1 else { throw AssistToolContractError.invalidValue }
                        return AssistDeviceToolRunOutcome(value: turn.value, visibleText:
                            try acknowledgedText("L’action a peut-être eu lieu. Vérifie son état dans l’application concernée avant toute nouvelle tentative. Aucun nouvel essai automatique."), weather: weather, referenceContextEligible: false)
                    case "cancelled":
                        guard result.objectDictionary?.count == 1 else { throw AssistToolContractError.invalidValue }
                        return AssistDeviceToolRunOutcome(value: turn.value, visibleText:
                            try acknowledgedText(acknowledgements.isEmpty
                                ? "L’action a été annulée. Aucun nouvel essai automatique."
                                : "L’accès suivant a été annulé. Les actions déjà confirmées ci-dessus ne sont pas annulées. Aucun nouvel essai automatique."), weather: weather, cancelled: true, referenceContextEligible: false)
                    default:
                        // Reserved native status values are never model data.
                        throw AssistInferenceError.invalid("L’outil n’a pas confirmé son résultat. Aucun nouvel essai automatique.")
                    }
                }
                if call.name == .weather_forecast {
                    // A final native receipt survives a lost activity event.
                    // The broker has bound/validated this full forecast to its
                    // operation; model prose never manufactures attribution.
                    weather.append(result)
                }
                // Only the latest native read for this exact document can
                // support a later preview summary. A no-text/protected receipt
                // supersedes any earlier text, even though history retains it.
                if call.name == .document_read, let document = call.arguments["inbox_id"]?.stringValue?.lowercased() {
                    documentsWithReadText.remove(document)
                }
                // Keep exact acknowledgements authoritative while allowing the
                // remaining bounded workflow (for example, create then list).
                // Prose after an acknowledgement needs a data-bearing read;
                // after preview, prior text from that exact document also qualifies.
                if let text = try AssistDeviceToolReceiptText.terminal(call: call, result: result) {
                    acknowledgements.append(text)
                    lastResultIsMetadata = true
                    lastPreviewDocument = call.name == .document_preview ? call.arguments["inbox_id"]?.stringValue?.lowercased() : nil
                } else {
                    lastResultIsMetadata = false
                    lastPreviewDocument = nil
                    // This narrow provenance only records text from the exact
                    // selected document. Capabilities, other documents, no-text
                    // reads and untrusted reference prose cannot unlock it.
                    if call.name == .document_read, let row = result.objectDictionary,
                       row["documentState"] == .string("text"), let text = row["text"]?.stringValue,
                       !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                       let document = row["inboxId"]?.stringValue,
                       document == call.arguments["inbox_id"]?.stringValue?.lowercased() {
                        documentsWithReadText.insert(document)
                    }
                }
                messages = try AssistDeviceToolAdapter.continuationMessages(messages: messages, call: call, result: result)
                calls.append(call)
            }
        }
    }
}

/// Renders only the closed, already-validated broker acknowledgement. It never
/// infers delivery, a displayed alarm, document contents or success from prose.
/// Arguments remain frozen by the broker; native IDs and paths stay out of text.
enum AssistDeviceToolReceiptText {
    static func terminal(call: AssistDeviceToolCall, result: AssistToolValue) throws -> String? {
        guard let row = try result.validated().objectDictionary else { throw AssistToolContractError.invalidValue }
        func require(_ condition: Bool) throws {
            guard condition else { throw AssistToolContractError.invalidValue }
        }
        func exact(_ keys: Set<String>) throws { try require(Set(row.keys) == keys) }
        func document(_ action: String, _ status: String, extra: Set<String> = []) throws {
            try exact(Set(["schemaVersion", "requestId", "action", "result_status", "inboxId"]).union(extra))
            try require(row["schemaVersion"] == .number(1) &&
                        row["requestId"]?.stringValue.flatMap(UUID.init(uuidString:)) != nil &&
                        row["action"] == .string(action) && row["result_status"] == .string(status) &&
                        row["inboxId"]?.stringValue == call.arguments["inbox_id"]?.stringValue?.lowercased())
        }
        switch call.name {
        case .calendar_create, .reminder_create:
            try exact(["created", "destination"])
            let calendar = call.name == .calendar_create
            try require(row["created"] == .bool(true) && row["destination"] == .string(calendar ? "calendar" : "reminders"))
            return calendar ? "L’événement a été créé dans le calendrier confirmé."
                : "Le rappel a été créé dans la liste confirmée."
        case .notification_schedule:
            try exact(["scheduled", "presentation"])
            try require(row["scheduled"] == .bool(true) && row["presentation"] == .string("scheduled_not_presented"))
            return "La notification a été programmée. Sa présentation n’est pas confirmée."
        case .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel:
            try exact(["schemaVersion", "requestId", "result_status", "items", "truncated", "totalRelevant", "appOwnedOnly", "untrusted"])
            guard let operation = row["requestId"]?.stringValue.flatMap(UUID.init(uuidString:)),
                  case .array(let items) = row["items"], items.count == 1, let item = items.first?.objectDictionary else {
                throw AssistToolContractError.invalidValue
            }
            let target = call.name == .alarm_create ? operation.uuidString
                : call.arguments["alarm_id"]?.stringValue.flatMap(UUID.init(uuidString:))?.uuidString
            try require(row["schemaVersion"] == .number(1) && row["result_status"] == .string("succeeded") &&
                        row["appOwnedOnly"] == .bool(true) && row["untrusted"] == .bool(true) &&
                        row["truncated"] == .bool(false) && row["totalRelevant"] == .number(1) &&
                        item["alarm_id"]?.stringValue == target && item["uncertain"] == .bool(false))
            if call.name == .alarm_create || call.name == .alarm_update {
                try require(item["kind"] == call.arguments["kind"] && item["title"] == call.arguments["title"] &&
                            item["duration_seconds"] == call.arguments["duration_seconds"] && item["date_iso"] == call.arguments["date_iso"])
            }
            switch call.name {
            case .alarm_create: return "AlarmKit a confirmé la programmation de l’alarme Assist. Cela ne prouve pas qu’une alerte a été présentée."
            case .alarm_update: return "AlarmKit a confirmé le remplacement de la programmation de cette alarme Assist."
            case .alarm_stop: return "AlarmKit a confirmé l’arrêt de cette alarme Assist."
            default: return "AlarmKit a confirmé l’annulation de cette alarme Assist."
            }
        case .document_preview:
            try document("preview", "closed")
            return "L’aperçu a été fermé. Cet aperçu ne transmet aucun texte du document à Gemma."
        case .document_export_pdf:
            try document("export_pdf", "exported", extra: ["filename"])
            try require(row["filename"] == call.arguments["filename"])
            return "Le sélecteur d’iOS a confirmé l’export du PDF. Vérifie le fichier à l’emplacement choisi."
        case .document_index:
            try document("index", "indexed", extra: ["expiresAt"])
            guard let expiry = row["expiresAt"]?.stringValue else { throw AssistToolContractError.invalidValue }
            _ = try AssistToolContent.timestamp(expiry)
            return "Spotlight a confirmé l’indexation du document choisi jusqu’au \(expiry)."
        case .document_unindex:
            try document("unindex", "unindexed")
            return "Spotlight a confirmé le retrait du document de l’index Assist."
        case .message_compose:
            try exact(["schemaVersion", "requestId", "action", "result_status", "channel", "deliveryVerified"])
            try require(row["schemaVersion"] == .number(1) && row["action"] == .string("compose") &&
                        row["requestId"]?.stringValue.flatMap(UUID.init(uuidString:)) != nil &&
                        row["channel"] == call.arguments["channel"] && row["deliveryVerified"] == .bool(false))
            switch row["result_status"]?.stringValue {
            case "queued_by_user": return "Le composeur Apple a accepté ton envoi. La livraison et la lecture ne sont pas vérifiées."
            case "saved_draft":
                try require(row["channel"] == .string("email"))
                return "Le brouillon a été enregistré dans Mail. Aucun envoi n’est confirmé."
            default: throw AssistToolContractError.invalidValue
            }
        case .biometrics_authenticate:
            try exact(["authenticated"])
            try require(row["authenticated"] == .bool(true))
            return "L’authentification locale a été confirmée."
        case .native_boundary:
            try exact(["feature", "supported"])
            try require(row["feature"] == call.arguments["feature"] && row["supported"] == .bool(false))
            return "La capacité demandée n’est pas prise en charge par cet outil."
        case .document_read, .document_scan:
            // No-text/protected states are evidence of absent text, not a prompt
            // from which the model may invent the selected document's contents.
            switch row["documentState"]?.stringValue {
            case "no_text":
                try require(row["text"] == .string(""))
                return "Aucun texte n’a été extrait du document choisi."
            case "protected_pdf":
                try require(row["text"] == .string(""))
                return "Le PDF est protégé ou chiffré. Aucun texte n’a été extrait."
            default: return nil
            }
        case .photo_select, .camera_capture:
            switch row["ocr_status"]?.stringValue {
            case "no_text", "failed":
                try require(row["selected"] == .bool(true) && row["ocr_text"] == nil)
                return row["ocr_status"] == .string("no_text")
                    ? "Aucun texte n’a été reconnu dans l’image choisie."
                    : "L’image a été choisie, mais la reconnaissance de son texte a échoué."
            default: return nil
            }
        default: return nil
        }
    }
}
