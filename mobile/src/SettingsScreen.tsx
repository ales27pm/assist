import React, { useEffect, useId, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAppearance } from './appearance';
import { InterfaceIcon } from './InterfaceIcon';
import { uiGrammar } from './uiGrammar';
import { ScreenHeading, SettingsRow, SurfaceGroup } from './uiPrimitives';
import { VoiceComparisonPanel } from './VoiceComparisonPanel';
import { AdvancedVoicePanel } from './AdvancedVoicePanel';
import { DeviceToolsPanel } from './DeviceToolsPanel';
import { scheduleAccessibilityFocus } from './focusAccessibility';

type Props = {
  modelStatus: string;
  budget: string;
  budgetError: string;
  busy: boolean;
  responseOpen: boolean;
  onToggleResponse: () => void;
  onBudgetChange: (text: string) => void;
  onModel: () => void;
  onAppearance: () => void;
  appearanceRef: React.Ref<React.ComponentRef<typeof View>>;
  headingRef?: React.Ref<React.ComponentRef<typeof Text>>;
  readResponses?: boolean;
  onReadResponsesChange?: (enabled: boolean) => void;
  voiceAvailable?: boolean;
};

export function SettingsScreen({
  modelStatus,
  budget,
  budgetError,
  busy,
  responseOpen,
  onToggleResponse,
  onBudgetChange,
  onModel,
  onAppearance,
  appearanceRef,
  headingRef,
  readResponses = true,
  onReadResponsesChange,
  voiceAvailable = true,
}: Props) {
  const { theme } = useAppearance();
  const { colors } = theme;
  const [comparingVoices, setComparingVoices] = useState(false);
  const [advancedVoice, setAdvancedVoice] = useState(false);
  const [deviceTools, setDeviceTools] = useState(false);
  const deviceToolsControl = useRef<React.ComponentRef<typeof View>>(null);
  const wasDeviceTools = useRef(false);
  useEffect(() => {
    const restore = wasDeviceTools.current && !deviceTools;
    wasDeviceTools.current = deviceTools;
    if (restore)
      return scheduleAccessibilityFocus(() => deviceToolsControl.current);
  }, [deviceTools]);
  const advancedVoiceControl = useRef<React.ComponentRef<typeof View>>(null);
  const wasAdvancedVoice = useRef(false);
  useEffect(() => {
    const restore = wasAdvancedVoice.current && !advancedVoice;
    wasAdvancedVoice.current = advancedVoice;
    if (restore)
      return scheduleAccessibilityFocus(() => advancedVoiceControl.current);
  }, [advancedVoice]);
  const comparisonControl = useRef<React.ComponentRef<typeof View>>(null);
  const wasComparingVoices = useRef(false);
  useEffect(() => {
    const restore = wasComparingVoices.current && !comparingVoices;
    wasComparingVoices.current = comparingVoices;
    if (restore)
      return scheduleAccessibilityFocus(() => comparisonControl.current);
  }, [comparingVoices]);
  // RN Web 0.21 uses this prop for the checked thumb; native uses thumbColor.
  const webSwitchProps =
    Platform.OS === 'web' ? { activeThumbColor: colors.onAccent } : {};
  const descriptionId = useId();
  const responseValueId = `${descriptionId}-response`;
  const budgetHintId = `${descriptionId}-budget-hint`;
  const budgetErrorId = `${descriptionId}-budget-error`;
  const budgetAccessoryId = `${descriptionId}-budget-keyboard`;
  const voiceHintId = `${descriptionId}-voice-hint`;
  const budgetHint = 'En jetons (fragments de mots). Vide : contexte restant.';
  const responseValue = budgetError
    ? 'À corriger'
    : budget
    ? `${budget} jetons`
    : 'Limite facultative';
  const voiceHint = voiceAvailable
    ? 'Lecture automatique dans le mode vocal.'
    : 'Voix locale indisponible. Tu peux désactiver la lecture automatique.';
  const previousStatus = useRef({ modelStatus, budgetError });

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = { modelStatus, budgetError };
    if (Platform.OS !== 'ios') {
      return;
    }
    const updates = [
      previous.modelStatus !== modelStatus ? `Modèle. ${modelStatus}` : '',
      budgetError && previous.budgetError !== budgetError
        ? `Limite de réponse. ${budgetError}`
        : '',
    ].filter(Boolean);
    if (updates.length) {
      AccessibilityInfo.announceForAccessibilityWithOptions(
        updates.join('. '),
        {
          priority: 'low',
        },
      );
    }
  }, [modelStatus, budgetError]);

  if (comparingVoices)
    return <VoiceComparisonPanel onClose={() => setComparingVoices(false)} />;
  if (advancedVoice)
    return <AdvancedVoicePanel onClose={() => setAdvancedVoice(false)} />;
  if (deviceTools)
    return (
      <DeviceToolsPanel onClose={() => setDeviceTools(false)} blocked={busy} />
    );

  return (
    <View style={styles.screen}>
      <ScreenHeading
        title="Réglages"
        description="Un espace à ton rythme."
        headingRef={headingRef}
      />
      <SurfaceGroup>
        <SettingsRow
          label="Modèle"
          icon="model"
          value={modelStatus}
          onPress={onModel}
          stacked
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Réponse"
          accessibilityValue={{ text: responseValue }}
          accessibilityHint={budgetError || undefined}
          accessibilityState={{ expanded: responseOpen }}
          aria-expanded={responseOpen}
          aria-describedby={
            Platform.OS === 'web'
              ? `${responseValueId}${
                  budgetError && responseOpen ? ` ${budgetErrorId}` : ''
                }`
              : undefined
          }
          onPress={onToggleResponse}
          style={({ pressed }) => [
            styles.responseRow,
            { borderColor: colors.separator },
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.leadingIcon}>
            <InterfaceIcon name="chat" size={24} color={colors.muted} />
          </View>
          <View style={styles.rowCopy}>
            <Text style={[styles.rowTitle, { color: colors.text }]}>
              Réponse
            </Text>
            <Text
              nativeID={responseValueId}
              style={[
                styles.rowValue,
                { color: budgetError ? colors.danger : colors.muted },
              ]}
            >
              {responseValue}
            </Text>
          </View>
          <View
            style={{
              transform: [{ rotate: responseOpen ? '-90deg' : '90deg' }],
            }}
          >
            <InterfaceIcon name="arrow" size={20} color={colors.muted} />
          </View>
        </Pressable>
        {responseOpen && (
          <View
            style={[styles.responseBody, { borderColor: colors.separator }]}
          >
            <Text style={[styles.label, { color: colors.text }]}>
              Limite de réponse · facultatif
            </Text>
            <TextInput
              aria-label="Limite de réponse · facultatif"
              aria-invalid={!!budgetError}
              accessibilityHint={`${budgetHint}${
                budgetError ? ` ${budgetError}` : ''
              }`}
              aria-describedby={
                Platform.OS === 'web'
                  ? `${budgetHintId}${budgetError ? ` ${budgetErrorId}` : ''}`
                  : undefined
              }
              keyboardType="number-pad"
              inputAccessoryViewID={
                Platform.OS === 'ios' ? budgetAccessoryId : undefined
              }
              editable={!busy}
              value={budget}
              onChangeText={onBudgetChange}
              placeholder="Ex. 2048 jetons"
              placeholderTextColor={colors.placeholder}
              style={[
                styles.input,
                {
                  color: colors.text,
                  backgroundColor: colors.surfaceRaised,
                  borderColor: budgetError ? colors.danger : colors.border,
                },
              ]}
            />
            {Platform.OS === 'ios' && (
              <InputAccessoryView
                nativeID={budgetAccessoryId}
                backgroundColor={colors.surfaceRaised}
              >
                <View
                  style={[
                    styles.keyboardToolbar,
                    { borderColor: colors.separator },
                  ]}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Terminé"
                    onPress={Keyboard.dismiss}
                    style={({ pressed }) => [
                      styles.keyboardDone,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.label, { color: colors.accent }]}>
                      Terminé
                    </Text>
                  </Pressable>
                </View>
              </InputAccessoryView>
            )}
            <Text
              nativeID={budgetHintId}
              style={[styles.caption, { color: colors.muted }]}
            >
              {budgetHint}
            </Text>
            {!!budgetError && (
              <Text
                nativeID={budgetErrorId}
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
                style={[styles.label, { color: colors.danger }]}
              >
                {budgetError}
              </Text>
            )}
          </View>
        )}
        <View style={[styles.voiceRow, { borderColor: colors.separator }]}>
          <View style={styles.leadingIcon}>
            <InterfaceIcon name="voice" size={24} color={colors.muted} />
          </View>
          <View style={styles.rowCopy}>
            <Text style={[styles.rowTitle, { color: colors.text }]}>
              Lecture vocale
            </Text>
            <Text
              nativeID={voiceHintId}
              style={[styles.caption, { color: colors.muted }]}
            >
              {voiceHint}
            </Text>
          </View>
          <Switch
            {...webSwitchProps}
            accessibilityLabel="Lire les réponses à voix haute"
            accessibilityHint={voiceHint}
            aria-describedby={Platform.OS === 'web' ? voiceHintId : undefined}
            value={readResponses}
            disabled={!onReadResponsesChange}
            aria-disabled={!onReadResponsesChange}
            onValueChange={onReadResponsesChange}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor={readResponses ? colors.onAccent : colors.surface}
            ios_backgroundColor={colors.border}
            hitSlop={8}
            style={styles.voiceSwitch}
          />
        </View>
        <SettingsRow
          label="Voix de l’assistant"
          value="Comparer les voix fr-CA"
          onPress={() => setComparingVoices(true)}
          controlRef={comparisonControl}
          disabled={busy}
          stacked
        />
        <SettingsRow
          label="Voix locale avancée"
          value="Modèles et voix intégrée"
          onPress={() => setAdvancedVoice(true)}
          controlRef={advancedVoiceControl}
          disabled={busy}
          stacked
        />
        <SettingsRow
          label="Outils de l’appareil"
          value="Tests manuels du PR 2"
          detail="Autorisations et essais explicites, sans appel par Gemma."
          onPress={() => setDeviceTools(true)}
          controlRef={deviceToolsControl}
          disabled={busy}
          stacked
        />
        <SettingsRow
          label="Apparence"
          icon="appearance"
          value={theme.label}
          onPress={onAppearance}
          controlRef={appearanceRef}
          stacked
          last
        />
      </SurfaceGroup>
      <View style={styles.session}>
        <Text
          accessibilityRole="header"
          style={[styles.sessionTitle, { color: colors.text }]}
        >
          Ta session
        </Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          La conversation reste en mémoire pendant cette session.
        </Text>
        <View style={[styles.sessionNote, { borderColor: colors.separator }]}>
          <Text style={[styles.caption, { color: colors.muted }]}>
            Tes réglages d’apparence et de réponse sont conservés pendant cette
            session.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { gap: uiGrammar.harmony.space.section },
  responseRow: {
    minHeight: uiGrammar.row.stackedMinHeight,
    paddingVertical: uiGrammar.harmony.space.large,
    flexDirection: 'row',
    alignItems: 'center',
    gap: uiGrammar.row.iconGap,
    borderBottomWidth: 1,
  },
  rowCopy: { flex: 1, gap: 4 },
  voiceRow: {
    minHeight: uiGrammar.row.stackedMinHeight,
    paddingVertical: uiGrammar.harmony.space.large,
    flexDirection: 'row',
    alignItems: 'center',
    gap: uiGrammar.row.iconGap,
    borderBottomWidth: 1,
  },
  voiceSwitch: { flexShrink: 0 },
  rowTitle: { ...uiGrammar.type.body, fontWeight: '500' },
  leadingIcon: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowValue: uiGrammar.type.label,
  responseBody: {
    gap: 8,
    paddingTop: 16,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  label: uiGrammar.type.label,
  caption: uiGrammar.type.caption,
  input: {
    ...uiGrammar.type.body,
    minHeight: 48,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  keyboardToolbar: {
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  keyboardDone: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  session: { gap: uiGrammar.harmony.space.medium },
  sessionNote: {
    borderTopWidth: 1,
    paddingTop: uiGrammar.harmony.space.large,
    marginTop: uiGrammar.harmony.space.small,
  },
  sessionTitle: { ...uiGrammar.type.body, fontWeight: '600' },
  body: uiGrammar.type.body,
  pressed: { opacity: 0.7 },
});
