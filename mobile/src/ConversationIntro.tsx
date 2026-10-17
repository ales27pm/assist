import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { InterfaceIcon } from './InterfaceIcon';
import { uiGrammar } from './uiGrammar';
import { ActionButton } from './uiPrimitives';

type ConversationIntroProps = {
  exampleControlRef?: React.Ref<React.ComponentRef<typeof View>>;
  onDraft: (text: string) => void;
  onExample: () => void;
  ready: boolean;
  busy: boolean;
  nativeAvailable: boolean;
  onConfigure: () => void;
};

type ConversationExampleProps = {
  headingRef?: React.Ref<React.ComponentRef<typeof Text>>;
  onClose: () => void;
  onDraft: (text: string) => void;
};

const starterDrafts = [
  {
    title: 'Éclaircir une idée',
    draft: 'Aide-moi à clarifier cette idée : ',
  },
  {
    title: 'Trouver les mots',
    draft: 'Aide-moi à reformuler ce texte : ',
  },
];

const followupDrafts = [
  {
    title: 'Plus de détails',
    draft: 'Peux-tu développer ce point : ',
  },
  {
    title: 'Plan d’action',
    draft: 'Aide-moi à construire un plan d’action pour : ',
  },
];

/** Decorative brand mark. Its enclosing control supplies an accessible name. */
export function AssistantMark({ size = 48 }: { size?: number }) {
  const { theme } = useAppearance();
  const stroke = Math.max(1, size / 24);
  // The outer diameter and the seed's height share the golden proportion.
  const seedSide = size / uiGrammar.harmony.phi / Math.SQRT2;

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID="assistant-mark"
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: stroke,
          borderColor: theme.colors.accent,
        },
      ]}
    >
      <View
        style={[
          styles.seed,
          {
            width: seedSide,
            height: seedSide,
            borderWidth: stroke,
            borderColor: theme.colors.accent,
            borderTopRightRadius: seedSide,
            borderBottomLeftRadius: seedSide,
          },
        ]}
      />
    </View>
  );
}

export function ConversationIntro({
  exampleControlRef,
  onDraft,
  onExample,
  ready,
  busy,
  nativeAvailable,
  onConfigure,
}: ConversationIntroProps) {
  const { theme } = useAppearance();

  return (
    <View style={styles.intro}>
      <AssistantMark />
      <Text
        accessibilityRole="header"
        accessibilityLabel="Un espace pour tes idées."
        style={[styles.heading, { color: theme.colors.text }]}
      >
        {'Un espace\npour tes idées.'}
      </Text>
      <Text style={[styles.supporting, { color: theme.colors.muted }]}>
        Une question, une idée, un texte à éclaircir.
      </Text>
      {!ready && (
        <View
          style={[
            styles.preparation,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.separator,
            },
          ]}
        >
          <View style={styles.preparationHeading}>
            <View style={styles.modelIcon}>
              <InterfaceIcon
                name="model"
                size={24}
                color={theme.colors.muted}
              />
            </View>
            <View style={styles.preparationCopy}>
              <Text
                style={[styles.preparationTitle, { color: theme.colors.text }]}
              >
                {busy ? 'Préparation en cours' : 'Un modèle à charger'}
              </Text>
              <Text
                accessibilityRole={!nativeAvailable ? 'alert' : undefined}
                style={[
                  styles.preparationDetail,
                  { color: theme.colors.muted },
                ]}
              >
                {!nativeAvailable
                  ? 'Moteur iOS indisponible dans cet aperçu.'
                  : 'Prépare Gemma sur ton iPhone pour commencer.'}
              </Text>
            </View>
          </View>
          <ActionButton
            label={busy ? 'Voir la préparation' : 'Préparer mon assistant'}
            onPress={onConfigure}
            primary
          />
        </View>
      )}
      <View style={styles.starters}>
        {starterDrafts.map(item => (
          <DraftChip
            key={item.title}
            title={item.title}
            onPress={() => onDraft(item.draft)}
          />
        ))}
      </View>
      <Pressable
        ref={exampleControlRef}
        accessibilityRole="button"
        accessibilityHint="Affiche une conversation illustrative."
        onPress={onExample}
        style={({ pressed }) => [
          styles.exampleButton,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.exampleLabel, { color: theme.colors.accent }]}>
          Voir un exemple
        </Text>
      </Pressable>
    </View>
  );
}

