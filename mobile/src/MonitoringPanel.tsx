import React, { useEffect, useState } from 'react';
import {
  AppState,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { AssistTheme, useAppearance } from './appearance';
import { uiGrammar } from './uiGrammar';
import {
  MonitoringPhase,
  MonitoringSnapshot,
  parseMonitoringSnapshot,
} from './monitoring';

const phaseLabels: Record<MonitoringPhase, string> = {
  idle: 'Au repos',
  loading: 'Chargement',
  ready: 'Prêt',
  generating: 'Génération',
  cancelling: 'Annulation',
  failed: 'Échec',
  diagnosing: 'Diagnostic',
};
const thermalLabels = {
  nominal: 'Nominal',
  fair: 'Modéré',
  serious: 'Élevé',
  critical: 'Critique',
  unknown: 'Inconnu',
};
const pressureLabels = {
  normal: 'Normale',
  warning: 'Avertissement',
  critical: 'Critique',
  unknown: 'Inconnue',
};
const severityLabels = {
  info: 'Info',
  warning: 'Alerte',
  critical: 'Critique',
};
const eventLabels: Record<string, string> = {
  MODEL_LOAD_STARTED: 'Chargement démarré',
  MODEL_LOAD_COMPLETED: 'Modèle chargé',
  MODEL_LOAD_FAILED: 'Échec du chargement',
  GENERATION_STARTED: 'Génération démarrée',
  GENERATION_COMPLETED: 'Génération terminée',
  GENERATION_CANCELLED: 'Génération annulée',
  GENERATION_FAILED: 'Échec de la génération',
  GENERATION_REJECTED: 'Demande rejetée',
  CANCELLATION_REQUESTED: 'Annulation demandée',
  CONVERSATION_RESET: 'Conversation réinitialisée',
  CONVERSATION_RESET_FAILED: 'Échec de la réinitialisation',
  MODEL_UNLOADED: 'Modèle déchargé',
  MODEL_UNLOAD_FAILED: 'Échec du déchargement',
  LOAD_PROBE_STARTED: 'Diagnostic de chargement démarré',
  LOAD_PROBE_COMPLETED: 'Graphe chargé pour le diagnostic',
  LOAD_PROBE_FAILED: 'Échec du diagnostic de chargement',
  ASSET_PROBE_STARTED: 'Vérification des fichiers démarrée',
  ASSET_PROBE_COMPLETED: 'Asset F16 conforme à la référence',
  ASSET_PROBE_FAILED: 'Échec de la vérification des fichiers',
  SPECIALIZATION_REPAIR_STARTED: 'Reconstruction de la préparation démarrée',
  SPECIALIZATION_REPAIR_COMPLETED: 'Contrôle après reconstruction terminé',
  SPECIALIZATION_REPAIR_FAILED: 'Échec de la reconstruction de la préparation',
  DIAGNOSTIC_STARTED: 'Diagnostic démarré',
  DIAGNOSTIC_CASE_PASSED: 'Contrôle réussi',
  DIAGNOSTIC_CASE_FAILED: 'Contrôle en échec',
  DIAGNOSTIC_COMPLETED: 'Diagnostic terminé',
  DIAGNOSTIC_FAILED: 'Échec du diagnostic',
  APP_ACTIVE: 'App au premier plan',
  APP_BACKGROUND: 'App en arrière-plan',
  APP_FOREGROUND: 'Retour au premier plan',
  APP_INACTIVE: 'App inactive',
  MONITOR_STARTED: 'Suivi démarré',
  MONITOR_STOPPED: 'Suivi arrêté',
  PHASE_CHANGED: 'État modifié',
  THERMAL_CHANGED: 'État thermique modifié',
  MEMORY_PRESSURE_CHANGED: 'Pression mémoire modifiée',
};

function number(value: number | null | undefined, digits = 0): string {
  if (value == null) {
    return '—';
  }
  const [whole, fraction] = value.toFixed(digits).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}
function measured(
  value: number | null | undefined,
  unit: string,
  digits = 0,
): string {
  return value == null ? '—' : `${number(value, digits)} ${unit}`;
}
function memory(value: number | null | undefined): string {
  return value == null ? '—' : measured(value / 1_048_576, 'Mio', 1);
}
function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(
    2,
    '0',
  )} s`;
}

export function MonitoringPanel() {
  const { theme } = useAppearance();
  const styles = createStyles(theme);
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const [sharing, setSharing] = useState(false);
  const available = typeof NativeAssist?.getMonitoringSnapshot === 'function';

  useEffect(() => {
    if (!available) {
      return;
    }
    let alive = true;
    let active = AppState.currentState === 'active';
    let version = 0;
    let inFlight = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      if (!alive || !active || inFlight) {
        return;
      }
      const requestVersion = version;
      inFlight = true;
      try {
        const json = await NativeAssist!.getMonitoringSnapshot();
        if (alive && active && requestVersion === version) {
          setSnapshot(parseMonitoringSnapshot(json));
          setFresh(true);
          setError('');
        }
      } catch {
        if (alive && active && requestVersion === version) {
          setError('Suivi temporairement indisponible.');
        }
      } finally {
        inFlight = false;
      }
    };
    const start = () => {
      poll();
      interval = setInterval(poll, 1000);
    };
    const stop = () => {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
    };
    const listener = AppState.addEventListener('change', state => {
      const nextActive = state === 'active';
      if (nextActive === active) {
        return;
      }
      active = nextActive;
      version += 1;
      setForeground(active);
      setFresh(false);
      stop();
      if (active) {
        start();
      }
    });
    if (active) {
      start();
    }
    return () => {
      alive = false;
      version += 1;
      stop();
      listener.remove();
    };
  }, [available]);

  const current = snapshot?.current;
  const diagnostic = snapshot?.diagnostic;
  return (
    <View style={styles.panel}>
      <Text role="heading" style={styles.title}>
        Suivi en temps réel
      </Text>
      {!available ? (
        <Text style={styles.muted}>
          Suivi natif indisponible sur cette plateforme.
        </Text>
      ) : (
        <>
          <Text style={styles.muted}>
            {foreground
              ? 'Actualisation chaque seconde au premier plan.'
              : 'Suivi en pause en arrière-plan.'}
          </Text>
          {error ? (
            <Text role="alert" style={styles.warning}>
              {error}
            </Text>
          ) : null}
          {!current ? (
            <Text style={styles.muted}>En attente d’un échantillon natif…</Text>
          ) : (
            <>
              <Text style={styles.body}>
                État : {phaseLabels[current.phase]}
              </Text>
              <Text style={styles.muted}>
                {!foreground || error || !fresh
                  ? 'Dernier échantillon reçu · '
                  : 'Session · '}
                {duration(current.sessionElapsedMs)}
              </Text>
              <Text style={styles.body}>
                Mémoire de l’app : {memory(current.physicalFootprintBytes)}
              </Text>
              <Text style={styles.body}>
                Décodage :{' '}
                {measured(current.decodeTokensPerSecond, 'jetons/s', 1)}
              </Text>
              <Text style={styles.muted}>
                État thermique : {thermalLabels[current.thermalState]}
              </Text>
              {diagnostic && (
                <View style={styles.group}>
                  <Text style={styles.body}>
                    {diagnostic.completed}/{diagnostic.total} contrôles terminés
                    · {diagnostic.failed} échecs
                  </Text>
                  <View
                    accessible
                    role="progressbar"
                    aria-label="Diagnostic de calcul"
                    accessibilityValue={{
                      min: 0,
                      max: diagnostic.total,
                      now: diagnostic.completed,
                    }}
                    style={styles.track}
                  >
                    <View
                      style={[
                        styles.progress,
                        {
                          width: `${
                            (diagnostic.completed / diagnostic.total) * 100
                          }%`,
                        },
                      ]}
                    />
                  </View>
                </View>
              )}
              <Pressable
                role="button"
                aria-expanded={expanded}
                onPress={() => setExpanded(value => !value)}
                style={styles.secondaryButton}
              >
                <Text style={styles.body}>
                  {expanded
                    ? 'Réduire le tableau de bord'
                    : 'Afficher le tableau de bord'}
                </Text>
              </Pressable>
              {expanded && (
                <>
                  <Text style={styles.muted}>
                    Pic mémoire échantillonné :{' '}
                    {memory(current.peakPhysicalFootprintBytes)}
                  </Text>
                  <Text style={styles.muted}>
                    Budget mémoire disponible pour l’app :{' '}
                    {memory(current.availableMemoryBytes)}
                  </Text>
                  <Text style={styles.muted}>
                    Le budget est une estimation pour ce processus. Le pic est
                    celui de cette session et peut manquer les pointes entre
                    échantillons.
                  </Text>
                  <Sparkline
                    title="Mémoire de l’app"
                    values={snapshot!.history.map(item =>
                      item.physicalFootprintBytes == null
                        ? null
                        : item.physicalFootprintBytes / 1_048_576,
                    )}
                    unit="Mio"
                  />
                  <Text style={styles.muted}>
                    Premier jeton : {measured(current.ttftMs, 'ms', 1)}
                  </Text>
                  <Text style={styles.muted}>
                    Entrée : {number(current.promptTokens)} jetons · Sortie :{' '}
                    {number(current.generatedTokens)} jetons
                  </Text>
                  <Text style={styles.muted}>
                    Durée de génération :{' '}
                    {measured(
                      current.generationElapsedMs == null
                        ? null
                        : current.generationElapsedMs / 1000,
                      's',
                      2,
                    )}
                  </Text>
                  <Text style={styles.muted}>
                    Contexte du modèle :{' '}
                    {measured(current.contextCapacity, 'jetons')}
                  </Text>
                  <Sparkline
                    title="Décodage"
                    values={snapshot!.history.map(
                      item => item.decodeTokensPerSecond ?? null,
                    )}
                    unit="jetons/s"
                  />
                  <Text style={styles.body}>
                    CPU du processus : {measured(current.cpuPercent, '%', 1)}
                  </Text>
                  <Text style={styles.muted}>
                    100 % correspond à un cœur utilisé.
                  </Text>
                  <Text style={styles.muted}>
                    Pression mémoire : {pressureLabels[current.memoryPressure]}
                  </Text>
                  <Text style={styles.muted}>
                    Économie d’énergie :{' '}
                    {current.lowPowerMode ? 'Activée' : 'Désactivée'}
                  </Text>
                  <Text style={styles.muted}>
                    ANE : utilisation non vérifiée.
                  </Text>
                  <Text style={styles.subtitle}>Événements récents</Text>
                  {snapshot!.events.length === 0 ? (
                    <Text style={styles.muted}>
                      Aucun événement enregistré.
                    </Text>
                  ) : (
                    snapshot!.events
                      .slice(-8)
                      .reverse()
                      .map(event => (
                        <View key={event.sequence} style={styles.event}>
                          <Text
                            style={[
                              styles.body,
                              event.severity !== 'info' && styles.warning,
                            ]}
                          >
                            {severityLabels[event.severity]} ·{' '}
                            {eventLabels[event.code] ?? event.code}
                          </Text>
                          <Text style={styles.muted}>
                            {duration(event.elapsedMs)} ·{' '}
                            {phaseLabels[event.phase]}
                          </Text>
                        </View>
                      ))
                  )}
                  <Pressable
                    role="button"
                    aria-expanded={details}
                    onPress={() => setDetails(value => !value)}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.body}>
                      {details
                        ? 'Masquer les méthodes de mesure'
                        : 'Afficher les méthodes de mesure'}
                    </Text>
                  </Pressable>
                  {details && (
                    <View style={styles.group}>
                      <Text style={styles.muted}>
                        Build {snapshot!.nativeBuild} · {snapshot!.osVersion}
                      </Text>
                      {Object.entries(snapshot!.measurementMethods).map(
                        ([key, value]) => (
                          <Text key={key} selectable style={styles.muted}>
                            {key} : {value}
                          </Text>
                        ),
                      )}
                      <Text style={styles.muted}>
                        {snapshot!.history.length}/60 échantillons ·{' '}
                        {snapshot!.events.length}/200 événements ·{' '}
                        {snapshot!.generations?.length ?? 0}/100 générations
                        conservées.
                      </Text>
                    </View>
                  )}
                  <Pressable
                    role="button"
                    aria-disabled={sharing}
                    disabled={sharing}
                    style={[styles.button, sharing && styles.disabled]}
                    onPress={async () => {
                      setSharing(true);
                      try {
                        await Share.share({
                          message: JSON.stringify(snapshot, null, 2),
                        });
                      } catch {
                        setError('Partage du suivi indisponible.');
                      } finally {
                        setSharing(false);
                      }
                    }}
                  >
                    <Text style={styles.buttonText}>Partager le suivi</Text>
                  </Pressable>
                  <Text style={styles.muted}>
                    Mesures et événements conservés en mémoire. Le rapport de
                    suivi exclut les messages, les réponses et le chemin du
                    modèle.
                  </Text>
                </>
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}

function Sparkline({
  title,
  values,
  unit,
}: {
  title: string;
  values: (number | null)[];
  unit: string;
}) {
  const { theme } = useAppearance();
  const styles = createStyles(theme);
  const known = values.filter((value): value is number => value !== null);
  if (!known.length) {
    return <Text style={styles.muted}>{title} · historique indisponible.</Text>;
  }
  const maximum = Math.max(...known);
  const minimum = Math.min(...known);
  const range = `${measured(minimum, unit, 1)} à ${measured(maximum, unit, 1)}`;
  return (
    <View style={styles.group}>
      <Text style={styles.muted}>
        {title} · {range}
      </Text>
      <View
        accessible
        role="img"
        aria-label={`${title}, historique de ${values.length} échantillons. ${known.length} mesures disponibles. ${range}.`}
        style={styles.chart}
      >
        {values.map((value, index) => {
          const height =
            value === null
              ? 0
              : Math.max(1, (value / Math.max(1, maximum)) * 40);
          return <View key={index} style={[styles.bar, { height }]} />;
        })}
      </View>
    </View>
  );
}

const createStyles = (theme: AssistTheme) =>
  StyleSheet.create({
    panel: {
      gap: 12,
    },
    title: {
      ...uiGrammar.type.body,
      fontWeight: '600',
      color: theme.colors.text,
    },
    subtitle: {
      ...uiGrammar.type.body,
      fontWeight: '600',
      color: theme.colors.text,
    },
    body: { ...uiGrammar.type.body, color: theme.colors.text },
    muted: { ...uiGrammar.type.label, color: theme.colors.muted },
    warning: { color: theme.colors.danger },
    group: { gap: 8 },
    event: {
      gap: 4,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.border,
      paddingLeft: 12,
    },
    chart: { height: 44, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
    bar: {
      flex: 1,
      maxWidth: 12,
      borderRadius: 2,
      backgroundColor: theme.colors.accent,
    },
    track: {
      height: 8,
      backgroundColor: theme.colors.chip,
      borderRadius: 4,
      overflow: 'hidden',
    },
    progress: { height: 8, backgroundColor: theme.colors.accent },
    button: {
      minHeight: 52,
      paddingVertical: 14,
      paddingHorizontal: 16,
      borderRadius: uiGrammar.radius.control,
      backgroundColor: theme.colors.accent,
      justifyContent: 'center',
    },
    buttonText: {
      ...uiGrammar.type.label,
      color: theme.colors.onAccent,
      textAlign: 'center',
      fontWeight: '600',
    },
    secondaryButton: {
      minHeight: 52,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderRadius: uiGrammar.radius.control,
      backgroundColor: theme.colors.chip,
      justifyContent: 'center',
    },
    disabled: { opacity: 0.35 },
  });
