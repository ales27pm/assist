import React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppearanceProvider } from '../src/appearance';
import { ModelWorkspace } from '../src/ModelWorkspace';
import type { EngineState } from '../src/protocol';

const noop = () => undefined;
function workspace(
  engine: EngineState,
  overrides: Partial<React.ComponentProps<typeof ModelWorkspace>> = {},
) {
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
        {...overrides}
      />
    </AppearanceProvider>
  );
}

test.each([false, undefined])(
  'offers a visible folder choice when bundled availability is %s',
  bundledModelAvailable => {
    const onSelectExport = jest.fn();
    const onLoadBundled = jest.fn();
    const onLoadSelected = jest.fn();
    render(
      workspace(
        { phase: 'idle', contextCapacity: 0, bundledModelAvailable },
        { onSelectExport, onLoadBundled, onLoadSelected },
      ),
    );

    const choose = screen.getByRole('button', {
      name: 'Choisir un dossier exporté',
    });
    expect(choose).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Charger Gemma intégré' }),
    ).not.toBeOnTheScreen();
    expect(screen.getByRole('heading', { name: 'Modèle' })).toBeOnTheScreen();
    expect(
      screen.queryByRole('heading', { name: 'Préparer l’assistant' }),
    ).not.toBeOnTheScreen();
    expect(
      screen.getByText(
        bundledModelAvailable === false
          ? 'Gemma n’est pas intégré à cette build.'
          : 'Disponibilité du modèle intégré non confirmée.',
      ),
    ).toBeOnTheScreen();
    fireEvent.press(choose);
    expect(onSelectExport).toHaveBeenCalledTimes(1);
    expect(onLoadBundled).not.toHaveBeenCalled();
    expect(onLoadSelected).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole('button', { name: 'Importer un modèle' }));
    expect(
      screen.getByText(/Dans Fichiers, place le dossier exporté/),
    ).toBeOnTheScreen();
    expect(
      screen.getAllByRole('button', { name: 'Choisir un dossier exporté' }),
    ).toHaveLength(1);
  },
);

test('loads a confirmed bundled model only when explicitly requested', () => {
  const onLoadBundled = jest.fn();
  render(
    workspace(
      { phase: 'idle', contextCapacity: 0, bundledModelAvailable: true },
      { onLoadBundled },
    ),
  );
  expect(onLoadBundled).not.toHaveBeenCalled();
  fireEvent.press(
    screen.getByRole('button', { name: 'Charger Gemma intégré' }),
  );
  expect(onLoadBundled).toHaveBeenCalledTimes(1);
});

test('prioritizes the selected folder over the bundled model without auto-loading', () => {
  const onLoadSelected = jest.fn();
  const onLoadBundled = jest.fn();
  render(
    workspace(
      {
        phase: 'idle',
        contextCapacity: 0,
        selectedModelAvailable: true,
        selectedModelName: 'Mon export local',
        bundledModelAvailable: true,
      },
      { onLoadSelected, onLoadBundled },
    ),
  );
  expect(screen.getByText('Dossier : Mon export local')).toBeOnTheScreen();
  expect(
    screen.getAllByRole('button', { name: 'Charger le modèle' }),
  ).toHaveLength(1);
  expect(
    screen.queryByRole('button', { name: 'Charger Gemma intégré' }),
  ).not.toBeOnTheScreen();
  expect(onLoadSelected).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Charger le modèle' }));
  expect(onLoadSelected).toHaveBeenCalledTimes(1);
  expect(onLoadBundled).not.toHaveBeenCalled();
});

test('keeps an explicit secondary switch from a selected folder to the bundled model', () => {
  const onLoadSelected = jest.fn();
  const onLoadBundled = jest.fn();
  const engine: EngineState = {
    phase: 'idle',
    contextCapacity: 0,
    selectedModelAvailable: true,
    bundledModelAvailable: true,
  };
  const view = render(workspace(engine, { onLoadSelected, onLoadBundled }));
  fireEvent.press(screen.getByRole('button', { name: 'Importer un modèle' }));
  const bundled = screen.getByRole('button', { name: 'Charger Gemma intégré' });
  expect(bundled).toBeEnabled();
  expect(onLoadBundled).not.toHaveBeenCalled();
  expect(onLoadSelected).not.toHaveBeenCalled();
  fireEvent.press(bundled);
  expect(onLoadBundled).toHaveBeenCalledTimes(1);
  expect(onLoadSelected).not.toHaveBeenCalled();

  view.rerender(workspace(engine, { onLoadBundled, busy: true }));
  expect(
    screen.getByRole('button', { name: 'Charger Gemma intégré' }),
  ).toBeDisabled();
  view.rerender(workspace(engine, { onLoadBundled, nativeAvailable: false }));
  expect(
    screen.getByRole('button', { name: 'Charger Gemma intégré' }),
  ).toBeDisabled();
  expect(onLoadBundled).toHaveBeenCalledTimes(1);
});

