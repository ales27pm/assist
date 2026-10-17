import React from 'react';
import {
  fireEvent,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { VoiceControls } from '../src/VoiceControls';
import type { useLocalVoice } from '../src/useLocalVoice';
import type { VoiceInputDiagnostics, VoiceStatus } from '../src/voice';

type VoiceController = ReturnType<typeof useLocalVoice>;

function status(extra: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    available: true,
    recognitionAvailable: true,
    synthesisAvailable: true,
    locale: 'fr-CA',
    phase: 'idle',
    ...extra,
  };
}

function controller(extra: Partial<VoiceController> = {}): VoiceController {
  return {
    supported: true,
    streamingSupported: true,
    status: status(),
    phase: 'idle',
    error: '',
    diagnostics: null,
    captureBusy: false,
    startListening: jest.fn(async () => true),
    finishListening: jest.fn(async () => true),
    cancel: jest.fn(async () => true),
    speak: jest.fn(async () => {}),
    beginSpeech: jest.fn(async () => true),
    enqueueSpeech: jest.fn(async () => true),
    finishSpeech: jest.fn(async () => true),
    ...extra,
  };
}

function diagnostics(
  extra: Partial<VoiceInputDiagnostics> = {},
): VoiceInputDiagnostics {
  return {
    bufferCount: 4,
    frameCount: 1920,
    sampleRate: 48_000,
    channels: 1,
    peak: 0.9,
    level: 0.2,
    measured: true,
    elapsedMs: 200,
    inputPort: 'MicrophoneBuiltIn',
    firstBufferDelayMs: 35,
    ...extra,
  };
}

function controls(
  voice: VoiceController,
  options: {
    busy?: boolean;
    readResponses?: boolean;
    onDictate?: () => void;
    onReadResponsesChange?: (enabled: boolean) => void;
  } = {},
) {
  return (
    <VoiceControls
      voice={voice}
      busy={options.busy ?? false}
      readResponses={options.readResponses ?? false}
      onDictate={options.onDictate ?? jest.fn()}
      onReadResponsesChange={options.onReadResponsesChange ?? jest.fn()}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('unknown capabilities remain a verification state without starting audio', async () => {
  const voice = controller({ status: null });
  const onDictate = jest.fn();
  await renderAsync(controls(voice, { onDictate }));

  expect(screen.getByText('Vérification de la voix')).toBeOnTheScreen();
  expect(screen.queryByText('Prêt à dicter')).not.toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Dicter' })).toBeDisabled();
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).toBeDisabled();
  expect(onDictate).not.toHaveBeenCalled();
  expect(voice.startListening).not.toHaveBeenCalled();
  expect(voice.speak).not.toHaveBeenCalled();
  expect(voice.beginSpeech).not.toHaveBeenCalled();
});

test('ready dictation starts only through the explicit user action', async () => {
  const user = userEvent.setup();
  const voice = controller();
  const onDictate = jest.fn();
  await renderAsync(controls(voice, { onDictate }));

  expect(screen.getByText('Prêt à dicter')).toBeOnTheScreen();
  expect(onDictate).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Dicter' }));
  expect(onDictate).toHaveBeenCalledTimes(1);
  expect(voice.startListening).not.toHaveBeenCalled();
  expect(voice.speak).not.toHaveBeenCalled();
});

test('active states route finishing and cancellation to the intended action', async () => {
  const user = userEvent.setup();
  const voice = controller({ phase: 'requesting', captureBusy: true });
  const { rerenderAsync } = await renderAsync(controls(voice));
  expect(screen.getByText('Préparation du micro')).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Dicter' }),
  ).not.toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Annuler la dictée' }));
  expect(voice.cancel).toHaveBeenCalledTimes(1);

  await rerenderAsync(controls({ ...voice, phase: 'listening' }));
  expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Terminer la dictée' }));
  expect(voice.finishListening).toHaveBeenCalledTimes(1);
  expect(voice.cancel).toHaveBeenCalledTimes(1);

  await rerenderAsync(controls({ ...voice, phase: 'finishing' }));
  expect(screen.getByText('Finalisation de la dictée')).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Terminer la dictée' }),
  ).not.toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Annuler la dictée' }),
  ).toBeEnabled();

  await rerenderAsync(
    controls({ ...voice, phase: 'speaking', captureBusy: false }),
  );
  expect(screen.getByText('Lecture en cours')).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Annuler la dictée' }),
  ).not.toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Arrêter la lecture' }));
  expect(voice.cancel).toHaveBeenCalledTimes(2);
});

test('stopping presents its own state without offering a misleading cancellation', async () => {
  await renderAsync(
    controls(controller({ phase: 'stopping', captureBusy: true })),
  );

  expect(screen.getByText('Arrêt en cours')).toBeOnTheScreen();
  for (const name of [
    'Dicter',
    'Terminer la dictée',
    'Annuler la dictée',
    'Arrêter la lecture',
  ]) {
    expect(screen.queryByRole('button', { name })).not.toBeOnTheScreen();
  }
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).toBeOnTheScreen();
});

