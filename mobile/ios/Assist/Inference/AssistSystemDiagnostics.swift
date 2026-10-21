import Foundation
#if canImport(MetricKit)
import MetricKit
#endif

/// Closed, content-free projection of one received system report. Receipt time
/// is not the incident time: a report can describe an earlier app execution.
/// No environment, call stack, exception message or report payload is retained.
enum AssistSystemDiagnosticObservation: Sendable {
    case crash(signal: Int?, exceptionType: Int?)
    case hang(durationMs: Double)
    case cpu
    case disk
    case memory
    case appLaunch
    case other

    struct Projection: Sendable {
        let outcome: AssistDebugDiagnostics.Outcome
        let reason: AssistDebugDiagnostics.Reason
        let metrics: [AssistDebugDiagnostics.Metric: Double]
    }

    var projection: Projection {
        // Counts delivered reports, not unique incidents or incidents in the
        // current session. MetricKit can omit occurrences and deliver later.
        var metrics: [AssistDebugDiagnostics.Metric: Double] = [.reportCount: 1]
        switch self {
        case .crash(let signal, let exceptionType):
            if let value = Self.integer(signal) { metrics[.signal] = value }
            if let value = Self.integer(exceptionType) { metrics[.exceptionType] = value }
            return Projection(outcome: .failed, reason: .systemCrash, metrics: metrics)
        case .hang(let durationMs):
            if Self.valid(durationMs) { metrics[.hangDurationMs] = durationMs }
            return Projection(outcome: .stalled, reason: .systemHang, metrics: metrics)
        case .cpu:
            // Resource diagnostics can be nonfatal. Do not turn them into a
            // claim that the app crashed or that an active tool failed.
            return Projection(outcome: .unknown, reason: .systemCPU, metrics: metrics)
        case .disk:
            return Projection(outcome: .unknown, reason: .systemDisk, metrics: metrics)
        case .memory:
            return Projection(outcome: .failed, reason: .systemMemory, metrics: metrics)
        case .appLaunch:
            return Projection(outcome: .unknown, reason: .systemAppLaunch, metrics: metrics)
        case .other:
            return Projection(outcome: .unknown, reason: .unknown, metrics: metrics)
        }
    }

    private static func integer(_ value: Int?) -> Double? {
        guard let value, value >= 0, value <= 9_007_199_254_740_991 else { return nil }
        return Double(value)
    }

    private static func valid(_ value: Double) -> Bool {
        value.isFinite && value >= 0 && value <= 9_007_199_254_740_991
    }
}

#if canImport(MetricKit)
/// Requires the actual iOS 27 SDK declarations. A host SDK that merely imports
/// legacy MetricKit cannot validate this collector; no compiler-version shim
/// substitutes for compiling MetricManager against the target SDK.
///
/// Apple API references (iOS 27.0+):
/// https://developer.apple.com/documentation/metrickit/metricmanager
/// https://developer.apple.com/documentation/metrickit/metricmanager/diagnosticreports
/// https://developer.apple.com/documentation/metrickit/crashdiagnostic/signal
/// https://developer.apple.com/documentation/metrickit/crashdiagnostic/exceptiontype
/// https://developer.apple.com/documentation/metrickit/hangdiagnostic/hangduration
/// https://developer.apple.com/documentation/metrickit/diagnosticresult/memoryexception(_:)
@available(iOS 27.0, macOS 27.0, macCatalyst 27.0, visionOS 27.0, *)
@MainActor
enum AssistSystemDiagnostics {
    // MainActor serializes startup only. MetricManager and DiagnosticReport are
    // Sendable; the sole consumer runs at utility priority away from the UI.
    // Keep both alive for the process. Do not start another consumer on panel
    // open, foreground transitions, export, or diagnostic-level changes.
    private static var manager: MetricManager?
    private static var consumer: Task<Void, Never>?

    static func start() {
        guard manager == nil else { return }
        let instance = MetricManager()
        manager = instance
        consumer = Task.detached(priority: .utility) {
            await AssistDebugDiagnostics.shared.record(
                category: .system, stage: .systemReport, outcome: .began
            )
            for await report in instance.diagnosticReports {
                guard !Task.isCancelled else { return }
                let observation: AssistSystemDiagnosticObservation
                switch report.result {
                case .crash(let diagnostic):
                    observation = .crash(signal: diagnostic.signal, exceptionType: diagnostic.exceptionType)
                case .hang(let diagnostic):
                    observation = .hang(durationMs: diagnostic.hangDuration.converted(to: .milliseconds).value)
                case .cpuException:
                    observation = .cpu
                case .diskWriteException:
                    observation = .disk
                case .appLaunch:
                    observation = .appLaunch
                #if os(iOS) && !targetEnvironment(macCatalyst)
                case .memoryException:
                    observation = .memory
                #endif
                @unknown default:
                    observation = .other
                }
                let projected = observation.projection
                // No requestId: delayed OS evidence is never assigned to an
                // inference or tool operation that happens to be active now.
                // Off/TTL/storage quotas remain the recorder's responsibility.
                await AssistDebugDiagnostics.shared.record(
                    category: .system, stage: .systemReport,
                    outcome: projected.outcome, reason: projected.reason,
                    metrics: projected.metrics
                )
            }
        }
    }
}
#endif
