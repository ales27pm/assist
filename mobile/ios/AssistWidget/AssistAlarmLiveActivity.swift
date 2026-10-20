import ActivityKit
import AlarmKit
import SwiftUI
import WidgetKit

/// AlarmKit owns countdown progress and alert/stop/pause/resume behavior. This
/// widget is essential for countdown delivery; no JS timer or notifications.
/// Lock Screen and Dynamic Island expose only a generic label. Custom titles
/// remain in the system alarm presentation selected in the exact user preview.
struct AssistAlarmLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlarmAttributes<AssistAlarmMetadata>.self) { context in
            HStack(spacing: 14) {
                Image(systemName: "timer").font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Minuteur Assist").font(.headline).lineLimit(2)
                    AssistAlarmCountdown(mode: context.state.mode)
                }
                Spacer(minLength: 0)
            }
            .padding()
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "timer") }
                DynamicIslandExpandedRegion(.trailing) { AssistAlarmCountdown(mode: context.state.mode) }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("Minuteur Assist").lineLimit(2)
                }
            } compactLeading: {
                Image(systemName: "timer")
            } compactTrailing: {
                AssistAlarmCountdown(mode: context.state.mode).frame(maxWidth: 64)
            } minimal: {
                Image(systemName: "timer")
            }
            .keylineTint(.blue)
        }
    }
}

private struct AssistAlarmCountdown: View {
    let mode: AlarmPresentationState.Mode
    var body: some View {
        switch mode {
        case .countdown(let countdown):
            Text(timerInterval: countdown.startDate...max(countdown.startDate, countdown.fireDate), countsDown: true)
                .monospacedDigit().privacySensitive().accessibilityLabel("Temps restant")
        case .paused(let paused):
            let remaining = max(0, paused.totalCountdownDuration - paused.previouslyElapsedDuration)
            Text(Duration.seconds(remaining).formatted(.time(pattern: .hourMinuteSecond)))
                .monospacedDigit().privacySensitive().accessibilityLabel("Minuteur en pause")
        case .alert:
            Text("Terminé").accessibilityLabel("Minuteur terminé")
        @unknown default:
            Text("Assist")
        }
    }
}