test('offers conversation and unload actions when the model is ready', () => {
  const onConversation = jest.fn();
  const onUnload = jest.fn();
  render(
    workspace(
      {
        phase: 'ready',
        contextCapacity: 32768,
        selectedModelAvailable: true,
        bundledModelAvailable: true,
      },
      { onConversation, onUnload },
    ),
  );
  expect(
    screen.getByText(
      'Le modèle est chargé. Tu peux reprendre la conversation.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Charger le modèle' }),
  ).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Charger Gemma intégré' }),
  ).not.toBeOnTheScreen();
  fireEvent.press(
    screen.getByRole('button', { name: 'Ouvrir la conversation' }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Décharger' }));
  expect(onConversation).toHaveBeenCalledTimes(1);
  expect(onUnload).toHaveBeenCalledTimes(1);
});

test('pairs a restoration failure with explicit folder recovery without retrying a load', () => {
  const onSelectExport = jest.fn();
  const onLoadSelected = jest.fn();
  const onLoadBundled = jest.fn();
  const message =
    'Le dossier mémorisé n’est plus accessible. Choisis-le à nouveau.';
  render(
    workspace(
      {
        phase: 'idle',
        contextCapacity: 0,
        selectedModelAvailable: false,
        selectedModelError: message,
        bundledModelAvailable: false,
      },
      { onSelectExport, onLoadSelected, onLoadBundled },
    ),
  );
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(onSelectExport).not.toHaveBeenCalled();
  const recover = screen.getByRole('button', {
    name: 'Choisir à nouveau le dossier',
  });
  expect(recover).toBeEnabled();
  expect(
    screen.queryByRole('button', { name: 'Choisir un dossier exporté' }),
  ).not.toBeOnTheScreen();
  fireEvent.press(recover);
  expect(onSelectExport).toHaveBeenCalledTimes(1);
  expect(onLoadSelected).not.toHaveBeenCalled();
  expect(onLoadBundled).not.toHaveBeenCalled();
});

test.each([{ busy: true }, { nativeAvailable: false }, { ready: true }])(
  'guards folder recovery with %o',
  guard => {
    const onSelectExport = jest.fn();
    render(
      workspace(
        {
          phase: 'idle',
          contextCapacity: 0,
          selectedModelAvailable: false,
          selectedModelError: 'Choisis à nouveau le dossier local.',
        },
        { onSelectExport, ...guard },
      ),
    );
    const recover = screen.getByRole('button', {
      name: 'Choisir à nouveau le dossier',
    });
    expect(recover).toBeDisabled();
    fireEvent.press(recover);
    expect(onSelectExport).not.toHaveBeenCalled();
  },
);

test.each([
  {
    phase: 'idle',
    selectedModelAvailable: false,
    bundledModelAvailable: false,
    label: 'Choisir un dossier exporté',
  },
  {
    phase: 'idle',
    selectedModelAvailable: false,
    bundledModelAvailable: true,
    label: 'Charger Gemma intégré',
  },
  {
    phase: 'idle',
    selectedModelAvailable: true,
    bundledModelAvailable: true,
    label: 'Charger le modèle',
  },
  {
    phase: 'ready',
    selectedModelAvailable: true,
    bundledModelAvailable: true,
    label: 'Ouvrir la conversation',
  },
] as const)(
  'guards $label when busy or native functionality is unavailable',
  ({ label, ...state }) => {
    const action = jest.fn();
    const engine = { ...state, contextCapacity: 0 };
    const actions = {
      onConversation: action,
      onLoadBundled: action,
      onLoadSelected: action,
      onSelectExport: action,
    };
    const view = render(workspace(engine, { ...actions, busy: true }));
    expect(screen.getByRole('button', { name: label })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: label }));
    view.rerender(workspace(engine, { ...actions, nativeAvailable: false }));
    expect(screen.getByRole('button', { name: label })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: label }));
    expect(action).not.toHaveBeenCalled();
  },
);

test('announces an asynchronously restored folder once on iOS without narrating elapsed measurements', () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
  announce.mockClear();
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
