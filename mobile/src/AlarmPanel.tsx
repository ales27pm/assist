import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useAppearance } from './appearance';
import { ActionButton, ScreenHeading, SurfaceGroup } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import {
  AlarmAction,
  AlarmItem,
  AlarmReceipt,
  AlarmRequest,
  newAlarmOperationId,
  parseAlarmReceipt,
} from './alarmProtocol';
import { workspaceBytes } from './nativeWorkspaceProtocol';
import { scheduleAccessibilityFocus } from './focusAccessibility';

type AlarmBridge = {
  executeAlarms(request: string): Promise<string>;
  cancelAlarms(): Promise<string>;
};
const bridge = NativeAssist as Partial<AlarmBridge> | null;
const states = {
  scheduled: 'Programmée',
  countdown: 'Décompte en cours',
  paused: 'En pause',
  alerting: 'Sonne',
  not_present: 'Absente de la liste système',
  unknown: 'État à vérifier',
};

/** Explicit foreground actions; opening settings never asks for AlarmKit access. */
export function AlarmPanel({
  onClose,
  blocked,
}: {
  onClose: () => void;
  blocked: boolean;
}) {
  const {
    theme: { colors },
  } = useAppearance();
  const available =
    Platform.OS === 'ios' &&
    typeof bridge?.executeAlarms === 'function' &&
    typeof bridge?.cancelAlarms === 'function';
  const [items, setItems] = useState<AlarmItem[]>([]);
  const [title, setTitle] = useState('Minuteur');
  const [kind, setKind] = useState<'alarm' | 'timer'>('timer');
  const [duration, setDuration] = useState('300');
  const [date, setDate] = useState('');
  const [selection, setSelection] = useState<AlarmItem | null>(null);
  const [proposal, setProposal] = useState<AlarmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  useEffect(() => scheduleAccessibilityFocus(() => heading.current), []);
  const epoch = useRef(0);
  const invalidate = useCallback(() => {
    ++epoch.current;
  }, []);
  const busyRef = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const enabled =
    available && !blocked && !busy && AppState.currentState === 'active';
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') return;
      ++epoch.current;
      setProposal(null);
      if (busyRef.current) {
        setNotice(
          'Action interrompue : son résultat reste à vérifier dans la liste.',
        );
        bridge?.cancelAlarms?.().catch(() => undefined);
      }
    });
    return () => {
      mounted.current = false;
      invalidate();
      subscription.remove();
      if (busyRef.current) bridge?.cancelAlarms?.().catch(() => undefined);
    };
  }, [invalidate]);
  useEffect(() => {
    if (blocked) {
      setProposal(null);
      ++epoch.current;
      if (busyRef.current) {
        setNotice(
          'Action interrompue : son résultat reste à vérifier dans la liste.',
        );
        bridge?.cancelAlarms?.().catch(() => undefined);
      }
    }
  }, [blocked]);
  function base(action: AlarmAction): AlarmRequest {
    const id = newAlarmOperationId();
    return { schemaVersion: 1, requestId: id, operationId: id, action };
  }
  function propose(
    action: 'create' | 'update' | 'stop' | 'cancel',
    item?: AlarmItem,
  ) {
    if (!enabled || busyRef.current) return;
    const request = base(action);
    if (action === 'stop' || action === 'cancel') {
      if (!item) return;
      setProposal({ ...request, alarm_id: item.alarm_id });
      return;
    }
    const label = title.trim();
    const seconds = Number(duration);
    const dateTime = Date.parse(date);
    if (
      !label ||
      workspaceBytes(label) > 120 ||
      Array.from(label).some(
        character =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      (kind === 'timer'
        ? !/^\d+$/.test(duration) ||
          !Number.isInteger(seconds) ||
          seconds < 1 ||
          seconds > 86400
        : !Number.isFinite(dateTime) ||
          !/T.+(?:Z|[+-]\d\d:\d\d)$/.test(date) ||
          dateTime < Date.now() + 1000 ||
          dateTime > Date.now() + 366 * 86400000)
    ) {
      setNotice(
        'Indique un titre, puis une durée de 1 à 86 400 secondes ou une date ISO future avec fuseau horaire.',
      );
      return;
    }
    if (action === 'update' && !selection) return;
    setProposal({
      ...request,
      alarm_id: action === 'create' ? request.operationId : selection!.alarm_id,
      kind,
      title: label,
      ...(kind === 'timer'
        ? { duration_seconds: seconds }
        : { date_iso: date }),
    });
  }
  function message(receipt: AlarmReceipt) {
    if (receipt.status === 'outcome_unknown')
      return 'Résultat incertain. Actualise la liste avant toute autre action ; ne recrée pas automatiquement cette alarme.';
    if (receipt.code === 'permission_denied')
      return 'Autorisation Alarmes refusée. Tu peux la modifier dans les réglages iOS, puis refaire explicitement ton choix.';
    if (receipt.status === 'failed_safe')
      return `Action refusée (${receipt.code}). Aucun succès confirmé.`;
    return receipt.action === 'list'
      ? 'Liste Assist actualisée. Les alarmes de l’app Horloge ne sont pas accessibles ici.'
      : 'Action confirmée par AlarmKit.';
  }
  async function run(request: AlarmRequest) {
    if (!enabled || busyRef.current || blockedRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProposal(null);
    setNotice(null);
    const ticket = ++epoch.current;
    try {
      const receipt = parseAlarmReceipt(
        await bridge!.executeAlarms!(JSON.stringify(request)),
        request,
      );
      if (
        !mounted.current ||
        ticket !== epoch.current ||
        blockedRef.current ||
        AppState.currentState !== 'active'
      )
        return;
      if (request.action === 'list') setItems(receipt.items);
      else
        setItems(previous => [
          ...previous.filter(
            item =>
              !receipt.items.some(
                updated => updated.alarm_id === item.alarm_id,
              ),
          ),
          ...receipt.items,
        ]);
      setNotice(message(receipt));
      setSelection(null);
    } catch {
      if (mounted.current && ticket === epoch.current)
        setNotice(
          request.action === 'list'
            ? 'Liste indisponible. Réessaie explicitement son actualisation.'
            : 'Résultat non confirmé. Actualise la liste avant de continuer ; ne répète pas cette action.',
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function interrupt() {
    if (!busyRef.current) return;
    ++epoch.current;
    setProposal(null);
    setNotice(
      'Interruption demandée. Une action déjà soumise peut avoir pris effet ; actualise la liste.',
    );
    try {
      await bridge!.cancelAlarms!();
    } catch {
      if (mounted.current)
        setNotice(
          'Interruption non confirmée. Vérifie la liste avant de continuer.',
        );
    }
  }
  return (
    <View style={styles.container}>
      <ScreenHeading
        title="Alarmes et minuteurs"
        headingRef={heading}
        description="Alarmes créées par Assist, avec les alertes natives iOS."
      />
      <ActionButton label="Retour" onPress={onClose} />
      {!available && (
        <Text style={{ color: colors.muted }}>
          Ce binaire ne contient pas encore AlarmKit pour Assist.
        </Text>
      )}
      <ActionButton
        label="Actualiser les alarmes Assist"
        disabled={!enabled}
        onPress={() => {
          run(base('list'));
        }}
      />
      {notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.text }}>
          {notice}
        </Text>
      )}
      {busy && (
        <ActionButton
          label="Interrompre la demande"
          onPress={() => {
            interrupt();
          }}
        />
      )}
      <SurfaceGroup
        title={selection ? 'Modifier la sélection' : 'Nouvelle alarme'}
      >
        <TextInput
          accessibilityLabel="Titre de l’alarme"
          value={title}
          editable={enabled}
          onChangeText={setTitle}
          style={[
            styles.input,
            { color: colors.text, borderColor: colors.border },
          ]}
        />
        <ActionButton
          label={
            kind === 'timer'
              ? 'Minuteur sélectionné — choisir une alarme'
              : 'Alarme sélectionnée — choisir un minuteur'
          }
          disabled={!enabled}
          onPress={() => setKind(kind === 'timer' ? 'alarm' : 'timer')}
        />
        {kind === 'timer' ? (
          <TextInput
            accessibilityLabel="Durée en secondes"
            keyboardType="number-pad"
            value={duration}
            editable={enabled}
            onChangeText={setDuration}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border },
            ]}
          />
        ) : (
          <TextInput
            accessibilityLabel="Date ISO avec fuseau horaire"
            placeholder="2026-10-20T08:00:00-04:00"
            value={date}
            editable={enabled}
            onChangeText={setDate}
            autoCapitalize="none"
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border },
            ]}
          />
        )}
        <ActionButton
          label={
            selection ? 'Préparer la modification' : 'Préparer la création'
          }
          disabled={!enabled}
          onPress={() => propose(selection ? 'update' : 'create')}
        />
      </SurfaceGroup>
      {proposal && (
        <SurfaceGroup title="Confirmer exactement cette action">
          <Text style={{ color: colors.text }}>
            {proposal.action === 'create'
              ? 'Créer'
              : proposal.action === 'update'
              ? 'Remplacer l’alarme sélectionnée'
              : proposal.action === 'stop'
              ? 'Arrêter la sonnerie'
              : 'Supprimer l’alarme'}
            {proposal.title ? ` : ${proposal.title}` : ''}
            {proposal.duration_seconds
              ? ` — ${proposal.duration_seconds} secondes à partir de la confirmation`
              : ''}
            {proposal.date_iso ? ` — ${proposal.date_iso}` : ''}
          </Text>
          {proposal.alarm_id && proposal.action !== 'create' && (
            <Text selectable style={{ color: colors.muted }}>
              Identifiant : {proposal.alarm_id}
            </Text>
          )}
          {proposal.action === 'update' && (
            <Text style={{ color: colors.muted }}>
              L’ancienne programmation sera annulée avant la nouvelle. En cas
              d’échec, son rétablissement n’est pas automatique.
            </Text>
          )}
          <Text style={{ color: colors.muted }}>
            iOS peut demander l’autorisation d’afficher des alarmes. Elles
            peuvent sonner en mode Silence ou Concentration.
          </Text>
          <ActionButton
            label="Confirmer l’action"
            disabled={!enabled}
            onPress={() => {
              run(proposal);
            }}
          />
          <ActionButton
            label="Annuler la préparation"
            onPress={() => setProposal(null)}
          />
        </SurfaceGroup>
      )}
      {items.map(item => (
        <SurfaceGroup key={item.alarm_id} title={item.title}>
          <Text style={{ color: colors.muted }}>
            {states[item.state]}
            {item.uncertain ? ' — résultat à vérifier' : ''}
            {item.date_iso
              ? ` · ${item.date_iso}`
              : ` · ${item.duration_seconds} s`}
          </Text>
          <ActionButton
            label={`Modifier ${item.title}`}
            disabled={
              !enabled || item.uncertain || item.state === 'not_present'
            }
            onPress={() => {
              setSelection(item);
              setKind(item.kind);
              setTitle(item.title);
              setDate(item.date_iso ?? '');
              setDuration(String(item.duration_seconds ?? 300));
              setProposal(null);
            }}
          />
          <ActionButton
            label={`Arrêter ${item.title}`}
            disabled={!enabled || item.uncertain || item.state !== 'alerting'}
            onPress={() => propose('stop', item)}
          />
          <ActionButton
            label={`Supprimer ${item.title}`}
            disabled={
              !enabled || (item.state === 'not_present' && !item.uncertain)
            }
            onPress={() => propose('cancel', item)}
          />
        </SurfaceGroup>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: uiGrammar.harmony.space.large },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 10, padding: 12 },
});