test('generation pauses dictation while keeping the independent reading preference available', async () => {
  const onReadResponsesChange = jest.fn();
  const onDictate = jest.fn();
  await renderAsync(
    controls(controller(), { busy: true, onReadResponsesChange, onDictate }),
  );

  expect(screen.getByText('Dictée en pause')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Dicter' })).toBeDisabled();
  const toggle = screen.getByRole('switch', {
    name: 'Lire les réponses à voix haute',
  });
  expect(toggle).toBeEnabled();
  // Switch valueChange has no equivalent userEvent interaction in RNTL 13.
  fireEvent(toggle, 'valueChange', true);
  expect(onReadResponsesChange).toHaveBeenCalledWith(true);
  expect(onDictate).not.toHaveBeenCalled();
});

test('an optional voice error during generation preserves the alert without claiming the message is editable', async () => {
  const message = 'La lecture vocale s’est arrêtée.';
  await renderAsync(controls(controller({ error: message }), { busy: true }));

  expect(screen.getByText('Dictée en pause')).toBeOnTheScreen();
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('button', { name: 'Dicter' })).toBeDisabled();
  expect(
    screen.queryByText('Tu peux toujours écrire ton message.'),
  ).not.toBeOnTheScreen();
});

test('recognition and synthesis availability disable only their respective controls', async () => {
  const reason = 'Reconnaissance locale fr-CA indisponible.';
  const voice = controller({
    status: status({ recognitionAvailable: false, reason }),
  });
  const { rerenderAsync } = await renderAsync(controls(voice));

  expect(screen.getByText('Dictée indisponible')).toBeOnTheScreen();
  expect(screen.getByText(reason)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Dicter' })).toBeDisabled();
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).toBeEnabled();

  await rerenderAsync(
    controls({ ...voice, status: status({ synthesisAvailable: false }) }),
  );
  expect(screen.getByText('Prêt à dicter')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Dicter' })).toBeEnabled();
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).toBeDisabled();

  await rerenderAsync(
    controls({
      ...voice,
      status: status({
        available: false,
        recognitionAvailable: false,
        synthesisAvailable: false,
        reason,
      }),
    }),
  );
  expect(screen.getByText('Voix indisponible')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Dicter' })).toBeDisabled();
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).toBeDisabled();
});

test('an interrupted voice keeps its useful diagnostic behind an explicit disclosure', async () => {
  const user = userEvent.setup();
  const message = 'La dictée n’a pas pu se terminer. Réessaie.';
  await renderAsync(
    controls(
      controller({
        error: message,
        diagnostics: diagnostics({
          errorDomain: 'SyntheticSpeechDomain',
          errorCode: 1101,
        }),
      }),
    ),
  );

  expect(screen.getByText('Voix interrompue')).toBeOnTheScreen();
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('alert')).not.toHaveTextContent(
    /SyntheticSpeechDomain/,
  );
  const disclosure = screen.getByRole('button', {
    name: 'Diagnostic du micro',
  });
  expect(disclosure).toBeCollapsed();
  expect(
    screen.queryByLabelText('Mesures du diagnostic du micro'),
  ).not.toBeOnTheScreen();
  await user.press(disclosure);
  expect(
    screen.getByRole('button', { name: 'Diagnostic du micro' }),
  ).toBeExpanded();
  const report = screen.getByLabelText('Mesures du diagnostic du micro');
  expect(report).toHaveTextContent(/Tampons reçus : 4/);
  expect(report).toHaveTextContent(/Domaine d’erreur : SyntheticSpeechDomain/);
  expect(report).toHaveProp('selectable', true);
});

test('input observations change the accessible meter while the conversation state stays stable', async () => {
  const voice = controller({ phase: 'listening', captureBusy: true });
  const { rerenderAsync } = await renderAsync(controls(voice));
  expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
  const stateName: string =
    screen.getByLabelText(/^À ton écoute\./).props['aria-label'];
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({ text: 'En attente d’audio du micro.' });

  await rerenderAsync(
    controls({ ...voice, diagnostics: diagnostics({ measured: false }) }),
  );
  expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
  expect(screen.getByLabelText(stateName)).toHaveAccessibleName(stateName);
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({ text: 'Audio reçu · niveau indisponible.' });

  await rerenderAsync(
    controls({ ...voice, diagnostics: diagnostics({ level: 0.8 }) }),
  );
  expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
  expect(screen.getByLabelText(stateName)).toHaveAccessibleName(stateName);
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({
    min: 0,
    max: 100,
    now: 80,
    text: 'Audio reçu · niveau 80 %.',
  });
  expect(voice.finishListening).not.toHaveBeenCalled();
  expect(voice.startListening).not.toHaveBeenCalled();
});

test('the controlled reading switch remains available throughout dictation and its completion', async () => {
  const voice = controller();
  const onReadResponsesChange = jest.fn();
  const { rerenderAsync } = await renderAsync(
    controls(voice, { readResponses: true, onReadResponsesChange }),
  );
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).toBeChecked();
  for (const phase of ['listening', 'finishing', 'idle'] as const) {
    await rerenderAsync(
      controls(
        { ...voice, phase },
        { readResponses: true, onReadResponsesChange },
      ),
    );
    expect(
      screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
    ).toBeChecked();
  }
  expect(onReadResponsesChange).not.toHaveBeenCalled();
  expect(voice.speak).not.toHaveBeenCalled();
  expect(voice.beginSpeech).not.toHaveBeenCalled();
});
