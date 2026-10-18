import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type ProgressEvent = {
  json: string;
};

export type CalendarActivityEvent = {
  json: string;
};

/** Native owns model paths, lifecycle, cancellation, and local inference. */
export interface Spec extends TurboModule {
  /** Read-only iOS consent and platform-boundary snapshot; never prompts. */
  getDeviceCapabilityStatus(): Promise<string>;
  /** Requests exactly one user-invoked native capability. */
  requestDeviceCapability(capability: string): Promise<string>;
  searchContacts(query: string, limit: string): Promise<string>;
  listCalendarEvents(
    calendarIdentifier: string,
    startISO: string,
    endISO: string,
    limit: string,
  ): Promise<string>;
  createCalendarEvent(payloadJSON: string): Promise<string>;
  listReminders(
    includeCompleted: boolean,
    startISO: string,
    endISO: string,
    limit: string,
  ): Promise<string>;
  createReminder(payloadJSON: string): Promise<string>;
  getCurrentLocation(): Promise<string>;
  selectPhoto(): Promise<string>;
  capturePhoto(): Promise<string>;
  scheduleLocalNotification(payloadJSON: string): Promise<string>;
  getBiometricStatus(): Promise<string>;
  authenticateWithBiometrics(reason: string): Promise<string>;
  getNativeCapabilityBoundary(feature: string): Promise<string>;
  getStatus(): Promise<string>;
  getVoiceStatus(): Promise<string>;
  getAdvancedVoiceState(): Promise<string>;
  importAdvancedVoicePack(): Promise<string>;
  restorePreviousAdvancedVoicePack(): Promise<string>;
  setAdvancedVoiceBackend(backend: string, variant: string): Promise<string>;
  getSpeechVoices(): Promise<string>;
  setSpeechVoice(voiceId: string): Promise<string>;
  previewSpeechVoice(
    voiceId: string,
    segmentsJSON: string,
    sessionId: string,
  ): Promise<string>;
  stopSpeechVoicePreview(sessionId: string): Promise<string>;
  getVoicePreferences(): Promise<string>;
  setVoicePreferences(readResponses: boolean): Promise<string>;
  startListening(sessionId: string): Promise<string>;
  stopListening(): Promise<string>;
  cancelVoice(): Promise<string>;
  speak(text: string, utteranceId: string): Promise<string>;
  beginSpeech(utteranceId: string): Promise<string>;
  enqueueSpeech(text: string, utteranceId: string): Promise<string>;
  finishSpeech(utteranceId: string): Promise<string>;
  getMonitoringSnapshot(): Promise<string>;
  getPreviousMonitoringSnapshot(): Promise<string>;
  selectModel(): Promise<string>;
  loadModel(): Promise<string>;
  loadBundledModel(): Promise<string>;
  /** Versioned capability handshake; never reads calendar data or prompts. */
  getAgentCapabilities(): Promise<string>;
  /** Explicit touch-only, native-owned, bounded read-only calendar turn. */
  generateCalendarToday(requestJSON: string): Promise<string>;
  /** Closed native tool registry; advertises support without reading data. */
  getDeviceToolCapabilities(): Promise<string>;
  /** Fresh opted-in turn. Every native access still requires confirmation. */
  generateWithTools(requestJSON: string): Promise<string>;
  confirmToolAction(
    transactionId: string,
    confirmationToken: string,
  ): Promise<string>;
  /** Bounded native transaction journal, including uncertain side effects. */
  getToolOperations(): Promise<string>;
  generate(requestJSON: string): Promise<string>;
  cancel(): Promise<string>;
  reset(): Promise<string>;
  unloadModel(): Promise<string>;
  runNumericalProbe(): Promise<string>;
  repairNumericalProbe(): Promise<string>;
  repairModelLoadProbe(functionName: string): Promise<string>;
  getLastSpecializationRepair(): Promise<string>;
  runModelLoadProbe(functionName: string): Promise<string>;
  getLastModelLoadProbe(): Promise<string>;
  runModelAssetProbe(): Promise<string>;
  getLastModelAssetProbe(): Promise<string>;
  readonly onProgress: CodegenTypes.EventEmitter<ProgressEvent>;
  readonly onVoiceEvent: CodegenTypes.EventEmitter<ProgressEvent>;
  /** Native-only task metadata JSON; never a model transcript or calendar rows. */
  readonly onCalendarActivity: CodegenTypes.EventEmitter<CalendarActivityEvent>;
  readonly onToolActivity: CodegenTypes.EventEmitter<ProgressEvent>;
}

// Android is a future backend, not a simulated Core AI implementation.
export default TurboModuleRegistry.get<Spec>('NativeAssist');
