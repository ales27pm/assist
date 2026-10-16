import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import NativeAssist from './specs/NativeAssist';
import { MonitoringPanel } from './src/MonitoringPanel';
import { parseMonitoringSnapshot } from './src/monitoring';
import {
  EngineState,
  GenerationResult,
  Message,
  Progress,
  PrimitiveReport,
  errorMessage,
  outputBudget,
  parseProgress,
  parsePrimitiveReport,
  parseResult,
  parseState,
} from './src/protocol';

async function monitoringForShare() {
  try {
    if (typeof NativeAssist?.getMonitoringSnapshot === 'function') {
      return parseMonitoringSnapshot(await NativeAssist.getMonitoringSnapshot());
    }
  } catch {
    // The optional sampler must not prevent sharing the original qualification evidence.
  }
  return null;
}

export function AssistantScreen() {
  const [engine, setEngine] = useState<EngineState>({
    phase: 'idle',
    contextCapacity: 0,
  });
  const [selected, setSelected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [budget, setBudget] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<GenerationResult | null>(null);
  const [probeReport, setProbeReport] = useState<PrimitiveReport | null>(null);
  const active = useRef<string | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const counter = useRef(0);
  const statusVersion = useRef(0);
  const cancelGeneration = useCallback(async () => {
    const requestId = active.current;
    try {
      const json = await NativeAssist?.cancel();
      if (
        json &&
        mounted.current &&
        (active.current === requestId || active.current === null)
      ) {
        const state = parseState(json);
        statusVersion.current += 1;
        setEngine(previous => ({
          ...state,
          bundledModelAvailable:
            state.bundledModelAvailable ?? previous.bundledModelAvailable,
        }));
      }
    } catch (e) {
      if (mounted.current) {
        setError(errorMessage(e));
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const version = statusVersion.current;
    NativeAssist?.getStatus()
      .then(value => {
        if (
          mounted.current &&
          !operation.current &&
          version === statusVersion.current
        ) {
          setEngine(parseState(value));
        }
      })
      .catch(e => {
        if (mounted.current) {
          setError(errorMessage(e));
        }
      });
    const subscription = NativeAssist?.onProgress(event => {
      if (!mounted.current) {
        return;
      }
      try {
        const update = parseProgress(event.json);
        if (update.requestId === active.current) {
          setProgress(update);
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    });
    const lifecycle = AppState.addEventListener('change', state => {
      if (state !== 'active' && active.current) {
        cancelGeneration();
      }
    });
    return () => {
      mounted.current = false;
      subscription?.remove();
      lifecycle.remove();
      if (active.current) {
        NativeAssist?.cancel().catch(() => undefined);
      }
    };
  }, [cancelGeneration]);

  async function perform(action: () => Promise<void>) {
    if (operation.current || !NativeAssist) {
      return;
    }
    operation.current = true;
    statusVersion.current += 1;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (mounted.current) {
        setError(errorMessage(e));
      }
    } finally {
      try {
        const version = statusVersion.current;
        const value = await NativeAssist.getStatus();
        if (mounted.current && version === statusVersion.current) {
          setEngine(parseState(value));
        }
      } catch (e) {
        if (mounted.current) {
          setError(errorMessage(e));
        }
      }
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }

  async function send() {
    if (!prompt.trim() || engine.phase !== 'ready') {
      return;
    }
    await perform(async () => {
      const maxTokens = outputBudget(budget);
      const requestId = `request-${Date.now()}-${++counter.current}`;
      const conversation: Message[] = [
        ...messages,
        { role: 'user', content: prompt.trim() },
      ];
      active.current = requestId;
      setProgress(null);
      setReport(null);
      try {
        const json = await NativeAssist!.generate(
          JSON.stringify({
            requestId,
            messages: conversation,
            maxTokens,
            temperature: 0,
          }),
        );
        const result = parseResult(json);
        if (result.requestId !== requestId) {
          throw new Error('Identité de génération incohérente.');
        }
        if (mounted.current) {
          setProgress(result);
          setReport(result);
          // Incomplete text is visible but never silently saved as a completed turn.
          if (result.finishReason === 'eos' && result.text.length > 0) {
            setMessages([
              ...conversation,
              { role: 'assistant', content: result.text },
            ]);
            setPrompt('');
            setProgress(null);
          }
        }
      } finally {
        active.current = null;
      }
    });
  }

  const ready = engine.phase === 'ready';
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>PROTOTYPE LOCAL · iOS</Text>
        <Text role="heading" style={styles.title}>
          Assist
        </Text>
        <Text style={styles.subtitle}>Gemma 4 E2B · Core AI</Text>
        <Text style={styles.muted}>
          32K est une cible à qualifier, pas une promesse de performance. Aucune
          inférence cloud. Exécution ANE non mesurée.
        </Text>
        {!NativeAssist && (
          <Text role="alert" style={styles.error}>
            Moteur iOS indisponible. Android n’a pas encore de moteur natif.
          </Text>
        )}
        {!!error && (
          <Text role="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <View style={styles.panel}>
          <Text style={styles.section}>Modèle sur l’appareil</Text>
          {busy && <Text style={styles.muted}>Opération native en cours…</Text>}
          <Text style={styles.muted}>
            État : {engine.phase} · contexte détecté :{' '}
            {engine.contextCapacity || '—'} jetons
          </Text>
          {!!engine.modelName && (
            <Text style={styles.body}>{engine.modelName}</Text>
          )}
          {engine.loadElapsedMs != null && (
            <Text style={styles.muted}>
              Dernier chargement : {(engine.loadElapsedMs / 1000).toFixed(2)} s.
              Le pic réel de chargement n’est pas mesuré.
            </Text>
          )}
          <Text style={styles.muted}>
            {engine.bundledModelAvailable === true
              ? 'Gemma intégré détecté. Chargement entièrement sur l’appareil.'
              : engine.bundledModelAvailable === false
              ? 'Gemma n’est pas intégré à cette build.'
              : 'Disponibilité du modèle intégré non confirmée.'}
          </Text>
          <Action
            label="Charger Gemma intégré"
            disabled={
              busy || ready || !engine.bundledModelAvailable || !NativeAssist
            }
            onPress={() =>
              perform(async () => {
                await NativeAssist!.loadBundledModel();
                if (mounted.current) {
                  setSelected(false);
                  setMessages([]);
                  setProgress(null);
                  setReport(null);
                }
              })
            }
          />
          <Text style={styles.muted}>
            Option avancée : sélectionner un export local compatible.
          </Text>
          <Action
            label="Choisir un dossier exporté"
            disabled={busy || ready || !NativeAssist}
            onPress={() =>
              perform(async () => {
                await NativeAssist!.selectModel();
                if (mounted.current) {
                  setSelected(true);
                  setMessages([]);
                  setProgress(null);
                  setReport(null);
                }
              })
            }
          />
          <Action
            label="Charger le modèle"
            disabled={busy || ready || !selected || !NativeAssist}
            onPress={() =>
              perform(async () => {
                await NativeAssist!.loadModel();
              })
            }
          />
          <Action
            label="Décharger"
            disabled={busy || !ready}
            onPress={() =>
              perform(async () => {
                await NativeAssist!.unloadModel();
                setMessages([]);
                setProgress(null);
                setReport(null);
              })
            }
          />
        </View>
        <MonitoringPanel />
        <View style={styles.panel}>
          <Text style={styles.section}>Conversation</Text>
          <Text style={styles.muted}>
            Historique en mémoire pour ce prototype. Pas encore de mémoire
            personnelle persistante ni d’exécution d’outils.
          </Text>
          {messages.map((message, index) => (
            <View key={index} style={styles.message}>
              <Text style={styles.eyebrow}>
                {message.role === 'user' ? 'TOI' : 'ASSIST'}
              </Text>
              <Text selectable style={styles.body}>
                {message.content}
              </Text>
            </View>
          ))}
          {progress && (
            <View style={styles.message}>
              <Text style={styles.eyebrow}>
                SORTIE{report ? ` · ${report.finishReason}` : ' · EN COURS'}
              </Text>
              <Text selectable style={styles.body}>
                {progress.text || 'Préremplissage…'}
              </Text>
            </View>
          )}
          {(report || progress) && (
            <Text style={styles.muted}>
              {(report || progress)!.promptTokens} jetons d’entrée ·{' '}
              {(report || progress)!.generatedTokens} en sortie ·{' '}
              {((report || progress)!.elapsedMs / 1000).toFixed(2)} s
            </Text>
          )}
          <Text style={styles.body}>Budget de sortie facultatif</Text>
          <TextInput
            aria-label="Budget de sortie"
            keyboardType="number-pad"
            editable={!busy}
            value={budget}
            onChangeText={setBudget}
            placeholder="Vide : contexte restant"
            placeholderTextColor="#879897"
            style={styles.input}
          />
          <TextInput
            aria-label="Message"
            multiline
            editable={!busy}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Écris ton message…"
            placeholderTextColor="#879897"
            style={[styles.input, styles.prompt]}
          />
          <Action
            label="Envoyer"
            disabled={busy || !ready || !prompt.trim()}
            onPress={send}
          />
          <Action
            label="Annuler la génération"
            disabled={!busy || !active.current}
            onPress={cancelGeneration}
          />
          <Action
            label="Nouvelle conversation"
            disabled={busy || !ready}
            onPress={() =>
              perform(async () => {
                await NativeAssist!.reset();
                setMessages([]);
                setProgress(null);
                setReport(null);
              })
            }
          />
          <Action
            label="Partager le rapport"
            disabled={(!report && engine.loadElapsedMs == null) || busy}
            onPress={async () => {
              if (report || engine.loadElapsedMs != null) {
                try {
                  const monitoring = await monitoringForShare();
                  await Share.share({
                    message: JSON.stringify(
                      {
                        schemaVersion: 1,
                        kind: 'assistQualification',
                        engine,
                        generation: report,
                        runtimeMonitoring: monitoring,
                      },
                      null,
                      2,
                    ),
                  });
                } catch (e) {
                  setError(errorMessage(e));
                }
              }
            }}
          />
          <Text style={styles.muted}>
            Le rapport peut contenir la réponse générée : vérifie son contenu
            avant de le partager.
          </Text>
        </View>
        <View style={styles.panel}>
          <Text style={styles.section}>Diagnostic de calcul</Text>
          <Text style={styles.muted}>
            Petit contrôle indépendant de Gemma. Décharge le modèle et garde
            l’app au premier plan pendant ce diagnostic.
          </Text>
          <Action
            label="Tester le calcul natif"
            disabled={busy || ready || !NativeAssist}
            onPress={() =>
              perform(async () => {
                setProbeReport(null);
                const result = parsePrimitiveReport(
                  await NativeAssist!.runNumericalProbe(),
                );
                if (mounted.current) {
                  setProbeReport(result);
                }
              })
            }
          />
          {probeReport && (
            <Text selectable style={styles.body}>
              {probeReport.summary.cases} contrôles ·{' '}
              {probeReport.summary.failed} échecs ·{' '}
              {probeReport.summary.nonfinite} valeurs non finies. Ce résultat ne
              qualifie pas les réponses de Gemma ni l’usage ANE.
            </Text>
          )}
          <Action
            label="Partager le diagnostic"
            disabled={!probeReport || busy}
            onPress={async () => {
              if (probeReport) {
                try {
                  const monitoring = await monitoringForShare();
                  await Share.share({
                    message: JSON.stringify(
                      { ...probeReport, runtimeMonitoring: monitoring },
                      null,
                      2,
                    ),
                  });
                } catch (e) {
                  setError(errorMessage(e));
                }
              }
            }}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => unknown;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => {
        onPress();
      }}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <AssistantScreen />
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b1318' },
  content: { padding: 24, gap: 14, paddingBottom: 48 },
  title: { fontSize: 40, fontWeight: '700', color: '#f0f4ef' },
  subtitle: { fontSize: 20, color: '#d1ded7' },
  eyebrow: {
    color: '#93bfb4',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  muted: { color: '#a6b7b7', lineHeight: 21, fontSize: 14 },
  body: { color: '#f0f4ef', fontSize: 16, lineHeight: 24 },
  section: { fontSize: 20, color: '#f0f4ef', fontWeight: '600' },
  panel: {
    padding: 18,
    gap: 14,
    borderRadius: 18,
    backgroundColor: '#142126',
    borderWidth: 1,
    borderColor: '#304148',
  },
  input: {
    borderWidth: 1,
    borderColor: '#607676',
    borderRadius: 10,
    padding: 14,
    color: '#f0f4ef',
    fontSize: 16,
    backgroundColor: '#0b1318',
  },
  prompt: { minHeight: 120, textAlignVertical: 'top' },
  button: {
    minHeight: 48,
    padding: 14,
    backgroundColor: '#b2d9c5',
    borderRadius: 10,
    justifyContent: 'center',
  },
  buttonText: {
    textAlign: 'center',
    color: '#10251e',
    fontWeight: '600',
    fontSize: 16,
  },
  disabled: { opacity: 0.35 },
  error: {
    padding: 14,
    color: '#ffb4ad',
    backgroundColor: '#392524',
    borderRadius: 10,
  },
  message: {
    gap: 8,
    paddingVertical: 12,
    borderBottomColor: '#304148',
    borderBottomWidth: 1,
  },
});
