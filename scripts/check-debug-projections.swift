import Foundation

/// Behavioral expectations for the real production projector. The shell
/// harness isolates value-type seams, not model/framework behavior.
@main
@MainActor
struct DebugProjectionChecks {
    typealias R = AssistDebugDiagnostics
    typealias O = AssistDebugProjection.Observation
    static var checks = 0

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        checks += 1
        guard condition() else { fatalError("FAIL: \(message)") }
    }
    static func same(_ actual: O?, _ category: R.Category, _ stage: R.Stage, _ outcome: R.Outcome,
                     _ reason: R.Reason? = nil, _ metrics: [R.Metric: Double] = [:], _ label: String) {
        guard let actual else { expect(false, "\(label): missing projection"); return }
        expect(actual.category == category && actual.stage == stage && actual.outcome == outcome &&
               actual.reason == reason && actual.metrics == metrics, label)
    }
    static func sample(footprint: UInt64? = nil, memory: UInt64? = nil, cpu: Double? = nil) -> AssistRuntimeSample {
        AssistRuntimeSample(phase: "ignored-private-phase", voiceStage: "ignored-private-voice", sessionElapsedMs: 12,
            physicalFootprintBytes: footprint, peakPhysicalFootprintBytes: 123, availableMemoryBytes: memory,
            cpuPercent: cpu, thermalState: "ignored-private-thermal", memoryPressure: "ignored-private-pressure",
            lowPowerMode: false, promptTokens: 456, generatedTokens: 789, ttftMs: 5,
            decodeTokensPerSecond: 10, generationElapsedMs: 10, contextCapacity: 32_768,
            requestId: "MUST-NOT-CROSS-PROJECTION")
    }
    static func main() {
        let apple: Set<AssistToolName> = [.maps_search, .maps_directions, .weather_forecast]
        let alarms: Set<AssistToolName> = [.alarm_list, .alarm_create, .alarm_update, .alarm_stop, .alarm_cancel]
        let translation: Set<AssistToolName> = [.translation_languages, .text_translate]
        let documents: Set<AssistToolName> = [.document_scan, .document_export_pdf, .document_preview,
            .document_read, .document_search, .document_index, .document_unindex, .message_compose]
        expect(AssistToolName.allCases.count == 31, "Review projections when the closed native catalog changes")
        let terminal: [(String, R.Stage, R.Outcome, R.Reason?)] = [
            ("executing", .execution, .began, nil), ("success", .receipt, .completed, nil),
            ("failed_safe", .receipt, .failed, .unknown),
            ("outcome_unknown", .receipt, .unknown, .outcomeUnknown),
            ("cancelled", .cancellation, .cancelled, .cancelRequested),
        ]
        for tool in AssistToolName.allCases {
            let domain: R.Category = apple.contains(tool) ? .apple : alarms.contains(tool) ? .alarms :
                translation.contains(tool) ? .translation : documents.contains(tool) ? .documents : .tools
            for (status, stage) in [("awaiting_permission", R.Stage.permission), ("awaiting_confirmation", .confirmation)] {
                let observations = AssistDebugProjection.transaction(tool, status: status)
                expect(observations.count == 1, "\(tool)/\(status): one consent observation")
                same(observations.first, .consent, stage, .began, nil, [:], "\(tool)/\(status)")
            }
            for (status, stage, outcome, reason) in terminal {
                let observations = AssistDebugProjection.transaction(tool, status: status)
                expect(observations.count == (domain == .tools ? 1 : 2), "\(tool)/\(status): no missing/extra domain observation")
                same(observations.first, .tools, stage, outcome, reason, [:], "\(tool)/\(status): broker")
                if domain != .tools {
                    same(observations.last, domain, stage, outcome, reason, [:], "\(tool)/\(status): domain")
                }
            }
            for status in ["", "awaitingPermission", "awaitingConfirmation", "failedSafe", "outcomeUnknown", "arbitrary-private-receipt"] {
                expect(AssistDebugProjection.transaction(tool, status: status).isEmpty, "\(tool): ignore unrecognized status \(status)")
            }
        }
        for value in ["preparing", "pocket", "parakeet", "silero", "session", "audio"] {
            same(AssistDebugProjection.runtime(.voice(value)), .voice, .admission, .began, nil, [:], "voice \(value)")
        }
        for value in ["listening", "speaking"] {
            same(AssistDebugProjection.runtime(.voice(value)), .voice, .execution, .began, nil, [:], "voice \(value)")
        }
        same(AssistDebugProjection.runtime(.voice("inactive")), .voice, .receipt, .completed, nil, [:], "voice inactive")
        same(AssistDebugProjection.runtime(.voice("failed")), .voice, .receipt, .failed, .unknown, [:], "voice failure does not invent a cause")
        for value in ["APP_ACTIVE", "APP_FOREGROUND"] {
            same(AssistDebugProjection.runtime(.lifecycle(value)), .lifecycle, .lifecycle, .began, nil, [:], value)
        }
        for value in ["APP_INACTIVE", "APP_BACKGROUND"] {
            same(AssistDebugProjection.runtime(.lifecycle(value)), .lifecycle, .lifecycle, .completed, nil, [:], value)
        }
        for value in ["warning", "critical"] {
            same(AssistDebugProjection.runtime(.pressure(value)), .performance, .execution, .unknown, .memoryWarning, [:], "pressure \(value)")
        }
        same(AssistDebugProjection.runtime(.pressure("normal")), .performance, .execution, .completed, nil, [:], "normal pressure")
        for value in ["nominal", "fair"] {
            same(AssistDebugProjection.runtime(.thermal(value)), .performance, .execution, .completed, nil, [:], "thermal \(value)")
        }
        same(AssistDebugProjection.runtime(.thermal("serious")), .performance, .execution, .unknown, .thermalSerious, [:], "serious thermal")
        same(AssistDebugProjection.runtime(.thermal("critical")), .performance, .execution, .unknown, .thermalCritical, [:], "critical thermal")
        for value in ["", "unknown", "MUST-NOT-EXPORT-this-private-value", "speaking\u{0}"] {
            for event in [AssistRuntimeDiagnosticEvent.voice(value), .lifecycle(value), .pressure(value), .thermal(value)] {
                expect(AssistDebugProjection.runtime(event) == nil, "ignore unrecognized runtime label")
            }
        }
        same(AssistDebugProjection.runtime(.sample(sample())), .performance, .execution, .completed, nil, [:], "nil metrics remain absent; other sample fields are not projected")
        same(AssistDebugProjection.runtime(.sample(sample(footprint: 2_710_000_001, memory: 310_000_002, cpu: 143.25))),
             .performance, .execution, .completed, nil,
             [.physicalFootprintBytes: 2_710_000_001, .availableMemoryBytes: 310_000_002, .cpuPercent: 143.25], "native sample numeric projection")
        for invalid in [Double.nan, .infinity, -.infinity, -0.1] {
            same(AssistDebugProjection.runtime(.sample(sample(footprint: 9, cpu: invalid))), .performance, .execution,
                 .completed, nil, [.physicalFootprintBytes: 9], "nonfinite/negative CPU is omitted, other numbers retained")
        }
        same(AssistDebugProjection.runtime(.sample(sample(footprint: 0, memory: 0, cpu: 0))), .performance, .execution,
             .completed, nil, [.physicalFootprintBytes: 0, .availableMemoryBytes: 0, .cpuPercent: 0], "measured zero remains a measurement")
        print("PASS: \(checks) production diagnostic projection checks; no framework execution, SDK or device qualification")
    }
}
