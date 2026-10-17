import React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { renderAsync, screen } from '@testing-library/react-native';
import {
  VoiceConversationScreen,
  VoiceConversationScreenProps,
} from '../src/VoiceConversationScreen';

function props(
  extra: Partial<VoiceConversationScreenProps> = {},
): VoiceConversationScreenProps {
  return {
    phase: 'listening',
    transcript: '',
    reply: '',
    readResponses: true,
    onPause: jest.fn(),
    onResume: jest.fn(),
    onInterrupt: jest.fn(),
    onClose: jest.fn(),
    onSettings: jest.fn(),
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('native phase and error updates announce once, independent of streamed content and microphone samples', async () => {
  const announcement = jest.spyOn(
    AccessibilityInfo,
    'announceForAccessibilityWithOptions',
  );
  const state = props();
  const { rerenderAsync } = await renderAsync(
    <VoiceConversationScreen {...state} />,
  );
  expect(announcement).not.toHaveBeenCalled();
  await rerenderAsync(
    <VoiceConversationScreen
      {...state}
      transcript="Voici mon message."
      diagnostics={{
        bufferCount: 8,
        frameCount: 3840,
        sampleRate: 48_000,
        channels: 1,
        peak: 0.5,
        level: 0.2,
        measured: true,
        elapsedMs: 400,
        inputPort: 'MicrophoneBuiltIn',
      }}
    />,
  );
  expect(screen.getByText('Voici mon message.')).toHaveAccessibleName(
    'Voici mon message.',
  );
  expect(announcement).not.toHaveBeenCalled();

  await rerenderAsync(<VoiceConversationScreen {...state} phase="thinking" />);
  expect(announcement).toHaveBeenCalledWith(
    'Je prépare la réponse. Touche Interrompre pour reprendre la parole.',
    { priority: 'low' },
  );
  const message = 'La reconnaissance locale s’est arrêtée.';
  await rerenderAsync(
    <VoiceConversationScreen {...state} phase="error" error={message} />,
  );
  expect(announcement).toHaveBeenCalledTimes(2);
  expect(announcement).toHaveBeenLastCalledWith(
    `Mode vocal interrompu. Reprends pour réessayer, ou ferme le mode vocal. ${message}`,
    { priority: 'low' },
  );
  expect(screen.getByRole('alert')).toHaveTextContent(message);
});

test('streamed replies remain readable without a second announcement during app speech', async () => {
  const announcement = jest.spyOn(
    AccessibilityInfo,
    'announceForAccessibilityWithOptions',
  );
  const state = props({ phase: 'thinking' });
  const { rerenderAsync } = await renderAsync(
    <VoiceConversationScreen {...state} />,
  );
  for (const reply of ['La réponse', 'La réponse locale complète.']) {
    await rerenderAsync(
      <VoiceConversationScreen {...state} phase="speaking" reply={reply} />,
    );
    expect(screen.getByText(reply)).toHaveAccessibleName(reply);
    expect(screen.getByText(reply)).toHaveProp('selectable', true);
    expect(screen.getByText(reply).props.accessibilityLiveRegion).not.toBe(
      'polite',
    );
  }
  expect(announcement).not.toHaveBeenCalled();
  await rerenderAsync(
    <VoiceConversationScreen
      {...state}
      phase="paused"
      reply="La réponse locale complète."
    />,
  );
  expect(announcement).toHaveBeenCalledTimes(1);
  expect(announcement).toHaveBeenCalledWith(
    'En pause. Le micro et la lecture sont arrêtés. Reprends quand tu veux.',
    { priority: 'low' },
  );
});

test('web retains one polite phase region and an assertive error without native announcements', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const announcement = jest.spyOn(
    AccessibilityInfo,
    'announceForAccessibilityWithOptions',
  );
  const state = props();
  const { rerenderAsync } = await renderAsync(
    <VoiceConversationScreen {...state} />,
  );
  expect(screen.getByLabelText(/^À ton écoute\./)).toHaveProp(
    'accessibilityLiveRegion',
    'polite',
  );
  await rerenderAsync(
    <VoiceConversationScreen
      {...state}
      phase="error"
      error="Le micro est indisponible."
    />,
  );
  expect(screen.getByRole('alert')).toHaveProp(
    'accessibilityLiveRegion',
    'assertive',
  );
  expect(announcement).not.toHaveBeenCalled();
});
