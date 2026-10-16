import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type ProgressEvent = {
  json: string;
};

/** Native owns model paths, lifecycle, cancellation, and local inference. */
export interface Spec extends TurboModule {
  getStatus(): Promise<string>;
  getMonitoringSnapshot(): Promise<string>;
  selectModel(): Promise<string>;
  loadModel(): Promise<string>;
  loadBundledModel(): Promise<string>;
  generate(requestJSON: string): Promise<string>;
  cancel(): Promise<string>;
  reset(): Promise<string>;
  unloadModel(): Promise<string>;
  runNumericalProbe(): Promise<string>;
  runModelLoadProbe(functionName: string): Promise<string>;
  getLastModelLoadProbe(): Promise<string>;
  readonly onProgress: CodegenTypes.EventEmitter<ProgressEvent>;
}

// Android is a future backend, not a simulated Core AI implementation.
export default TurboModuleRegistry.get<Spec>('NativeAssist');
