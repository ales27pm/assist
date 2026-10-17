import React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { AppearanceProvider } from '../src/appearance';
import { ModelWorkspace } from '../src/ModelWorkspace';
import type { EngineState } from '../src/protocol';

const noop = () => undefined;
function workspace(engine: EngineState) {
  return (
    <AppearanceProvider>
      <ModelWorkspace
        engine={engine}
        ready={engine.phase === 'ready'}
        busy={engine.phase === 'loading'}
        selected={engine.selectedModelAvailable === true}
        nativeAvailable
        translatedPhase={engine.phase}
        canShareReport={false}
        onLoadBundled={noop}
        onSelectExport={noop}
        onLoadSelected={noop}
        onUnload={noop}
        onConversation={noop}
        onDiagnostics={noop}
        onShareReport={noop}
      />
    </AppearanceProvider>
  );
}

test('announces an asynchronously restored folder once on iOS without narrating elapsed measurements', () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
  try {
    const state: EngineState = {
      phase: 'idle',
      contextCapacity: 0,
      selectedModelAvailable: false,
    };
    const view = render(workspace(state));
    expect(announce).not.toHaveBeenCalled();
    const restored = {
      ...state,
      selectedModelAvailable: true,
      selectedModelName: 'Gemma-local',
    };
    view.rerender(workspace(restored));
    expect(screen.getByText('Dossier : Gemma-local')).toBeOnTheScreen();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0][0]).toContain('Gemma-local');
    view.rerender(workspace({ ...restored, loadElapsedMs: 1000 }));
    expect(announce).toHaveBeenCalledTimes(1);
  } finally {
    announce.mockRestore();
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: original,
    });
  }
});
