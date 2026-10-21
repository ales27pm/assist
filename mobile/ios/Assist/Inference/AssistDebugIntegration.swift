import Foundation

/// Typed projections, separate from framework ownership. No observer may
/// trigger a tool, reparse a tool receipt, or await storage on a callback.
enum AssistDebugProjection {
    typealias Recorder = AssistDebugDiagnostics
    struct Observation: Sendable {
        let category: Recorder.Category
        let stage: Recorder.Stage
        let outcome: Recorder.Outcome
        let reason: Recorder.Reason?
        let metrics: [Recorder.Metric: Double]
        init(_ category: Recorder.Category, _ stage: Recorder.Stage, _ outcome: Recorder.Outcome,
             _ reason: Recorder.Reason? = nil, _ metrics: [Recorder.Metric: Double] = [:]) {
            self.category = category; self.stage = stage; self.outcome = outcome; self.reason = reason; self.metrics = metrics
        }
    }
    static func transaction(_ tool: AssistToolName, status: String) -> [Observation] {
        let domain: Recorder.Category
        switch tool {
        case .maps_search, .maps_directions, .weather_forecast: domain = .apple
        case .alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel: domain = .alarms
        case .translation_languages, .text_translate: domain = .translation
        case .document_scan, .document_export_pdf, .document_preview, .document_read, .document_search,
             .document_index, .document_unindex, .message_compose: domain = .documents
        default: domain = .tools
        }
        let event: Observation
        switch status {
        case "awaiting_permission": return [Observation(.consent, .permission, .began)]
        case "awaiting_confirmation": return [Observation(.consent, .confirmation, .began)]
        case "executing": event = Observation(.tools, .execution, .began)
        case "success": event = Observation(.tools, .receipt, .completed)
        case "failed_safe": event = Observation(.tools, .receipt, .failed, .unknown)
        case "outcome_unknown": event = Observation(.tools, .receipt, .unknown, .outcomeUnknown)
        case "cancelled": event = Observation(.tools, .cancellation, .cancelled, .cancelRequested)
        default: return []
        }
        return domain == .tools ? [event] : [event, Observation(domain, event.stage, event.outcome, event.reason)]
    }
    static func runtime(_ event: AssistRuntimeDiagnosticEvent) -> Observation? {
        switch event {
        case .sample(let sample):
            var metrics: [Recorder.Metric: Double] = [:]
            if let n = sample.physicalFootprintBytes { metrics[.physicalFootprintBytes] = Double(n) }
            if let n = sample.availableMemoryBytes { metrics[.availableMemoryBytes] = Double(n) }
            if let n = sample.cpuPercent, n.isFinite, n >= 0 { metrics[.cpuPercent] = n }
            return Observation(.performance, .execution, .completed, nil, metrics)
        case .voice(let value):
            switch value {
            case "preparing", "pocket", "parakeet", "silero", "session", "audio": return Observation(.voice, .admission, .began)
            case "listening", "speaking": return Observation(.voice, .execution, .began)
            case "inactive": return Observation(.voice, .receipt, .completed)
            case "failed": return Observation(.voice, .receipt, .failed, .unknown)
            default: return nil
            }
        case .lifecycle(let code):
            switch code {
            case "APP_ACTIVE", "APP_FOREGROUND": return Observation(.lifecycle, .lifecycle, .began)
            case "APP_INACTIVE", "APP_BACKGROUND": return Observation(.lifecycle, .lifecycle, .completed)
            default: return nil
            }
        case .pressure(let level):
            switch level {
            case "warning", "critical": return Observation(.performance, .execution, .unknown, .memoryWarning)
            case "normal": return Observation(.performance, .execution, .completed)
            default: return nil
            }
        case .thermal(let state):
            switch state {
            case "serious": return Observation(.performance, .execution, .unknown, .thermalSerious)
            case "critical": return Observation(.performance, .execution, .unknown, .thermalCritical)
            case "nominal", "fair": return Observation(.performance, .execution, .completed)
            default: return nil
            }
        }
    }
    static func submit(_ observation: Observation, requestId: String? = nil) {
        Recorder.observe(category: observation.category, stage: observation.stage, outcome: observation.outcome,
            requestId: requestId, reason: observation.reason, metrics: observation.metrics)
    }
}

#if canImport(ObjectiveC)
@objc(AssistDebugIntegration)
#endif
@MainActor
final class AssistDebugIntegration: NSObject {
    private static var installed = false
    #if canImport(ObjectiveC)
    @objc
    #endif
    static func install() {
        guard !installed else { return }; installed = true
        AssistToolTransactionDiagnosticsRelay.shared.install { tool, status, requestId in
            for observation in AssistDebugProjection.transaction(tool, status: status) {
                AssistDebugProjection.submit(observation, requestId: requestId)
            }
        }
        AssistRuntimeDiagnosticRelay.shared.install { event in
            if let observation = AssistDebugProjection.runtime(event) { AssistDebugProjection.submit(observation) }
        }
        Task {
            await AssistDebugDiagnostics.shared.start()
            // Partial means compiled observation points, not exhaustive test
            // coverage, framework availability, or device qualification.
            for category in AssistDebugDiagnostics.Category.allCases where category != .system {
                await AssistDebugDiagnostics.shared.setCoverage(category, available: true)
            }
        }
        #if canImport(MetricKit)
        if #available(iOS 27.0, macOS 27.0, macCatalyst 27.0, visionOS 27.0, *) {
            AssistSystemDiagnostics.start()
            Task { await AssistDebugDiagnostics.shared.setCoverage(.system, available: true) }
        }
        #endif
    }
}
