import Foundation

/// Concrete native executors only; the caller is the existing one-shot broker.
@MainActor
enum AssistCapabilityActions {
    static func execute(_ call: AssistDeviceToolCall, operationId: UUID,
                        completion: @escaping @MainActor @Sendable (String?, NSError?) -> Void) {
        do {
            let request = try AssistExtendedToolsPolicy.request(call, operationId: operationId)
            let callback: @Sendable (String?, NSError?) -> Void = { json, error in
                Task { @MainActor in completion(json, error) }
            }
            if call.name.rawValue.hasPrefix("alarm_") {
                _ = try AssistAlarmPolicy.request(request)
                AssistAlarms.shared.execute(request, completion: callback)
            } else if [.translation_languages, .text_translate].contains(call.name) {
                _ = try AssistTranslationPolicy.request(request)
                AssistTranslation.shared.execute(request, completion: callback)
            } else {
                _ = try AssistDocumentActionsPolicy.request(request)
                AssistDocumentActions.shared.execute(request, completion: callback)
            }
        } catch {
            // All guards above run before any concrete executor is admitted.
            completion(nil, NSError(domain: "Assist.CapabilityActions.PreSubmission", code: 1))
        }
    }
    static func cancel() {
        AssistAlarms.shared.cancel()
        AssistTranslation.shared.cancel()
        AssistDocumentActions.shared.cancel()
    }
    /// Do not expose arbitrary framework errors, but retain the executor's
    /// closed uncertainty contract. The document owner upgrades every error
    /// after its own handoff/commit boundary to outcomeUnknown.
    static func callbackFailure(_ error: NSError, call: AssistDeviceToolCall) -> AssistToolTransactionError {
        for kind in [AssistToolTransactionError.outcomeUnknown, .rejectedBeforeSubmission, .cancelledBeforeSubmission] {
            let known = kind as NSError
            if error.domain == known.domain, error.code == known.code { return kind }
        }
        if error.domain == "Assist.CapabilityActions.PreSubmission", error.code == 1 { return .rejectedBeforeSubmission }
        if !call.name.rawValue.hasPrefix("alarm_"), ![.translation_languages, .text_translate].contains(call.name),
           error.domain == "Assist.DocumentActions" {
            if error.code == AssistDocumentActionsPolicy.Failure.outcomeUnknown.rawValue { return .outcomeUnknown }
            if error.code == AssistDocumentActionsPolicy.Failure.cancelled.rawValue { return .cancelledBeforeSubmission }
            if (1...7).contains(error.code) || error.code == 20 { return .rejectedBeforeSubmission }
        }
        if error.domain == "AssistAlarms", error.code == 1, error.localizedDescription == "outcome_unknown" { return .outcomeUnknown }
        if error.domain == "AssistTranslation", error.code == AssistTranslationPolicy.Failure.cancelled.rawValue { return .cancelledBeforeSubmission }
        return .executionFailed
    }
    static func preview(_ call: AssistDeviceToolCall) -> [AssistToolPreviewField] {
        let labels = ["kind": "Type", "title": "Titre", "date_iso": "Date UTC", "duration_seconds": "Durée (secondes)",
            "alarm_id": "Alarme Assist", "text": "Texte à traduire", "source_language": "Langue source (vide : détecter)",
            "target_language": "Langue cible", "allow_download": "Autoriser un téléchargement Apple",
            "max_pages": "Pages maximum", "inbox_id": "Document sélectionné", "filename": "Nom du PDF",
            "query": "Recherche locale", "limit": "Résultats maximum", "expiration_days": "Indexation (jours)",
            "channel": "Composeur", "recipients": "Destinataires exacts", "subject": "Objet", "body": "Texte exact", "attachment_id": "Pièce jointe sélectionnée"]
        var rows = [AssistToolPreviewField(label: "Action", value: AssistExtendedToolsPolicy.title(call.name))]
        for field in AssistExtendedToolsPolicy.fields(call.name) {
            guard let value = call.arguments[field.key] else { continue }
            let shown: String
            switch value {
            case .string(let text): shown = text
            case .number(let number): shown = String(Int(number))
            case .bool(let flag): shown = flag ? "Oui" : "Non"
            default: continue
            }
            rows.append(.init(label: labels[field.key] ?? field.key, value: shown))
        }
        if call.name == .message_compose { rows.append(.init(label: "Envoi", value: "Tu vérifies et envoies dans l’interface Apple. Aucune preuve de livraison.")) }
        if call.name == .document_index { rows.append(.init(label: "Confidentialité", value: "Le titre et le texte choisi deviennent recherchables dans Spotlight sur cet appareil jusqu’à expiration ou retrait.")) }
        if call.name == .alarm_update { rows.append(.init(label: "Remplacement", value: "L’ancienne programmation est annulée puis remplacée sous le même identifiant Assist. Une interruption peut laisser un état incertain.")) }
        return rows
    }
    static func project(_ raw: String, call: AssistDeviceToolCall, operationId: UUID) throws -> AssistToolValue {
        let request = try AssistExtendedToolsPolicy.request(call, operationId: operationId)
        var value: AssistToolValue
        if call.name.rawValue.hasPrefix("alarm_") {
            let receipt = try AssistAlarmPolicy.result(raw, request: AssistAlarmPolicy.request(request, now: nil))
            if receipt.status == .outcome_unknown { throw AssistToolTransactionError.outcomeUnknown }
            guard receipt.status == .succeeded else { throw AssistToolTransactionError.rejectedBeforeSubmission }
            // Keep the full native ownership inventory local; bounded summaries
            // only enter the model, with truncation explicitly represented.
            let relevant = call.name == .alarm_list
                ? receipt.items.filter { $0.state != .not_present || $0.uncertain }.sorted { ($0.uncertain ? 0 : 1) < ($1.uncertain ? 0 : 1) }
                : receipt.items.filter { $0.alarm_id == (call.arguments["alarm_id"]?.stringValue.flatMap(UUID.init(uuidString:))?.uuidString ?? operationId.uuidString) }
            let items = try relevant.prefix(5).map { try AssistToolValue.decodeJSON(AssistJSON.encode($0)) }
            value = .object(["schemaVersion": .number(1), "requestId": .string(operationId.uuidString),
                "result_status": .string("succeeded"), "items": .array(items),
                "truncated": .bool(relevant.count > 5), "totalRelevant": .number(Double(relevant.count)), "appOwnedOnly": .bool(true), "untrusted": .bool(true)])
        } else if [.translation_languages, .text_translate].contains(call.name) {
            value = try AssistTranslationPolicy.result(raw, request: AssistTranslationPolicy.request(request))
        } else {
            value = try AssistDocumentActionsPolicy.result(raw, request: AssistDocumentActionsPolicy.request(request))
        }
        guard var row = value.objectDictionary else { throw AssistToolTransactionError.invalidNativeResult }
        if let status = row.removeValue(forKey: "status") {
            if ["cancelled", "cancelled_by_user"].contains(status.stringValue) { throw AssistToolTransactionError.cancelledBeforeSubmission }
            if status.stringValue == "failed" { throw AssistToolTransactionError.executionFailed }
            row["result_status"] = status
        }
        return try AssistToolValue.object(row).validated()
    }
}
