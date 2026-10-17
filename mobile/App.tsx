import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
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
import { InterfaceIcon } from './src/InterfaceIcon';
import { AppearanceProvider, useAppearance } from './src/appearance';
import type { AssistTheme } from './src/appearance';
import { AppearancePicker } from './src/AppearancePicker';
import { ModelWorkspace } from './src/ModelWorkspace';
import { DiagnosticsWorkspace } from './src/DiagnosticsWorkspace';
import { SettingsScreen } from './src/SettingsScreen';
import { ActionButton, Disclosure } from './src/uiPrimitives';
import { uiGrammar } from './src/uiGrammar';
import { useLocalVoice } from './src/useLocalVoice';
import { VoiceConversationScreen } from './src/VoiceConversationScreen';
import { VoiceConversationController } from './src/VoiceConversationController';
import type { ConversationVoiceState } from './src/VoiceConversationController';
import { useVoicePreferences } from './src/useVoicePreferences';
import { ResponseSpeechStream } from './src/responseSpeech';
import {
  AssistantMark,
  ConversationIntro,
  ConversationExample,
} from './src/ConversationIntro';
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
      return parseMonitoringSnapshot(
        await NativeAssist.getMonitoringSnapshot(),
      );
    }
  } catch {
    // The optional sampler must not prevent sharing the original qualification evidence.
  }
  return null;
}

