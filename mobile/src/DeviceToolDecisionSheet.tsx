import React, { useEffect, useId, useRef } from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppearance } from './appearance';
import { DeviceToolTransaction, deviceToolLabels } from './deviceToolProtocol';
import { scheduleAccessibilityFocus } from './focusAccessibility';
import { ActionButton } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';

export function DeviceToolDecisionSheet({
  transaction,
  pending,
  onConfirm,
  onCancel,
  onPermission,
  onDismiss,
}: {
  transaction: DeviceToolTransaction | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onPermission: () => void;
  onDismiss: (transactionId: string) => void;
}) {
  const {
    theme: { colors },
  } = useAppearance();
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  const lastTransaction = useRef(transaction);
  if (transaction) lastTransaction.current = transaction;
  const shown = transaction ?? lastTransaction.current;
  const titleId = useId();
  useEffect(
    () =>
      transaction
        ? scheduleAccessibilityFocus(() => heading.current)
        : undefined,
    [transaction?.id, transaction?.status, transaction],
  );
  if (!shown) return null;
  const permission = shown.status === 'awaiting_permission';
  return (
    <Modal
      key={shown.id}
      visible={!!transaction}
      transparent
      animationType="none"
      onRequestClose={onCancel}
      onDismiss={() => onDismiss(shown.id)}
      onShow={() => {
        scheduleAccessibilityFocus(() => heading.current);
      }}
      aria-labelledby={Platform.OS === 'web' ? titleId : undefined}
    >
      <View style={[styles.overlay, { backgroundColor: colors.background }]}>
        <SafeAreaView
          accessibilityViewIsModal
          onAccessibilityEscape={onCancel}
          edges={['bottom', 'left', 'right']}
          style={[
            styles.sheet,
            { backgroundColor: colors.surface, borderColor: colors.separator },
          ]}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            <Text
              ref={heading}
              nativeID={titleId}
              accessibilityRole="header"
              {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
              style={[styles.title, { color: colors.text }]}
            >
              {deviceToolLabels[shown.tool]}
            </Text>
            <Text style={[styles.body, { color: colors.muted }]}>
              {permission
                ? 'L’accès iOS et ton accord pour cette action sont deux décisions séparées. Modifier l’accès termine cette tâche; rien ne sera relancé automatiquement.'
                : 'Vérifie les valeurs exactes préparées par Assist. Seul ce toucher autorise cette action, une seule fois.'}
            </Text>
            {shown.preview.map((field, index) => (
              <View key={index} style={styles.field}>
                <Text style={[styles.label, { color: colors.muted }]}>
                  {field.label}
                </Text>
                <Text selectable style={[styles.body, { color: colors.text }]}>
                  {field.value}
                </Text>
              </View>
            ))}
            <ActionButton
              label={
                permission
                  ? 'Gérer cet accès iOS'
                  : shown.effect === 'write'
                  ? 'Confirmer cette modification'
                  : shown.effect === 'interactive'
                  ? 'Continuer dans iOS'
                  : 'Autoriser cette lecture'
              }
              disabled={pending}
              onPress={permission ? onPermission : onConfirm}
              primary
            />
            <ActionButton
              label="Annuler l’action"
              disabled={pending}
              onPress={onCancel}
            />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '90%',
    borderWidth: 1,
    borderTopLeftRadius: uiGrammar.radius.surface,
    borderTopRightRadius: uiGrammar.radius.surface,
  },
  content: { padding: uiGrammar.gutter, gap: uiGrammar.harmony.space.large },
  title: { ...uiGrammar.type.navigation, fontWeight: '600' },
  body: { ...uiGrammar.type.body },
  label: { ...uiGrammar.type.label, fontWeight: '600' },
  field: { gap: uiGrammar.harmony.space.small },
});
