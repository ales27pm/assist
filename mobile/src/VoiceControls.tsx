import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
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
  const states = {
    requesting: {
      title: 'Préparation du micro',
      description: 'Autorise le micro et la reconnaissance si iOS le demande.',
    },
    listening: {
      title: 'À ton écoute',
      description: 'Termine la dictée, puis vérifie ton message.',
    },
    finishing: {
      title: 'Finalisation de la dictée',
      description: 'Attends le texte final avant d’envoyer.',
    },
    speaking: {
      title: 'Lecture en cours',
      description: 'Le micro est fermé. Tu peux arrêter la lecture.',
    },
    stopping: {
      title: 'Arrêt en cours',
      description: 'Attends avant de recommencer.',
    },
  };
  const state =
    voice.phase !== 'idle'
      ? states[voice.phase]
      : voice.error && !busy
      ? {
          title: 'Voix interrompue',
          description: 'Tu peux toujours écrire ton message.',
        }
      : !voice.status
      ? {
          title: 'Vérification de la voix',
          description: 'Recherche des fonctions locales disponibles…',
        }
      : !voice.status.recognitionAvailable
      ? {
          title: voice.status.synthesisAvailable
            ? 'Dictée indisponible'
            : 'Voix indisponible',
          description:
            voice.status.reason || 'La saisie au clavier reste disponible.',
        }
      : busy
      ? {
          title: 'Dictée en pause',
          description: 'Termine l’opération en cours avant de dicter.',
        }
      : {
          title: 'Prêt à dicter',
          description: 'Dicte, puis vérifie le texte avant d’envoyer.',
        };
  const waiting =
    ['requesting', 'finishing', 'stopping'].includes(voice.phase) ||
    (voice.phase === 'idle' && !voice.status && !voice.error);
  const stateColor =
    voice.error && voice.phase === 'idle'
      ? theme.colors.danger
      : voice.phase === 'listening' || voice.phase === 'speaking'
      ? theme.colors.accent
      : theme.colors.muted;
  return (
    <View style={styles.container}>
      <View style={styles.stateRow}>
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={styles.stateIndicator}
        >
          {waiting ? (
            <ActivityIndicator size="small" color={stateColor} />
          ) : (
            <View style={[styles.stateDot, { backgroundColor: stateColor }]} />
          )}
        </View>
        <View
          accessible
          aria-label={`${state.title}. ${state.description}`}
          accessibilityLiveRegion="polite"
          style={styles.stateCopy}
        >
          <Text style={[styles.stateTitle, { color: theme.colors.text }]}>
            {state.title}
          </Text>
          <Text style={[styles.caption, { color: theme.colors.muted }]}>
            {state.description}
          </Text>
        </View>
      </View>
      {voice.phase !== 'stopping' && (
        <View style={styles.controls}>
          {voice.phase === 'speaking' && (
            <ActionButton
              label="Arrêter la lecture"
              primary
              onPress={voice.cancel}
            />
          )}
          {voice.phase === 'idle' || voice.phase === 'speaking' ? (
            <ActionButton
              label="Dicter"
              hint="Utilise la reconnaissance locale en français canadien."
              primary={voice.phase === 'idle'}
              disabled={busy || !voice.status?.recognitionAvailable}
              onPress={onDictate}
            />
          ) : voice.phase === 'listening' ? (
            <ActionButton
              label="Terminer la dictée"
              primary
              onPress={voice.finishListening}
            />
          ) : null}
          {voice.phase !== 'idle' && voice.phase !== 'speaking' && (
            <ActionButton label="Annuler la dictée" onPress={voice.cancel} />
          )}
        </View>
      )}
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
          <View
            accessible={false}
            importantForAccessibility="no-hide-descendants"
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
          <Text style={[styles.caption, { color: theme.colors.muted }]}>
            {inputLabel}
          </Text>
        </View>
      )}
      <View
        style={[styles.readControl, { borderColor: theme.colors.separator }]}
      >
        <View style={styles.readCopy}>
          <Text style={[styles.readLabel, { color: theme.colors.text }]}>
            Lire les réponses
          </Text>
          <Text style={[styles.caption, { color: theme.colors.muted }]}>
            {!voice.status
              ? 'Vérification de la lecture…'
              : voice.status.synthesisAvailable
              ? 'Lecture facultative à voix haute.'
              : 'Aucune voix locale disponible.'}
          </Text>
        </View>
        <Switch
          accessibilityLabel="Lire les réponses à voix haute"
          value={readResponses}
          disabled={!voice.status?.synthesisAvailable}
          aria-disabled={!voice.status?.synthesisAvailable}
          hitSlop={8}
          onValueChange={onReadResponsesChange}
          style={styles.readSwitch}
        />
      </View>
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
  container: { gap: 10 },
  stateRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stateIndicator: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  stateCopy: { flex: 1, minWidth: 0, gap: 2 },
  stateTitle: { ...uiGrammar.type.label, fontWeight: '600' },
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
    minHeight: 52,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    width: '100%',
    gap: 12,
  },
  readCopy: { flex: 1, minWidth: 0, gap: 2 },
  readLabel: { ...uiGrammar.type.label, fontWeight: '500' },
  readSwitch: { flexShrink: 0 },
  caption: uiGrammar.type.caption,
  inputMeter: { gap: 6 },
  meterTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  meterFill: { height: 6, borderRadius: 3 },
});
