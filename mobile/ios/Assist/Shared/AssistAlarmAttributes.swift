import AlarmKit

/// Shared verbatim by the application and widget targets. Metadata is display
/// data only; a Live Activity cannot turn its ID or title into tool authority.
struct AssistAlarmMetadata: AlarmMetadata {
    var alarmID: String
    var title: String
    var kind: String
}
