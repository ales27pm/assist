import React from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { ActionButton } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import type { useLocalVoice } from './useLocalVoice';

export function VoiceControls({
  voice,
  busy,
  readResponses,
  onReadResponsesChange,
  onDictate,
}: {
  voice: ReturnType<typeof useLocalVoice>;
  busy: boolean;
  readResponses: boolean;
  onReadResponsesChange: (enabled: boolean) => void;
  onDictate: () => void;
}) {
  const { theme } = useAppearance();
  if (!voice.supported) return null;
  const labels = {
    idle: 'Dicte, puis vérifie le texte avant d’envoyer.',
    requesting: 'Autorisation du micro…',
    listening: 'Écoute en cours · touche Terminer la dictée quand tu as fini.',
    finishing: 'Finalisation de la dictée…',
    speaking: 'Lecture en cours · le micro est fermé.',
    stopping: 'Arrêt de la voix…',
  };
  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        {voice.phase === 'idle' || voice.phase === 'speaking' ? (
          <ActionButton
            label="Dicter"
            hint="Utilise la reconnaissance locale en français canadien."
            disabled={busy || !voice.status?.recognitionAvailable}
            onPress={onDictate}
          />
        ) : voice.phase === 'listening' ? (
          <ActionButton
            label="Terminer la dictée"
            onPress={voice.finishListening}
          />
        ) : null}
        {voice.phase !== 'idle' && (
          <ActionButton
            label={
              voice.phase === 'speaking'
                ? 'Arrêter la lecture'
                : 'Annuler la dictée'
            }
            disabled={voice.phase === 'stopping'}
            onPress={voice.cancel}
          />
        )}
        <View style={styles.readControl}>
          <Text style={[styles.caption, { color: theme.colors.text }]}>
            Lire les réponses
          </Text>
          <Switch
            accessibilityLabel="Lire les réponses à voix haute"
            value={readResponses}
            disabled={!voice.status?.synthesisAvailable}
            onValueChange={onReadResponsesChange}
          />
        </View>
      </View>
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.caption, { color: theme.colors.muted }]}
      >
        {voice.phase === 'idle'
          ? voice.status?.reason || labels.idle
          : labels[voice.phase]}
      </Text>
      {!!voice.error && (
        <Text
          role="alert"
          style={[styles.caption, { color: theme.colors.danger }]}
        >
          {voice.error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  readControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  caption: uiGrammar.type.caption,
});