export function AssistantScreen() {
  const { theme } = useAppearance();
  const styles = createStyles(theme);
  const [showAppearance, setShowAppearance] = useState(false);
  const [showExample, setShowExample] = useState(false);
  const appearanceControl = useRef<React.ComponentRef<typeof View>>(null);
  const [tab, setTab] = useState<'chat' | 'settings' | 'model' | 'lab'>('chat');
  const [showBudget, setShowBudget] = useState(false);
  const [hasOpenedDiagnostics, setHasOpenedDiagnostics] = useState(false);
  const [modelOrigin, setModelOrigin] = useState<'chat' | 'settings'>('chat');
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const conversationRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [engine, setEngine] = useState<EngineState>({
    phase: 'idle',
    contextCapacity: 0,
  });
  const [selected, setSelected] = useState(false);
  const [selectionVersion, setSelectionVersion] = useState(0);
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
  const preferences = useVoicePreferences();
  const { readResponses } = preferences;
  const readResponsesEnabled = useRef(readResponses);
  readResponsesEnabled.current = readResponses;
  const [speechMode, setSpeechMode] = useState(false);
  const [voiceConversation, setVoiceConversation] =
    useState<ConversationVoiceState>({
      phase: 'paused',
      transcript: '',
      reply: '',
      error: '',
      diagnostics: null,
    });
  const voiceController = useRef<VoiceConversationController | null>(null);
  const voiceCommands = useRef<{
    startCapture: (isCurrent: () => boolean) => Promise<boolean>;
    finishCapture: () => Promise<void>;
    cancel: () => Promise<void>;
    cancelResponse: () => Promise<void>;
    generate: (
      text: string,
      isCurrent: () => boolean,
    ) => Promise<{ text: string; spoken: boolean }>;
  } | null>(null);
  if (!voiceController.current) {
    voiceController.current = new VoiceConversationController({
      startCapture: valid => voiceCommands.current!.startCapture(valid),
      finishCapture: () => voiceCommands.current!.finishCapture(),
      cancel: () => voiceCommands.current!.cancel(),
      cancelResponse: () => voiceCommands.current!.cancelResponse(),
      generate: (text, valid) => voiceCommands.current!.generate(text, valid),
      changed: state => {
        if (mounted.current) setVoiceConversation(state);
      },
    });
  }
  const controller = voiceController.current;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const requestPrompt = useRef('');
  const pendingVoiceTurn = useRef<{ id: string; messages: Message[] } | null>(null);
  const speechIntent = useRef(0);
  const spokenRequest = useRef<string | null>(null);
  const responseSpeech = useRef<ResponseSpeechStream | null>(null);
  const voice = useLocalVoice({
    enabled: tab === 'chat' && speechMode,
    onTranscript: () => undefined,
    onEvent: event => controller.event(event),
  });
  const cancelVoice = voice.cancel;
  const speakResponse = voice.speak;
  const cancelGeneration = useCallback(async () => {
    speechIntent.current += 1;
    spokenRequest.current = null;
    responseSpeech.current?.cancel();
    responseSpeech.current = null;
    // Silence audio before waiting for cooperative Gemma cancellation.
    const audioStopped = await cancelVoice();
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
    return audioStopped;
  }, [cancelVoice]);

  // Native barge-in has already silenced playback and kept the same ASR task.
  // Retire JS scheduling synchronously, then cancel Gemma without cancelVoice.
  const cancelResponse = useCallback(async () => {
    speechIntent.current += 1;
    spokenRequest.current = null;
    responseSpeech.current?.cancel();
    responseSpeech.current = null;
    if (mounted.current) {
      setProgress(null);
      setReport(null);
    }
    const requestId = active.current;
    // Preserve the interrupted user's intent, without saving an unspoken or
    // incomplete assistant answer as a completed response.
    if (pendingVoiceTurn.current?.id === requestId) {
      messagesRef.current = pendingVoiceTurn.current.messages;
      if (mounted.current) setMessages(messagesRef.current);
      pendingVoiceTurn.current = null;
    }
    if (!requestId) return;
    if (!NativeAssist) throw new Error('Le moteur local est indisponible.');
    const state = parseState(await NativeAssist.cancel());
    if (mounted.current && (active.current === requestId || active.current === null)) {
      statusVersion.current += 1;
      setEngine(previous => ({
        ...state,
        bundledModelAvailable:
          state.bundledModelAvailable ?? previous.bundledModelAvailable,
      }));
    }
  }, []);

  useEffect(() => {
    if (tab !== 'chat') {
      if (controller.isActive()) controller.pause();
      speechIntent.current += 1;
      spokenRequest.current = null;
      responseSpeech.current?.cancel();
      responseSpeech.current = null;
    }
  }, [tab, controller]);

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
          controller.progress(update.text);
          if (
            spokenRequest.current === update.requestId &&
            readResponsesEnabled.current
          ) {
            responseSpeech.current?.push(update.text);
          }
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
      controller.pause();
      responseSpeech.current?.cancel();
      responseSpeech.current = null;
      subscription?.remove();
      lifecycle.remove();
      if (active.current) {
        NativeAssist?.cancel().catch(() => undefined);
      }
    };
  }, [cancelGeneration, controller]);

  async function perform(action: () => Promise<void>, fromVoice = false) {
    if (operation.current || !NativeAssist) {
      return;
    }
    operation.current = true;
    statusVersion.current += 1;
    setBusy(true);
    setError('');
    try {
      spokenRequest.current = null;
      responseSpeech.current?.cancel();
      responseSpeech.current = null;
      const audioReady = fromVoice
        ? await voice.prepareResponse()
        : await cancelVoice();
      if (!audioReady) {
        throw new Error('La voix doit être arrêtée avant de continuer.');
      }
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

  async function send(
    text = prompt,
    fromVoice = false,
    isCurrent = () => true,
  ): Promise<(GenerationResult & { spoken: boolean }) | undefined> {
    if (
      !text.trim() ||
      engine.phase !== 'ready' ||
      (!fromVoice && voice.captureBusy) ||
      !isCurrent()
    ) {
      return;
    }
    const speechVersion = speechIntent.current;
    const readThisResponse = fromVoice && readResponsesEnabled.current;
    let completed: (GenerationResult & { spoken: boolean }) | undefined;
    await perform(async () => {
      if (!isCurrent()) return;
      const maxTokens = outputBudget(budget);
      requestPrompt.current = text.trim();
      setShowExample(false);
      const requestId = `request-${Date.now()}-${++counter.current}`;
      if (fromVoice) controller.expectSpeech(requestId);
      spokenRequest.current =
        readThisResponse &&
        readResponsesEnabled.current &&
        speechVersion === speechIntent.current
          ? requestId
          : null;
      const history = messagesRef.current;
      const last = history.at(-1);
      // Gemma's chat template requires alternating roles. An interrupted user
      // turn followed by a correction is one user message in the model context.
      const conversation: Message[] = last?.role === 'user'
        ? [...history.slice(0, -1), { role: 'user', content: `${last.content}\n\n${text.trim()}` }]
        : [...history, { role: 'user', content: text.trim() }];
      if (fromVoice) pendingVoiceTurn.current = { id: requestId, messages: conversation };
      active.current = requestId;
      let speechFailed = false;
      const stream: ResponseSpeechStream | null =
        spokenRequest.current && voice.streamingSupported
          ? new ResponseSpeechStream({
              begin: () => voice.beginSpeech(requestId),
              enqueue: chunk => voice.enqueueSpeech(chunk, requestId),
              finish: () => voice.finishSpeech(requestId),
              onError: () => {
                speechFailed = true;
                // A failed optional voice stream must not abort the local answer
                // or mute a newer capture/response that replaced this one.
                if (responseSpeech.current === stream) {
                  responseSpeech.current = null;
                  spokenRequest.current = null;
                  cancelVoice();
                }
              },
            })
          : null;
      responseSpeech.current = stream;
      let speechFinished = false;
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
        if (mounted.current && isCurrent()) {
          setProgress(result);
          setReport(result);
          // Incomplete text is visible but never silently saved as a completed turn.
          if (result.finishReason === 'eos' && result.text.trim().length > 0) {
            const nextMessages: Message[] = [
              ...conversation,
              { role: 'assistant', content: result.text },
            ];
            messagesRef.current = nextMessages;
            if (pendingVoiceTurn.current?.id === requestId) pendingVoiceTurn.current = null;
            setMessages(nextMessages);
            if (fromVoice) controller.progress(result.text);
            if (!fromVoice) setPrompt('');
            setProgress(null);
            if (
              spokenRequest.current === requestId &&
              readResponsesEnabled.current &&
              speechVersion === speechIntent.current
            ) {
              spokenRequest.current = null;
              if (stream) {
                await stream.finish(result.text);
                speechFinished = true;
              } else {
                await speakResponse(result.text, requestId);
                speechFinished = true;
              }
            }
            if (speechFailed) {
              throw new Error(
                'La réponse est disponible, mais sa lecture a échoué. Reprends pour réessayer.',
              );
            }
            completed = {
              ...result,
              spoken: readThisResponse && speechFinished,
            };
          }
        }
      } finally {
        if (pendingVoiceTurn.current?.id === requestId) pendingVoiceTurn.current = null;
        if (responseSpeech.current === stream) {
          responseSpeech.current = null;
          stream?.cancel();
          if (
            stream &&
            !speechFinished &&
            spokenRequest.current === requestId
          ) {
            spokenRequest.current = null;
            await cancelVoice();
          }
        }
        active.current = null;
      }
    }, fromVoice);
    return completed;
  }

  voiceCommands.current = {
    cancelResponse,
    cancel: async () => {
      if (!(await cancelGeneration()))
        throw new Error('L’arrêt du micro n’a pas été confirmé.');
    },
    finishCapture: async () => {
      if (!(await voice.finishListening())) {
        throw new Error('La dictée n’a pas pu être finalisée.');
      }
    },
    startCapture: async valid => {
      if (!valid()) return false;
      if (!preferences.ready)
        throw new Error('Les réglages vocaux sont en cours de chargement.');
      outputBudget(budget);
      if (!voice.status?.recognitionAvailable)
        throw new Error(
          voice.status?.reason || 'La reconnaissance locale est indisponible.',
        );
      if (readResponsesEnabled.current && !voice.status?.synthesisAvailable) {
        throw new Error(
          'Installe une voix française canadienne ou désactive la lecture dans Réglages.',
        );
      }
      if (readResponsesEnabled.current && !voice.streamingSupported) {
        throw new Error(
          'Mets Assist à jour pour utiliser la conversation vocale.',
        );
      }
      // Explicit start/resume/interrupt already cancel in the coordinator.
      // Natural completion may retain native ASR briefly; adopt it without a
      // redundant cancel that would discard the user's first overlapping word.
      if (operation.current || !valid()) return false;
      return voice.startListening();
    },
    generate: async (text, valid) => {
      const result = await send(text, true, valid);
      if (!result || result.finishReason !== 'eos' || !result.text.trim()) {
        throw new Error(
          'La réponse locale ne s’est pas terminée. Reprends pour réessayer.',
        );
      }
      return { text: result.text, spoken: result.spoken };
    },
  };

  useEffect(() => {
    if (speechMode) controller.start();
  }, [speechMode, controller]);

  useEffect(() => {
    if (!speechMode) return;
    const timer = setInterval(() => controller.tick(), 100);
    const lifecycle = AppState.addEventListener('change', state => {
      // Permission prompts are allowed to finish; background always stops.
      if (
        controller.isActive() &&
        (state === 'background' ||
          (state !== 'active' && controller.snapshot().phase !== 'starting'))
      ) {
        controller.pause();
      }
    });
    return () => {
      clearInterval(timer);
      lifecycle.remove();
    };
  }, [speechMode, controller]);

  async function closeSpeechMode() {
    await controller.pause();
    if (mounted.current && controller.snapshot().phase === 'paused')
      setSpeechMode(false);
  }

  async function speechSettings() {
    await controller.pause();
    if (mounted.current && controller.snapshot().phase === 'paused')
      openSettings();
  }

  function changeSpokenReplies(value: boolean) {
    readResponsesEnabled.current = value;
    preferences.change(value);
    if (!value) {
      speechIntent.current += 1;
      spokenRequest.current = null;
      responseSpeech.current?.cancel();
      responseSpeech.current = null;
      cancelVoice();
    }
  }

  const ready = engine.phase === 'ready';
  const translatedPhase = {
    idle: 'Non chargé',
    loading: 'Chargement',
    ready: 'Prêt',
    generating: 'Génération',
    cancelling: 'Annulation',
    failed: 'Échec',
  }[engine.phase];
  let budgetError = '';
  try {
    outputBudget(budget);
  } catch (e) {
    budgetError = errorMessage(e);
  }

  const phaseLabel = !NativeAssist
    ? 'Moteur indisponible'
    : busy
    ? active.current
      ? 'Réponse en cours'
      : 'Opération en cours'
    : ready
    ? 'Prêt sur cet appareil'
    : 'Modèle à charger';

  function confirmClear(title: string, action: () => unknown) {
    if (!messages.length && !progress && !prompt.trim()) {
      action();
      return;
    }
    Alert.alert(
      title,
      'La conversation et le brouillon seront effacés de cette session.',
      [
        { text: 'Conserver', style: 'cancel' },
        {
          text: 'Effacer et continuer',
          style: 'destructive',
          onPress: () => {
            action();
          },
        },
      ],
    );
  }

  function newConversation() {
    confirmClear('Nouvelle conversation ?', () =>
      perform(async () => {
        await NativeAssist!.reset();
        setShowExample(false);
        setMessages([]);
        setPrompt('');
        setProgress(null);
        setReport(null);
      }),
    );
  }

  function draft(text: string) {
    setPrompt(previous => (previous.trim() ? `${previous}\n${text}` : text));
    inputRef.current?.focus();
  }

  const generating = busy && active.current !== null;
  const cannotSend =
    busy || voice.captureBusy || !ready || !prompt.trim() || !!budgetError;
  const pendingUserText = progress || generating ? requestPrompt.current : '';
  const screenTitle =
    speechMode && tab === 'chat'
      ? 'Mode vocal'
      : {
          chat: 'Conversation',
          settings: 'Réglages',
          model: 'Modèle',
          lab: 'Diagnostics',
        }[tab];
  const backDestination =
    tab === 'lab' ? 'model' : tab === 'model' ? modelOrigin : 'chat';
  const backLabel = {
    chat: speechMode ? 'Mode vocal' : 'Conversation',
    settings: 'Réglages',
    model: 'Modèle',
  }[backDestination];
  const backAccessibilityLabel = {
    chat: speechMode ? 'Retour au mode vocal' : 'Retour à la conversation',
    settings: 'Retour aux réglages',
    model: 'Retour au modèle',
  }[backDestination];
  function openModel(origin: 'chat' | 'settings') {
    setModelOrigin(origin);
    setTab('model');
  }
  function openSettings(response = false) {
    if (response) setShowBudget(true);
    setTab('settings');
  }
  function openDiagnostics() {
    setHasOpenedDiagnostics(true);
    setTab('lab');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} />
      <KeyboardAvoidingView
        style={styles.shell}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {!(speechMode && tab === 'chat') && (
          <View style={styles.header}>
            {tab === 'chat' ? (
              <>
                <Text role="heading" style={styles.wordmark}>
                  Assist
                </Text>
                <View style={styles.headerActions}>
                  <Pressable
                    role="button"
                    aria-label="Réglages"
                    onPress={() => openSettings()}
                    style={({ pressed }) => [
                      styles.settingsControl,
                      pressed && styles.pressed,
                    ]}
                  >
                    <InterfaceIcon
                      name="settings"
                      size={20}
                      color={theme.colors.muted}
                    />
                    <Text style={styles.headerLabel}>Réglages</Text>
                  </Pressable>
                  <Pressable
                    role="button"
                    aria-label="Nouvelle conversation"
                    aria-disabled={busy || !ready}
                    disabled={busy || !ready}
                    onPress={newConversation}
                    style={({ pressed }) => [
                      styles.headerControl,
                      pressed && styles.pressed,
                      (busy || !ready) && styles.disabled,
                    ]}
                  >
                    <InterfaceIcon
                      name="compose"
                      size={24}
                      color={theme.colors.text}
                    />
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Pressable
                  role="button"
                  aria-label={backAccessibilityLabel}
                  aria-disabled={tab === 'lab' && busy}
                  disabled={tab === 'lab' && busy}
                  onPress={() => setTab(backDestination)}
                  style={({ pressed }) => [
                    styles.backControl,
                    tab === 'lab' && busy && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.backArrow}>
                    <InterfaceIcon
                      name="arrow"
                      size={20}
                      color={theme.colors.muted}
                    />
                  </View>
                  <Text style={styles.headerLabel}>{backLabel}</Text>
                </Pressable>
                {tab === 'lab' && (
                  <Text role="heading" style={styles.screenTitle}>
                    {screenTitle}
                  </Text>
                )}
              </>
            )}
          </View>
        )}
        {tab === 'chat' &&
          !speechMode &&
          (showExample ||
            ready ||
            busy ||
            messages.length > 0 ||
            !!report ||
            !!progress) && (
            <View style={styles.statusArea}>
              <Pressable
                role="button"
                aria-label="Configurer le modèle"
                onPress={() => openModel('chat')}
                style={({ pressed }) => [
                  styles.modelStatus,
                  pressed && styles.pressed,
                ]}
              >
                <InterfaceIcon
                  name="model"
                  size={20}
                  color={theme.colors.muted}
                />
                <Text
                  role={!NativeAssist ? 'alert' : undefined}
                  style={styles.modelStatusText}
                >
                  {!NativeAssist ? 'Moteur iOS indisponible' : phaseLabel}
                </Text>
                <InterfaceIcon
                  name="arrow"
                  size={20}
                  color={theme.colors.muted}
                />
              </Pressable>
            </View>
          )}
        {!!error && !(speechMode && tab === 'chat') && (
          <Text role="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <View role="region" aria-label={screenTitle} style={styles.workspace}>
          {tab === 'chat' && speechMode && (
            <VoiceConversationScreen
              {...voiceConversation}
              audioDiagnostics={voice.audioDiagnostics}
              bargeInReady={voice.status?.phase === 'speaking' && voice.status.monitoring === true}
              readResponses={readResponses}
              onPause={() => {
                controller.pause();
              }}
              onResume={() => {
                controller.start();
              }}
              onInterrupt={() => {
                controller.interrupt();
              }}
              onClose={closeSpeechMode}
              onSettings={speechSettings}
            />
          )}
          {tab === 'chat' && !speechMode && (
            <>
              <ScrollView
                ref={conversationRef}
                style={styles.scroll}
                contentContainerStyle={styles.chatContent}
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => {
                  if (messages.length || progress || generating) {
                    conversationRef.current?.scrollToEnd({ animated: true });
                  }
                }}
              >
                {!messages.length &&
                  !progress &&
                  !pendingUserText &&
                  (showExample ? (
                    <ConversationExample
                      onClose={() => setShowExample(false)}
                      onDraft={draft}
                    />
                  ) : (
                    <ConversationIntro
                      onDraft={draft}
                      onExample={() => setShowExample(true)}
                      ready={ready}
                      busy={busy}
                      nativeAvailable={!!NativeAssist}
                      onConfigure={() => openModel('chat')}
                    />
                  ))}
                {messages.map((message, index) => (
                  <View
                    key={index}
                    style={[
                      styles.messageRow,
                      message.role === 'user' && styles.userRow,
                    ]}
                  >
                    {message.role === 'assistant' && (
                      <AssistantMark size={28} />
                    )}
                    <View
                      style={[
                        styles.bubble,
                        message.role === 'user'
                          ? styles.userBubble
                          : styles.assistantBubble,
                      ]}
                    >
                      {message.role === 'assistant' && (
                        <Text style={styles.messageAuthor}>ASSIST</Text>
                      )}
                      <Text
                        selectable
                        style={[
                          styles.body,
                          message.role === 'user' && styles.userText,
                        ]}
                      >
                        {message.content}
                      </Text>
                    </View>
                  </View>
                ))}
                {!!pendingUserText && (
                  <View style={[styles.messageRow, styles.userRow]}>
                    <View style={[styles.bubble, styles.userBubble]}>
                      <Text selectable style={[styles.body, styles.userText]}>
                        {pendingUserText}
                      </Text>
                    </View>
                  </View>
                )}
                {progress && (
                  <View style={styles.messageRow}>
                    <AssistantMark size={28} />
                    <View style={[styles.bubble, styles.assistantBubble]}>
                      <Text style={styles.messageAuthor}>
                        {report
                          ? report.finishReason === 'cancelled'
                            ? 'RÉPONSE INTERROMPUE'
                            : report.finishReason === 'eos'
                            ? 'RÉPONSE'
                            : 'RÉPONSE INCOMPLÈTE'
                          : 'EN COURS'}
                      </Text>
                      <Text
                        selectable
                        accessibilityLiveRegion="polite"
                        style={styles.body}
                      >
                        {progress.text || 'Préparation de la réponse…'}
                      </Text>
                      {report && report.finishReason !== 'eos' && (
                        <Text style={styles.muted}>
                          Réponse incomplète. Ton message est conservé pour
                          réessayer.
                        </Text>
                      )}
                    </View>
                  </View>
                )}
                {generating && !progress && (
                  <View style={styles.messageRow}>
                    <AssistantMark size={28} />
                    <Text accessibilityLiveRegion="polite" style={styles.muted}>
                      Préparation de la réponse…
                    </Text>
                  </View>
                )}
                {(report || progress) && (
                  <Disclosure title="Détails de la réponse">
                    <Text style={styles.metrics}>
                      {(report || progress)!.promptTokens} jetons d’entrée ·{' '}
                      {(report || progress)!.generatedTokens} en sortie ·{' '}
                      {((report || progress)!.elapsedMs / 1000).toFixed(2)} s
                    </Text>
                  </Disclosure>
                )}
              </ScrollView>
              <View style={styles.composerArea}>
                <ActionButton
                  label="Mode vocal"
                  hint="Ouvre une conversation locale avec écoute et envoi automatiques."
                  disabled={
                    !voice.supported ||
                    busy ||
                    !ready ||
                    !!budgetError ||
                    !preferences.ready ||
                    !voice.status?.recognitionAvailable
                  }
                  onPress={() => {
                    Keyboard.dismiss();
                    setSpeechMode(true);
                  }}
                />
                <View style={styles.composerRow}>
                  <View style={styles.composer}>
                    <TextInput
                      ref={inputRef}
                      aria-label="Message"
                      multiline
                      numberOfLines={Platform.OS === 'web' ? 1 : undefined}
                      editable={!busy && !voice.captureBusy}
                      value={prompt}
                      onChangeText={setPrompt}
                      placeholder="Écris ton message…"
                      placeholderTextColor={theme.colors.placeholder}
                      style={styles.prompt}
                    />
                  </View>
                  <Pressable
                    role="button"
                    aria-label={
                      generating ? 'Annuler la génération' : 'Envoyer'
                    }
                    aria-disabled={generating ? false : cannotSend}
                    disabled={generating ? false : cannotSend}
                    onPress={generating ? cancelGeneration : () => send()}
                    style={({ pressed }) => [
                      styles.sendButton,
                      pressed && styles.pressed,
                      !generating && cannotSend && styles.sendDisabled,
                    ]}
                  >
                    <InterfaceIcon
                      name={generating ? 'stop' : 'send'}
                      size={24}
                      color={
                        !generating && cannotSend
                          ? theme.colors.muted
                          : theme.colors.onAccent
                      }
                    />
                  </Pressable>
                </View>
                {budgetError ? (
                  <Pressable
                    role="button"
                    aria-label="Corriger la limite de réponse"
                    onPress={() => openSettings(true)}
                    style={styles.validationLink}
                  >
                    <Text
                      role="alert"
                      style={[styles.composerHint, styles.fieldError]}
                    >
                      Limite invalide. Corrige-la dans Réglages.
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.composerHint}>
                    {ready
                      ? 'Session temporaire · vérifie les réponses.'
                      : 'Ton brouillon reste disponible. Prépare le modèle pour envoyer.'}
                  </Text>
                )}
              </View>
            </>
          )}
          {tab === 'settings' && (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
            >
              {!!preferences.error && (
                <Text role="alert" style={styles.error}>
                  {preferences.error}
                </Text>
              )}
              <SettingsScreen
                modelStatus={
                  !NativeAssist
                    ? 'Indisponible ici'
                    : busy
                    ? phaseLabel
                    : ready
                    ? 'Prêt'
                    : 'À configurer'
                }
                budget={budget}
                budgetError={budgetError}
                busy={busy}
                readResponses={readResponses}
                onReadResponsesChange={changeSpokenReplies}
                voiceAvailable={voice.status?.synthesisAvailable ?? false}
                responseOpen={showBudget}
                onToggleResponse={() => setShowBudget(value => !value)}
                onBudgetChange={setBudget}
                onModel={() => openModel('settings')}
                onAppearance={() => setShowAppearance(true)}
                appearanceRef={appearanceControl}
              />
            </ScrollView>
          )}
          {tab === 'model' && (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
            >
              <ModelWorkspace
                engine={engine}
                ready={ready}
                busy={busy}
                selected={selected}
                nativeAvailable={!!NativeAssist}
                translatedPhase={translatedPhase}
                canShareReport={!!report || engine.loadElapsedMs != null}
                onLoadBundled={() =>
                  perform(async () => {
                    await NativeAssist!.loadBundledModel();
                    if (mounted.current) {
                      setSelected(false);
                      setSelectionVersion(value => value + 1);
                      setMessages([]);
                      setProgress(null);
                      setReport(null);
                    }
                  })
                }
                onSelectExport={() =>
                  perform(async () => {
                    await NativeAssist!.selectModel();
                    if (mounted.current) {
                      setSelected(true);
                      setSelectionVersion(value => value + 1);
                      setMessages([]);
                      setProgress(null);
                      setReport(null);
                    }
                  })
                }
                onLoadSelected={() =>
                  perform(async () => {
                    await NativeAssist!.loadModel();
                  })
                }
                onUnload={() =>
                  confirmClear('Décharger le modèle ?', () =>
                    perform(async () => {
                      await NativeAssist!.unloadModel();
                      setPrompt('');
                      setMessages([]);
                      setProgress(null);
                      setReport(null);
                    }),
                  )
                }
                onConversation={() => setTab('chat')}
                onDiagnostics={openDiagnostics}
                onShareReport={async () => {
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
            </ScrollView>
          )}
          {hasOpenedDiagnostics && (
            <View
              style={[styles.workspace, tab !== 'lab' && styles.hiddenRoute]}
              accessibilityElementsHidden={tab !== 'lab'}
              importantForAccessibility={
                tab !== 'lab' ? 'no-hide-descendants' : 'auto'
              }
            >
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
              >
                <DiagnosticsWorkspace
                  active={tab === 'lab'}
                  selected={selected}
                  selectionVersion={selectionVersion}
                  busy={busy}
                  ready={ready}
                  perform={perform}
                  onModel={() => setTab('model')}
                >
                  <View style={styles.panel}>
                    <Text style={styles.section}>Diagnostic de calcul</Text>
                    <Text style={styles.muted}>
                      Petit contrôle indépendant de Gemma. Décharge le modèle et
                      garde l’app au premier plan pendant ce diagnostic.
                    </Text>
                    <ActionButton
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
                        {probeReport.summary.nonfinite} valeurs non finies. Ce
                        résultat ne qualifie pas les réponses de Gemma ni
                        l’usage ANE.
                      </Text>
                    )}
                    <ActionButton
                      label="Partager le diagnostic"
                      disabled={!probeReport || busy}
                      onPress={async () => {
                        if (probeReport) {
                          try {
                            const monitoring = await monitoringForShare();
                            await Share.share({
                              message: JSON.stringify(
                                {
                                  ...probeReport,
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
                  </View>
                </DiagnosticsWorkspace>
              </ScrollView>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
      <AppearancePicker
        open={showAppearance}
        onClose={() => {
          setShowAppearance(false);
          requestAnimationFrame(() => appearanceControl.current?.focus());
        }}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <AppearanceProvider>
      <SafeAreaProvider>
        <AssistantScreen />
      </SafeAreaProvider>
    </AppearanceProvider>
  );
}
const createStyles = (theme: AssistTheme) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.background },
    shell: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
    workspace: { flex: 1 },
    hiddenRoute: { display: 'none' },
    header: {
      paddingHorizontal: uiGrammar.gutter,
      paddingTop: 8,
      paddingBottom: 8,
      minHeight: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      justifyContent: 'space-between',
    },
    wordmark: {
      ...uiGrammar.type.navigation,
      fontWeight: '600',
      letterSpacing: -0.5,
      color: theme.colors.text,
      flex: 1,
    },
    headerActions: { flexDirection: 'row', gap: 4, alignItems: 'center' },
    headerControl: {
      minWidth: uiGrammar.touchTarget,
      minHeight: uiGrammar.touchTarget,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: uiGrammar.radius.control,
    },
    settingsControl: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 4,
      borderRadius: 12,
    },
    headerLabel: {
      ...uiGrammar.type.label,
      color: theme.colors.muted,
      flexShrink: 1,
    },
    backControl: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      maxWidth: '55%',
      flexShrink: 1,
    },
    screenTitle: {
      ...uiGrammar.type.navigation,
      fontWeight: '600',
      letterSpacing: -0.5,
      color: theme.colors.text,
      textAlign: 'right',
      flexShrink: 1,
    },

    backArrow: { transform: [{ rotate: '180deg' }] },
    statusArea: { paddingHorizontal: uiGrammar.gutter, paddingBottom: 8 },
    modelStatus: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderBottomWidth: 1,
      borderColor: theme.colors.separator,
    },
    modelStatusText: {
      ...uiGrammar.type.label,
      color: theme.colors.muted,
      flex: 1,
    },

    error: {
      padding: 12,
      marginHorizontal: uiGrammar.gutter,
      marginVertical: 8,
      color: theme.colors.danger,
      backgroundColor: theme.colors.dangerSurface,
      borderRadius: 12,
      ...uiGrammar.type.label,
    },
    scroll: { flex: 1 },
    chatContent: {
      flexGrow: 1,
      paddingHorizontal: uiGrammar.gutter,
      paddingVertical: 16,
      gap: 24,
    },
    messageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 13 },
    userRow: { justifyContent: 'flex-end' },
    bubble: {
      maxWidth: '84%',
      borderRadius: uiGrammar.radius.bubble,
      padding: 16,
      gap: 8,
    },
    userBubble: {
      backgroundColor: theme.colors.userBubble,
      borderBottomRightRadius: 4,
    },
    assistantBubble: {
      backgroundColor: 'transparent',
      padding: 0,
      paddingTop: 2,
      flexShrink: 1,
    },
    messageAuthor: {
      ...uiGrammar.type.caption,
      letterSpacing: 0.8,
      fontWeight: '600',
      color: theme.colors.muted,
    },
    body: { ...uiGrammar.type.body, color: theme.colors.text },
    userText: { color: theme.colors.userText },
    muted: { color: theme.colors.muted, ...uiGrammar.type.label },
    metrics: {
      ...uiGrammar.type.caption,
      color: theme.colors.muted,
    },
    composerArea: {
      paddingHorizontal: uiGrammar.gutter,
      paddingTop: 8,
      paddingBottom: 8,
      backgroundColor: theme.colors.background,
    },

    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
    composer: {
      flex: 1,
      borderRadius: uiGrammar.radius.pill,
      backgroundColor: theme.colors.composer,
      borderWidth: uiGrammar.composer.border,
      borderColor: theme.colors.border,
    },
    prompt: {
      ...uiGrammar.type.body,
      color: theme.colors.text,
      minHeight: uiGrammar.composer.height - 2 * uiGrammar.composer.border,
      maxHeight: uiGrammar.composer.maxHeight - 2 * uiGrammar.composer.border,
      paddingHorizontal: 16 - uiGrammar.composer.border,
      paddingVertical: 12 - uiGrammar.composer.border,
      textAlignVertical: 'top',
    },
    sendButton: {
      height: uiGrammar.composer.height,
      width: uiGrammar.composer.height,
      borderRadius: uiGrammar.composer.height / 2,
      backgroundColor: theme.colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendDisabled: {
      backgroundColor: theme.colors.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    validationLink: { minHeight: 44, justifyContent: 'center' },
    composerHint: {
      ...uiGrammar.type.caption,
      color: theme.colors.muted,
      textAlign: 'center',
      marginTop: 8,
    },

    fieldError: { ...uiGrammar.type.label, color: theme.colors.danger },

    content: { padding: uiGrammar.gutter, gap: 16, paddingBottom: 36 },

    panel: {
      padding: 0,
      gap: 16,
    },
    section: {
      ...uiGrammar.type.body,
      color: theme.colors.text,
      fontWeight: '600',
    },

    disabled: { opacity: 0.42 },
    pressed: { opacity: 0.7 },
  });
