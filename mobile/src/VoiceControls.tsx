import React from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { ActionButton, Disclosure } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import type { useLocalVoice } from './useLocalVoice';
import type { VoiceInputDiagnostics } from './voice';

function diagnosticText(value: VoiceInputDiagnostics): string {
  return [
    'Diagnostic du micro',
    `Tampons reçus : ${value.bufferCount}`,
    `Trames audio : ${value.frameCount}`,
    `Fréquence : ${value.sampleRate} Hz`,
    `Canaux : ${value.channels}`,
    `Niveau récent : ${
      value.measured ? `${Math.round(value.level * 100)} %` : 'indisponible'
    }`,
    `Niveau maximal : ${
      value.measured ? `${Math.round(value.peak * 100)} %` : 'indisponible'
    }`,
    `Durée : ${Math.round(value.elapsedMs)} ms`,
    `Premier audio : ${
      value.firstBufferDelayMs !== undefined
        ? `${Math.round(value.firstBufferDelayMs)} ms`
        : value.bufferCount > 0
        ? 'délai indisponible'
        : 'non reçu'
    }`,
    `Entrée : ${value.inputPort || 'inconnue'}`,
    ...(value.errorDomain !== undefined
      ? [`Domaine d’erreur : ${value.errorDomain}`]
      : []),
    ...(value.errorCode !== undefined
      ? [`Code d’erreur : ${value.errorCode}`]
      : []),
  ].join('\n');
}

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
  const input = voice.diagnostics;
  const hasAudio = !!input && input.bufferCount > 0;
  const measured = hasAudio && !!input?.measured;
  const levelPercent = measured ? Math.round(input!.level * 100) : 0;
  const inputLabel = !hasAudio
    ? 'En attente d’audio du micro.'
    : !measured
    ? 'Audio reçu · niveau indisponible.'
    : `Audio reçu · niveau ${levelPercent} %.`;
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
      </View>
      <View style={styles.readControl}>
        <Text style={[styles.readLabel, { color: theme.colors.text }]}>
          Lire les réponses
        </Text>
        <Switch
          accessibilityLabel="Lire les réponses à voix haute"
          value={readResponses}
          disabled={!voice.status?.synthesisAvailable}
          onValueChange={onReadResponsesChange}
          style={styles.readSwitch}
        />
      </View>
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.caption, { color: theme.colors.muted }]}
      >
        {voice.phase === 'idle'
          ? voice.status?.reason || labels.idle
          : labels[voice.phase]}
      </Text>
      {voice.phase === 'listening' && (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Niveau du microphone"
          accessibilityValue={
            measured
              ? { min: 0, max: 100, now: levelPercent, text: inputLabel }
              : { text: inputLabel }
          }
          style={styles.inputMeter}
        >
          <Text style={[styles.caption, { color: theme.colors.muted }]}>
            {inputLabel}
          </Text>
          <View
            style={[
              styles.meterTrack,
              { backgroundColor: theme.colors.separator },
            ]}
          >
            <View
              style={[
                styles.meterFill,
                {
                  width: `${levelPercent}%`,
                  backgroundColor: theme.colors.accent,
                },
              ]}
            />
          </View>
        </View>
      )}
      {!!voice.error && (
        <Text
          role="alert"
          style={[styles.caption, { color: theme.colors.danger }]}
        >
          {voice.error}
        </Text>
      )}
      {!!voice.error && input && (
        <Disclosure
          title="Diagnostic du micro"
          description="Détails à sélectionner et copier pour signaler le problème."
        >
          <Text
            selectable
            accessibilityLabel="Mesures du diagnostic du micro"
            style={[styles.caption, { color: theme.colors.muted }]}
          >
            {diagnosticText(input)}
          </Text>
        </Disclosure>
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
    justifyContent: 'space-between',
    minHeight: 44,
    width: '100%',
    gap: 8,
  },
  readLabel: { ...uiGrammar.type.caption, flexShrink: 1 },
  readSwitch: { flexShrink: 0 },
  caption: uiGrammar.type.caption,
  inputMeter: { gap: 6 },
  meterTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  meterFill: { height: 6, borderRadius: 3 },
});
