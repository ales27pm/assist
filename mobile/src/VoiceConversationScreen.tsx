import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAppearance } from './appearance';
import { ActionButton, Disclosure } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import type { VoiceInputDiagnostics } from './voice';

export type VoiceConversationPhase =
  | 'starting'
  | 'listening'
  | 'finishing'
  | 'thinking'
  | 'speaking'
  | 'stopping'
  | 'paused'
  | 'error';

export type VoiceConversationScreenProps = {
  phase: VoiceConversationPhase;
  transcript: string;
  reply: string;
  replyInterrupted?: boolean;
  error?: string;
  diagnostics?: VoiceInputDiagnostics | null;
  audioDiagnostics?: string[];
  readResponses: boolean;
  /** Native monitoring is armed; requesting it alone must not set this flag. */
  bargeInReady?: boolean;
  onPause: () => void;
  onResume: () => void;
  onInterrupt: () => void;
  onClose: () => void;
  onSettings: () => void;
};

const states: Record<
  VoiceConversationPhase,
  { title: string; description: string }
> = {
  starting: {
    title: 'Préparation du mode vocal',
    description: 'Le micro démarre. Autorise son accès si iOS le demande.',
  },
  listening: {
    title: 'À ton écoute',
    description: 'Parle, puis laisse une pause pour terminer ton tour.',
  },
  finishing: {
    title: 'Je termine ton message',
    description: 'Le texte se stabilise avant la réponse.',
  },
  thinking: {
    title: 'Je prépare la réponse',
    description: 'Touche Interrompre pour reprendre la parole.',
  },
  speaking: {
    title: 'Réponse vocale',
    description: 'Touche Interrompre pour reprendre la parole.',
  },
  paused: {
    title: 'En pause',
    description: 'Le micro et la lecture sont arrêtés. Reprends quand tu veux.',
  },
  stopping: {
    title: 'Arrêt du mode vocal',
    description: 'Le micro et la lecture se ferment.',
  },
  error: {
    title: 'Mode vocal interrompu',
    description: 'Reprends pour réessayer, ou ferme le mode vocal.',
  },
};

