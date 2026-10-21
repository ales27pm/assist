import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View, Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useAppearance } from './appearance';
import { ActionButton, Disclosure, ScreenHeading } from './uiPrimitives';
import { scheduleAccessibilityFocus } from './focusAccessibility';
import { uiGrammar } from './uiGrammar';
import {
  DebugMode,
  DebugStatus,
  DebugStage,
  debugCategoryLabels,
  debugCoverageLabels,
  debugEvidenceLabels,
  debugFindingLabels,
  debugSeverityLabels,
  debugReasonLabels,
  parseDebugDiagnosticsBundle,
  parseDebugDiagnosticsStatus,
} from './debugDiagnostics';

const modeLabels: Record<DebugMode, string> = {
  off: 'Désactivé',
  standard: 'Standard',
  detailed: 'Détaillé',
};
const stageLabels: Record<DebugStage, string> = {
  admission: 'Admission',
  context: 'Contexte',
  tokenization: 'Tokenisation',
  roots: 'Première passe privée',
  leaves: 'Seconde passe privée',
  generation: 'Génération',
  validation: 'Validation',
  proposal: 'Proposition',
  permission: 'Autorisation',
  confirmation: 'Confirmation',
  execution: 'Exécution',
  receipt: 'Reçu',
  presentation: 'Présentation',
  cancellation: 'Annulation',
  modelLoad: 'Chargement du modèle',
  lifecycle: 'Cycle de vie',
  systemReport: 'Rapport système',
  configuration: 'Configuration',
};
const outcomeLabels = {
  began: 'Début',
  completed: 'Terminé',
  rejected: 'Refusé',
  failed: 'Échec',
  cancelled: 'Annulé',
  unknown: 'Inconnu',
  stalled: 'Sans fin observée',
};
type Operation = 'configuration' | 'export' | 'purge';

