import React from 'react';
import {
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
  readResponses = true,
  onReadResponsesChange,
  voiceAvailable = true,
}: Props) {
  const { theme } = useAppearance();
  const { colors } = theme;
  return (
    <View style={styles.screen}>
      <ScreenHeading title="Réglages" description="Un espace à ton rythme." />
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
          accessibilityState={{ expanded: responseOpen }}
          aria-expanded={responseOpen}
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
              style={[
                styles.rowValue,
                { color: budgetError ? colors.danger : colors.muted },
              ]}
            >
              {budgetError
                ? 'À corriger'
                : budget
                ? `${budget} jetons`
                : 'Limite facultative'}
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
              aria-describedby="assist-budget-hint"
              keyboardType="number-pad"
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
            <Text
              nativeID="assist-budget-hint"
              style={[styles.caption, { color: colors.muted }]}
            >
              En jetons (fragments de mots). Vide : contexte restant.
            </Text>
            {!!budgetError && (
              <Text
                accessibilityRole="alert"
                style={[styles.label, { color: colors.danger }]}
              >
                {budgetError}
              </Text>
            )}
          </View>
        )}
        <View style={[styles.voiceRow, { borderColor: colors.separator }]}>
          <View style={styles.rowCopy}>
            <Text style={[styles.rowTitle, { color: colors.text }]}>
              Lire les réponses à voix haute
            </Text>
            <Text style={[styles.caption, { color: colors.muted }]}>
              {voiceAvailable
                ? 'Lecture automatique dans le mode vocal.'
                : 'Voix locale indisponible. Tu peux désactiver la lecture automatique.'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Lire les réponses à voix haute"
            value={readResponses}
            disabled={!onReadResponsesChange}
            aria-disabled={!onReadResponsesChange}
            onValueChange={onReadResponsesChange}
            hitSlop={8}
            style={styles.voiceSwitch}
          />
        </View>
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
    minHeight: 84,
    paddingVertical: uiGrammar.harmony.space.large,
    flexDirection: 'row',
    alignItems: 'center',
    gap: uiGrammar.harmony.space.medium,
    borderBottomWidth: 1,
  },
  rowCopy: { flex: 1, gap: 4 },
  voiceRow: {
    minHeight: 84,
    paddingVertical: uiGrammar.harmony.space.large,
    flexDirection: 'row',
    alignItems: 'center',
    gap: uiGrammar.harmony.space.medium,
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