/** Presentation only: the caller owns microphone, turn detection and playback. */
export function VoiceConversationScreen({
  phase,
  transcript,
  reply,
  replyInterrupted = false,
  error,
  diagnostics,
  audioDiagnostics,
  readResponses,
  bargeInReady = false,
  onPause,
  onResume,
  onInterrupt,
  onClose,
  onSettings,
}: VoiceConversationScreenProps) {
  const { theme } = useAppearance();
  const { colors } = theme;
  const state = states[phase];
  const monitoringResponse =
    bargeInReady && (phase === 'thinking' || phase === 'speaking');
  const description = monitoringResponse
    ? 'Parle pour m’interrompre, ou touche Interrompre.'
    : state.description;
  const monitoringLabel = monitoringResponse
    ? 'Micro actif pendant la réponse.'
    : '';
  const paused = phase === 'paused' || phase === 'error';
  const waiting =
    phase === 'starting' ||
    phase === 'finishing' ||
    phase === 'thinking' ||
    phase === 'stopping';
  const hasAudio = !!diagnostics && diagnostics.bufferCount > 0;
  const measured = hasAudio && diagnostics?.measured === true;
  const level = measured ? Math.round(diagnostics!.level * 100) : 0;
  const inputLabel = !hasAudio
    ? 'En attente d’audio du micro.'
    : measured
    ? `Audio reçu · niveau ${level} %.`
    : 'Audio reçu · niveau indisponible.';
  const statusColor = phase === 'error' ? colors.danger : colors.accent;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <Text role="heading" style={[styles.title, { color: colors.text }]}>
          Mode vocal
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          On reste sur cet appareil.
        </Text>
        <View style={styles.navigation}>
          <View style={styles.actionSlot}>
            <ActionButton label="Réglages du mode vocal" onPress={onSettings} />
          </View>
          <View style={styles.actionSlot}>
            <ActionButton label="Fermer le mode vocal" onPress={onClose} />
          </View>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentBody}
        keyboardShouldPersistTaps="handled"
      >
        <View
          accessible
          aria-label={`${state.title}. ${monitoringLabel ? `${monitoringLabel} ` : ''}${description}`}
          accessibilityLiveRegion="polite"
          style={[styles.state, { borderColor: colors.separator }]}
        >
          {waiting && (
            <View
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.waiting}
            >
              <ActivityIndicator size="small" color={statusColor} />
            </View>
          )}
          <Text style={[styles.stateTitle, { color: statusColor }]}>
            {state.title}
          </Text>
          {monitoringResponse && (
            <Text style={[styles.caption, { color: colors.text }]}>
              {monitoringLabel}
            </Text>
          )}
          <Text style={[styles.body, { color: colors.muted }]}>
            {description}
          </Text>
        </View>

        {phase === 'listening' && (
          <View
            accessible
            role="progressbar"
            aria-label="Niveau du microphone"
            accessibilityValue={
              measured
                ? { min: 0, max: 100, now: level, text: inputLabel }
                : { text: inputLabel }
            }
            style={styles.meter}
          >
            <View
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.meterTrack, { backgroundColor: colors.separator }]}
            >
              <View
                style={[
                  styles.meterFill,
                  { width: `${level}%`, backgroundColor: colors.accent },
                ]}
              />
            </View>
            <Text style={[styles.caption, { color: colors.muted }]}>
              {inputLabel}
            </Text>
          </View>
        )}

        {!!error && (
          <Text role="alert" style={[styles.body, { color: colors.danger }]}>
            {error}
          </Text>
        )}

        {!!error && !!audioDiagnostics?.length && (
          <Disclosure
            title="Détails audio"
            description="Informations locales pour signaler cette interruption."
          >
            <Text selectable style={[styles.caption, { color: colors.muted }]}>
              {audioDiagnostics.join('\n')}
            </Text>
          </Disclosure>
        )}

        <View style={styles.message}>
          <Text
            role="heading"
            style={[styles.messageTitle, { color: colors.muted }]}
          >
            Ton message
          </Text>
          <Text
            selectable
            style={[
              styles.body,
              { color: transcript ? colors.text : colors.muted },
            ]}
          >
            {transcript || 'Ton prochain message apparaîtra ici.'}
          </Text>
        </View>
        <View style={styles.message}>
          <Text
            role="heading"
            style={[styles.messageTitle, { color: colors.muted }]}
          >
            {replyInterrupted ? 'Réponse interrompue' : 'Réponse de l’assistant'}
          </Text>
          <Text
            selectable
            style={[styles.body, { color: reply ? colors.text : colors.muted }]}
          >
            {reply || 'La réponse apparaîtra ici.'}
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.footer, { borderColor: colors.separator }]}>
        <Text style={[styles.caption, { color: colors.muted }]}>
          {readResponses
            ? 'Lecture automatique activée · modifiable dans Réglages.'
            : 'Lecture automatique désactivée · les réponses restent visibles.'}
        </Text>
        <View style={styles.actions}>
          <View style={styles.actionSlot}>
            <ActionButton
              label={
                phase === 'stopping'
                  ? 'Arrêt en cours'
                  : paused
                  ? 'Reprendre'
                  : 'Mettre en pause'
              }
              primary
              disabled={phase === 'stopping'}
              onPress={paused ? onResume : onPause}
            />
          </View>
          {(phase === 'thinking' || phase === 'speaking') && (
            <View style={styles.actionSlot}>
              <ActionButton
                label="Interrompre"
                hint="Arrête la réponse et reprend l’écoute."
                onPress={onInterrupt}
              />
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, paddingHorizontal: uiGrammar.gutter },
  header: { gap: 8, paddingTop: 16, paddingBottom: 16 },
  title: { ...uiGrammar.type.title, fontWeight: '600' },
  navigation: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionSlot: { flexGrow: 1, flexBasis: 120, minWidth: 0, maxWidth: '100%' },
  content: { flex: 1, minHeight: 0 },
  contentBody: { gap: uiGrammar.harmony.space.section, paddingBottom: 24 },
  state: {
    gap: 8,
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stateTitle: { ...uiGrammar.type.navigation, fontWeight: '600' },
  waiting: { alignItems: 'flex-start' },
  message: { gap: 8 },
  messageTitle: { ...uiGrammar.type.label, fontWeight: '600' },
  body: uiGrammar.type.body,
  caption: uiGrammar.type.caption,
  meter: { gap: 8 },
  meterTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  meterFill: { height: 8, borderRadius: 4 },
  footer: {
    gap: 12,
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