/** This panel observes a native journal. It never runs a model, tool or probe. */
export function AdvancedDiagnosticsPanel() {
  const { theme } = useAppearance();
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  useEffect(() => scheduleAccessibilityFocus(() => heading.current), []);
  const [status, setStatus] = useState<DebugStatus | null>(null);
  const [fresh, setFresh] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const [busy, setBusy] = useState<Operation | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const life = useRef({
    mounted: false,
    active: AppState.currentState === 'active',
    version: 0,
    operation: null as Operation | null,
    read: null as object | null,
    latest: null as { sessionId: string; revision: number } | null,
  });
  const available =
    typeof NativeAssist?.getDebugDiagnostics === 'function' &&
    typeof NativeAssist?.configureDebugDiagnostics === 'function' &&
    typeof NativeAssist?.exportDebugDiagnostics === 'function' &&
    typeof NativeAssist?.clearDebugDiagnostics === 'function';

  const current = useCallback(
    (version: number) =>
      life.current.mounted &&
      life.current.active &&
      life.current.version === version,
    [],
  );
  const publish = useCallback(
    (json: string, version: number) => {
      if (!current(version)) return;
      const next = parseDebugDiagnosticsStatus(json);
      const latest = life.current.latest;
      if (
        latest?.sessionId === next.sessionId &&
        next.revision < latest.revision
      )
        return;
      life.current.latest = {
        sessionId: next.sessionId,
        revision: next.revision,
      };
      setStatus(next);
      setFresh(true);
      setError('');
    },
    [current],
  );

  useEffect(() => {
    const lifetime = life.current;
    lifetime.mounted = true;
    lifetime.active = AppState.currentState === 'active';
    const poll = async () => {
      if (
        !available ||
        !lifetime.mounted ||
        !lifetime.active ||
        lifetime.operation ||
        lifetime.read
      )
        return;
      const version = lifetime.version;
      const token = {};
      lifetime.read = token;
      try {
        const json = await NativeAssist!.getDebugDiagnostics();
        publish(json, version);
      } catch {
        if (current(version)) {
          setFresh(false);
          setError('Journal avancé temporairement indisponible.');
        }
      } finally {
        if (lifetime.read === token) lifetime.read = null;
      }
    };
    const listener = AppState.addEventListener('change', state => {
      const active = state === 'active';
      if (active === lifetime.active) return;
      lifetime.active = active;
      lifetime.version += 1;
      lifetime.read = null;
      lifetime.operation = null;
      setFresh(false);
      setBusy(null);
      setConfirmPurge(false);
      setForeground(active);
      if (active) poll();
    });
    poll();
    const interval = setInterval(poll, 1000);
    return () => {
      lifetime.mounted = false;
      lifetime.version += 1;
      lifetime.read = null;
      lifetime.operation = null;
      clearInterval(interval);
      listener.remove();
    };
  }, [available, current, publish]);

  function begin(operation: Operation): number | null {
    const lifetime = life.current;
    if (
      !available ||
      !lifetime.mounted ||
      !lifetime.active ||
      (lifetime.operation &&
        (operation !== 'purge' || lifetime.operation === 'purge'))
    )
      return null;
    const version = ++lifetime.version;
    lifetime.operation = operation;
    lifetime.read = null;
    setBusy(operation);
    setConfirmPurge(false);
    setMessage('');
    setError('');
    return version;
  }
  function finish(version: number) {
    if (!current(version)) return;
    life.current.operation = null;
    setBusy(null);
  }
  async function configure(mode: DebugMode) {
    const version = begin('configuration');
    if (version === null) return;
    setFresh(false);
    try {
      publish(
        await NativeAssist!.configureDebugDiagnostics(
          JSON.stringify({ schemaVersion: 1, mode }),
        ),
        version,
      );
    } catch {
      if (current(version))
        setError('Le niveau du journal n’a pas pu être confirmé.');
    } finally {
      finish(version);
    }
  }
  async function share() {
    const version = begin('export');
    if (version === null) return;
    try {
      const json = await NativeAssist!.exportDebugDiagnostics();
      if (!current(version)) return;
      const bundle = parseDebugDiagnosticsBundle(json);
      if (!current(version)) return;
      await Share.share({ message: JSON.stringify(bundle, null, 2) });
    } catch {
      if (current(version))
        setError('Le diagnostic avancé n’a pas pu être partagé.');
    } finally {
      finish(version);
    }
  }
  async function purge() {
    const previous = life.current.latest;
    const version = begin('purge');
    if (version === null) return;
    life.current.latest = null;
    setStatus(null);
    setFresh(false);
    try {
      const json = await NativeAssist!.clearDebugDiagnostics();
      if (!current(version)) return;
      const cleared = parseDebugDiagnosticsStatus(json);
      if (
        cleared.recordCount !== 0 ||
        cleared.previousSessionCount !== 0 ||
        cleared.omittedRecords !== 0 ||
        cleared.rejectedRecords !== 0 ||
        (previous?.sessionId === cleared.sessionId &&
          cleared.revision <= previous.revision)
      )
        throw new Error('Effacement non confirmé.');
      publish(json, version);
      setMessage('Journal avancé effacé.');
    } catch {
      if (current(version))
        setError('L’effacement du journal avancé n’a pas pu être confirmé.');
    } finally {
      finish(version);
    }
  }

  const text = { color: theme.colors.text };
  const muted = { color: theme.colors.muted };
  const locked = busy !== null || !foreground || confirmPurge;
  return (
    <View style={styles.panel}>
      <ScreenHeading title="Journal avancé" headingRef={heading} />
      <Text style={[styles.caption, muted]}>
        Ce journal local est distinct du suivi de performances. Le désactiver ne
        coupe pas ce suivi.
      </Text>
      {!available ? (
        <Text style={[styles.body, muted]}>
          Une version native compatible est nécessaire pour ce journal avancé.
        </Text>
      ) : (
        <>
          <Text style={[styles.caption, muted]}>
            Aucun message, argument, URL ou chemin conservé. Aucun envoi
            automatique.
          </Text>
          {status ? (
            <>
              <Text style={[styles.body, text]}>
                {fresh && foreground
                  ? 'Niveau confirmé'
                  : 'Dernier niveau reçu'}{' '}
                : {modeLabels[status.mode]}
              </Text>
              {status.detailExpiresAt && (
                <Text style={[styles.caption, muted]}>
                  Détaillé limité à 15 minutes. Expiration prévue :{' '}
                  {new Date(status.detailExpiresAt).toLocaleTimeString('fr-CA')}
                  .
                </Text>
              )}
              <Text style={[styles.caption, muted]}>
                {status.recordCount}/512 événements conservés ·{' '}
                {status.omittedRecords} omis · {status.rejectedRecords} rejetés
                · {status.previousSessionCount}/2 sessions précédentes.
              </Text>
              {status.persistence === 'unavailable' && (
                <Text
                  role="alert"
                  style={[styles.body, { color: theme.colors.danger }]}
                >
                  Sauvegarde locale indisponible. Les dernières observations
                  peuvent manquer après fermeture.
                </Text>
              )}
              <Text role="heading" style={[styles.body, text]}>
                Constats du journal
              </Text>
              {status.findings.length ? (
                status.findings.map((finding, index) => (
                  <View
                    key={`${finding.code}-${finding.sequence}-${index}`}
                    style={styles.entry}
                  >
                    <Text
                      style={[
                        styles.body,
                        finding.severity === 'critical'
                          ? { color: theme.colors.danger }
                          : text,
                      ]}
                    >
                      {debugFindingLabels[finding.code]}
                    </Text>
                    <Text style={[styles.caption, muted]}>
                      {debugSeverityLabels[finding.severity]} ·{' '}
                      {debugEvidenceLabels[finding.evidence]}
                      {finding.sequence === null
                        ? ''
                        : ` · événement ${finding.sequence}`}
                      {finding.traceId === null
                        ? ''
                        : ` · trace ${finding.traceId}`}
                    </Text>
                    {[
                      'systemCrashReport',
                      'systemHangReport',
                      'systemResourceReport',
                    ].includes(finding.code) && (
                      <Text style={[styles.caption, muted]}>
                        Ce rapport système reçu peut concerner une exécution
                        antérieure.
                      </Text>
                    )}
                  </View>
                ))
              ) : (
                <Text style={[styles.caption, muted]}>
                  Aucun constat disponible dans ce journal.
                </Text>
              )}
              <Text style={[styles.caption, muted]}>
                Une absence d’événement n’établit ni l’absence d’action ni la
                cause d’un plantage.
              </Text>
              <Disclosure
                title="Couverture des diagnostics"
                description="Points de mesure embarqués dans 16 catégories."
                plain
              >
                <Text style={[styles.caption, muted]}>
                  Ces états décrivent l’instrumentation, pas une qualification
                  exhaustive des outils ou du matériel.
                </Text>
                {status.coverage.map(entry => (
                  <Text key={entry.category} style={[styles.body, text]}>
                    {debugCategoryLabels[entry.category]} :{' '}
                    {debugCoverageLabels[entry.state]}
                  </Text>
                ))}
              </Disclosure>
              <Disclosure
                title="Événements avancés récents"
                description="Au plus 30 observations, sans contenu privé."
                plain
              >
                {status.records.length ? (
                  status.records.map(record => (
                    <View key={record.sequence} style={styles.entry}>
                      <Text style={[styles.body, text]}>
                        {record.sequence} ·{' '}
                        {debugCategoryLabels[record.category]} ·{' '}
                        {stageLabels[record.stage]} ·{' '}
                        {outcomeLabels[record.outcome]}
                      </Text>
                      <Text style={[styles.caption, muted]}>
                        {Math.round(record.elapsedMs)} ms
                        {record.traceId ? ` · trace ${record.traceId}` : ''}
                        {record.reason
                          ? ` · ${debugReasonLabels[record.reason]}`
                          : ''}
                        {record.field ? ` · champ ${record.field}` : ''}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text style={[styles.caption, muted]}>
                    Aucun événement conservé.
                  </Text>
                )}
              </Disclosure>
            </>
          ) : (
            <Text style={[styles.caption, muted]}>
              {busy === 'purge'
                ? 'Effacement en cours…'
                : 'En attente de l’état natif…'}
            </Text>
          )}
          <ActionButton
            label="Désactiver le journal avancé"
            disabled={locked}
            onPress={() => configure('off')}
          />
          <ActionButton
            label="Activer le niveau standard"
            disabled={locked}
            onPress={() => configure('standard')}
          />
          <ActionButton
            label="Activer le niveau détaillé (15 min)"
            disabled={locked}
            onPress={() => configure('detailed')}
          />
          <ActionButton
            label="Partager le diagnostic avancé"
            disabled={locked}
            onPress={share}
          />
          <ActionButton
            label="Effacer le journal avancé"
            destructive
            disabled={!foreground || busy === 'purge' || confirmPurge}
            onPress={() => setConfirmPurge(true)}
          />
          {confirmPurge && (
            <View style={styles.entry}>
              <Text role="heading" style={[styles.body, text]}>
                Effacer le journal avancé et ses archives ?
              </Text>
              <Text style={[styles.caption, muted]}>
                Le suivi de performances reste distinct. Les rapports déjà
                partagés restent hors de l’app.
              </Text>
              <ActionButton
                label="Confirmer l’effacement du journal avancé"
                destructive
                onPress={purge}
                disabled={!foreground}
              />
              <ActionButton
                label="Conserver le journal avancé"
                onPress={() => setConfirmPurge(false)}
              />
            </View>
          )}
          {!foreground && (
            <Text style={[styles.caption, muted]}>
              Lecture et actions en pause en arrière-plan.
            </Text>
          )}
          {!!message && (
            <Text accessibilityLiveRegion="polite" style={[styles.body, text]}>
              {message}
            </Text>
          )}
          {!!error && (
            <Text
              role="alert"
              style={[styles.body, { color: theme.colors.danger }]}
            >
              {error}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: uiGrammar.harmony.space.medium },
  entry: { gap: uiGrammar.harmony.space.small },
  body: uiGrammar.type.body,
  caption: uiGrammar.type.caption,
});
