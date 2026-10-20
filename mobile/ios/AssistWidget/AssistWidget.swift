import WidgetKit
import SwiftUI

private struct AssistLauncherEntry: TimelineEntry {
    let date: Date
    let pendingCount: Int?
}

private struct AssistLauncherProvider: TimelineProvider {
    func placeholder(in context: Context) -> AssistLauncherEntry {
        AssistLauncherEntry(date: Date(timeIntervalSince1970: 0), pendingCount: nil)
    }
    func getSnapshot(in context: Context, completion: @escaping (AssistLauncherEntry) -> Void) {
        completion(snapshot(now: Date()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<AssistLauncherEntry>) -> Void) {
        let now = Date()
        completion(Timeline(entries: [snapshot(now: now)], policy: .after(now.addingTimeInterval(30 * 60))))
    }
    private func snapshot(now: Date) -> AssistLauncherEntry {
        // Protected files may be unavailable while locked. Never replace that
        // state with an invented zero or expose titles, URLs or document text.
        let count = try? AssistSharedInbox.appGroup().list(now: now).filter { $0.consumedAt == nil }.count
        return AssistLauncherEntry(date: now, pendingCount: count)
    }
}

private struct AssistLauncherView: View {
    let entry: AssistLauncherEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Assist", systemImage: "bubble.left.and.text.bubble.right")
                .font(.headline)
            Text("Ouvrir Assist").font(.body)
            if let count = entry.pendingCount {
                Text("\(count) import(s) à consulter")
                    .font(.caption).foregroundStyle(.secondary)
                    .privacySensitive()
            }
        }
        .accessibilityElement(children: .combine)
        .widgetURL(URL(string: "assist://inbox"))
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }
}

struct AssistWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: AssistSharedInbox.widgetKind, provider: AssistLauncherProvider()) { entry in
            AssistLauncherView(entry: entry)
        }
        .configurationDisplayName("Assist")
        .description("Ouvre Assist et indique les imports restant à consulter, sans afficher leur contenu.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct AssistWidgets: WidgetBundle {
    var body: some Widget {
        AssistWidget()
        AssistAlarmLiveActivity()
    }
}
