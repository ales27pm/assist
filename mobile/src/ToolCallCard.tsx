import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAppearance } from './appearance';
import { InterfaceIcon } from './InterfaceIcon';
import { validAgentTrace, validCalendarScope } from './protocol';
import type { CalendarAgentTrace } from './protocol';
import type { CalendarToolTransaction } from './toolActivity';
import { uiGrammar } from './uiGrammar';
import { ActionButton, Disclosure } from './uiPrimitives';

type Props = {
  transaction: CalendarToolTransaction;
  onCancel?: () => void;
  onPermission?: () => void;
};

type Scope = CalendarAgentTrace['scope'];

function formatScope(
  scope?: Scope,
): { summary: string; detail: string } | undefined {
  if (!validCalendarScope(scope)) return;
  const start = Date.parse(scope.startISO);
  const end = Date.parse(scope.endISO);
  try {
    const formatter = new Intl.DateTimeFormat('fr-CA', {
      timeZone: scope.timeZoneIdentifier,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    const day = new Intl.DateTimeFormat('fr-CA', {
      timeZone: scope.timeZoneIdentifier,
      day: 'numeric',
      month: 'long',
    });
    return {
      summary: `${day.format(start)} · journée entière`,
      detail: `Période : ${formatter.format(start)} au ${formatter.format(
        end,
      )} (fin exclue).`,
    };
  } catch {
    // Never fall back to the phone's time zone or expose an invalid raw value.
    return;
  }
}

function confirmedReceipt(
  receipt?: CalendarAgentTrace,
): CalendarAgentTrace | undefined {
  if (validAgentTrace(receipt)) return receipt;
}

function presentation(
  transaction: CalendarToolTransaction,
  receipt?: CalendarAgentTrace,
) {
  if (
    transaction.cancelRequested &&
    ['proposed', 'executing', 'observing'].includes(transaction.status)
  )
    return {
      label: 'Annulation demandée',
      detail: 'L’arrêt attend la fin de l’opération en cours.',
    };
  switch (transaction.status) {
    case 'proposed':
      return {
        label: 'Préparation',
        detail:
          'La demande se prépare. Aucune lecture confirmée à cette étape.',
      };
    case 'executing':
      return {
        label: 'Consultation en cours',
        detail: 'Consultation du calendrier pour la période indiquée.',
      };
    case 'observing':
      return {
        label: 'Réponse en préparation',
        detail: receipt
          ? 'L’assistant prépare sa réponse à partir des événements retournés.'
          : 'La lecture n’est pas encore confirmée.',
      };
    case 'success':
      return {
        label: receipt ? 'Lecture confirmée' : 'Lecture non confirmée',
        detail: receipt ? undefined : 'Aucun reçu de lecture n’a été confirmé.',
      };
    case 'cancelled':
      if (receipt)
        return {
          label: 'Réponse interrompue',
          detail:
            'La lecture reste confirmée ; la réponse n’est pas finalisée.',
        };
      if (!transaction.error)
        return {
          label: 'Calendrier non consulté',
          detail: 'Le modèle n’a pas demandé de lecture.',
        };
      return {
        label: 'Consultation interrompue',
        detail:
          'La lecture ou la réponse a été interrompue. Aucun nouvel essai automatique.',
      };
    case 'failed_safe':
      if (transaction.error === 'permission')
        return {
          label: 'Accès calendrier requis',
          detail: 'L’accès en lecture au calendrier n’est pas autorisé.',
        };
      return {
        label: receipt ? 'Réponse non finalisée' : 'Consultation non terminée',
        detail: receipt
          ? 'La lecture reste confirmée ; la réponse n’a pas pu être finalisée.'
          : 'Le résultat de lecture n’est pas confirmé. Aucun nouvel essai automatique.',
      };
  }
}

/** Presentation only. The owner supplies validated native state and all actions. */
export function ToolCallCard({ transaction, onCancel, onPermission }: Props) {
  const { theme } = useAppearance();
  const { colors } = theme;
  const receipt =
    transaction.status === 'proposed'
      ? undefined
      : confirmedReceipt(transaction.receipt);
  const state = presentation(transaction, receipt);
  const period = formatScope(receipt?.scope ?? transaction.scope);
  const pending = ['proposed', 'executing', 'observing'].includes(
    transaction.status,
  );
  const failed =
    transaction.status === 'failed_safe' ||
    (transaction.status === 'success' && !receipt);
  const count = receipt?.returnedCount;
  const returned =
    count === undefined
      ? undefined
      : count === 0
      ? 'Aucun événement retourné.'
      : `${count} événement${count > 1 ? 's' : ''} retourné${
          count > 1 ? 's' : ''
        }.`;
  const announcementKey = `${transaction.id}:${transaction.status}:${state.label}`;
  const announcement = `Calendrier. ${state.label}.${
    receipt && transaction.status !== 'success' ? ' Lecture confirmée.' : ''
  }${returned ? ` ${returned}` : ''}`;
  const lastAnnounced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastAnnounced.current === announcementKey) return;
    lastAnnounced.current = announcementKey;
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibilityWithOptions(announcement, {
        priority: 'low',
      });
    }
  }, [announcementKey, announcement]);

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.separator },
      ]}
    >
      <View style={styles.heading}>
        <InterfaceIcon name="calendar" color={colors.muted} />
        <View style={[styles.copy, styles.headingCopy]}>
          <Text style={[styles.eyebrow, { color: colors.muted }]}>
            Calendrier · lecture seule
          </Text>
          <Text role="heading" style={[styles.title, { color: colors.text }]}>
            Consulter aujourd’hui
          </Text>
        </View>
      </View>
      <View style={styles.copy}>
        <Text
          accessibilityLiveRegion="polite"
          aria-busy={pending}
          style={[
            styles.status,
            { color: failed ? colors.danger : colors.text },
          ]}
        >
          {state.label}
        </Text>
        {state.detail && (
          <Text style={[styles.body, { color: colors.muted }]}>
            {state.detail}
          </Text>
        )}
        {receipt && transaction.status !== 'success' && (
          <Text style={[styles.status, { color: colors.text }]}>
            Lecture confirmée
          </Text>
        )}
        {returned && (
          <Text style={[styles.body, { color: colors.text }]}>{returned}</Text>
        )}
        {receipt?.possiblyTruncated && (
          <Text style={[styles.body, { color: colors.muted }]}>
            La liste peut être incomplète.
          </Text>
        )}
      </View>
      <Text style={[styles.caption, { color: colors.muted }]}>
        {period?.summary ??
          (transaction.status === 'proposed'
            ? 'Aujourd’hui · période vérifiée avant lecture'
            : 'Période indisponible.')}
      </Text>
      <Text style={[styles.caption, { color: colors.muted }]}>
        5 événements maximum
      </Text>
      {pending && onCancel && (
        <ActionButton
          label={
            transaction.cancelRequested
              ? 'Annulation en cours…'
              : 'Arrêter la consultation'
          }
          onPress={onCancel}
          disabled={transaction.cancelRequested}
          hint="Demander l’arrêt de cette consultation sans la relancer."
        />
      )}
      {transaction.status === 'failed_safe' &&
        transaction.error === 'permission' &&
        onPermission && (
          <ActionButton
            label="Gérer l’accès au calendrier"
            onPress={onPermission}
            hint="Ouvrir Réglages, puis Outils de l’appareil."
          />
        )}
      <Disclosure key={transaction.id} title="Détails de la consultation" plain>
        {period && (
          <Text style={[styles.caption, { color: colors.muted }]}>
            {period.detail}
          </Text>
        )}
        <Text style={[styles.caption, { color: colors.muted }]}>
          Aucune création, modification ni suppression.
        </Text>
        <Text style={[styles.caption, { color: colors.muted }]}>
          Seuls la période et le nombre d’événements retournés sont affichés
          ici, sans leur contenu.
        </Text>
      </Disclosure>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: uiGrammar.radius.surface,
    padding: 16,
    gap: uiGrammar.harmony.space.medium,
  },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: uiGrammar.row.iconGap,
  },
  headingCopy: { flexGrow: 1, flexBasis: 160, maxWidth: '100%' },
  copy: { flexShrink: 1, gap: uiGrammar.harmony.space.small },
  eyebrow: { ...uiGrammar.type.caption, fontWeight: '600' },
  title: { ...uiGrammar.type.body, fontWeight: '600' },
  status: { ...uiGrammar.type.label, fontWeight: '600' },
  body: { ...uiGrammar.type.body },
  caption: { ...uiGrammar.type.caption },
});