/** Illustrative content only; it never creates a message or invokes inference. */
export function ConversationExample({
  headingRef,
  onClose,
  onDraft,
}: ConversationExampleProps) {
  const { theme } = useAppearance();

  return (
    <View style={styles.example}>
      <View style={[styles.divider, { borderColor: theme.colors.separator }]}>
        <Text
          ref={headingRef}
          role="heading"
          {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
          style={[styles.exampleCaption, { color: theme.colors.muted }]}
        >
          Exemple · contenu illustratif
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fermer l’exemple"
          onPress={onClose}
          style={({ pressed }) => [
            styles.closeButton,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.closeGlyph}>
            <InterfaceIcon name="add" size={20} color={theme.colors.muted} />
          </View>
        </Pressable>
      </View>
      <View
        style={[
          styles.userBubble,
          { backgroundColor: theme.colors.userBubble },
        ]}
      >
        <Text style={[styles.message, { color: theme.colors.userText }]}>
          Aide-moi à clarifier cette idée.
        </Text>
      </View>
      <View style={styles.assistantRow}>
        <AssistantMark size={28} />
        <View style={styles.assistantBubble}>
          <Text style={[styles.message, { color: theme.colors.text }]}>
            Bien sûr. Quel résultat aimerais-tu obtenir ?
          </Text>
        </View>
      </View>
      <View style={styles.followups}>
        {followupDrafts.map(item => (
          <DraftChip
            key={item.title}
            title={item.title}
            compact
            onPress={() => onDraft(item.draft)}
          />
        ))}
      </View>
    </View>
  );
}

function DraftChip({
  title,
  onPress,
  compact = false,
}: {
  title: string;
  onPress: () => void;
  compact?: boolean;
}) {
  const { theme } = useAppearance();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Insère une amorce modifiable dans le champ de message."
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        compact && styles.compactChip,
        {
          backgroundColor: theme.colors.chip,
          borderColor: compact ? theme.colors.border : theme.colors.separator,
        },
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.chipLabel,
          compact && styles.compactChipLabel,
          { color: theme.colors.text },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mark: { flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  seed: { transform: [{ rotate: '45deg' }] },
  intro: {
    width: '100%',
    alignItems: 'flex-start',
    paddingTop: uiGrammar.harmony.space.section,
    paddingBottom: uiGrammar.harmony.space.large,
  },
  heading: {
    marginTop: uiGrammar.harmony.space.large,
    ...uiGrammar.type.display,
    fontWeight: '500',
    letterSpacing: -0.5,
  },
  supporting: {
    marginTop: uiGrammar.harmony.space.medium,
    ...uiGrammar.type.body,
    maxWidth: 320,
  },
  starters: {
    width: '100%',
    marginTop: uiGrammar.harmony.space.large,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: uiGrammar.harmony.space.small,
  },
  preparation: {
    width: '100%',
    gap: 16,
    padding: 16,
    marginTop: 24,
    borderWidth: 1,
    borderRadius: 20,
  },
  preparationHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  modelIcon: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  preparationCopy: { flex: 1, gap: 4 },
  preparationTitle: { ...uiGrammar.type.body, fontWeight: '500' },
  preparationDetail: uiGrammar.type.label,
  chip: {
    minHeight: uiGrammar.composer.height,
    flexGrow: 1,
    flexBasis: 128,
    maxWidth: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: uiGrammar.radius.control,
  },
  chipLabel: {
    ...uiGrammar.type.label,
    fontWeight: '500',
    textAlign: 'center',
    flexShrink: 1,
  },
  compactChip: { paddingHorizontal: 12 },
  compactChipLabel: uiGrammar.type.label,
  exampleButton: {
    width: '100%',
    minHeight: 44,
    marginTop: 4,
    paddingHorizontal: 0,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  exampleLabel: uiGrammar.type.label,
  pressed: { opacity: 0.65 },
  example: { width: '100%', flexGrow: 1, paddingBottom: 0, gap: 24 },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    borderBottomWidth: 1,
  },
  exampleCaption: { flex: 1, ...uiGrammar.type.caption },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { transform: [{ rotate: '45deg' }] },
  userBubble: {
    maxWidth: '85%',
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: uiGrammar.radius.bubble,
    borderBottomRightRadius: 4,
  },
  message: uiGrammar.type.body,
  assistantRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 13 },
  assistantBubble: {
    flexShrink: 1,
    maxWidth: '84%',
    paddingTop: 2,
  },
  followups: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 0,
    paddingTop: 8,
  },
});
