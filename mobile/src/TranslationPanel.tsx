import React, { useEffect, useRef, useState } from 'react';
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
import { ActionButton, SurfaceGroup } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import {
  TranslationAvailability,
  TranslationRequest,
  TranslationResult,
  parseTranslationAvailability,
  parseTranslationCancellation,
  parseTranslationResult,
  validTranslationLanguage,
  validTranslationText,
} from './translationProtocol';

type TranslationBridge = {
  executeTranslation(json: string): Promise<string>;
  cancelTranslation(): Promise<string>;
};
const bridge = NativeAssist as Partial<TranslationBridge> | null;

/** Tactile translation controls. Nothing is downloaded, translated or sent to
 * Gemma at mount. Each request belongs to the current foreground panel epoch. */
export function TranslationPanel({
  blocked,
  onClose,
}: {
  blocked: boolean;
  onClose?: () => void;
}) {
  const {
    theme: { colors },
  } = useAppearance();
  const available =
    Platform.OS === 'ios' &&
    typeof bridge?.executeTranslation === 'function' &&
    typeof bridge?.cancelTranslation === 'function';
  const mounted = useRef(false);
  const foreground = useRef(AppState.currentState === 'active');
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const epoch = useRef(0);
  const busy = useRef(false);
  const cancellationRequired = useRef(false);
  const cancelInFlight = useRef(false);
  const [active, setActive] = useState(foreground.current);
  const [pending, setPending] = useState(false);
  const [needsCancellation, setNeedsCancellation] = useState(false);
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('en');
  const [availability, setAvailability] =
    useState<TranslationAvailability | null>(null);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  function invalidate() {
    ++epoch.current;
  }
  function current(ticket: number) {
    return (
      mounted.current &&
      foreground.current &&
      !blockedRef.current &&
      epoch.current === ticket
    );
  }
  function clearResult() {
    setResult(null);
    setAvailability(null);
    setError(null);
  }
  async function cancel() {
    if (!available || cancelInFlight.current) return;
    const ticket = ++epoch.current;
    cancellationRequired.current = true;
    cancelInFlight.current = true;
    busy.current = true;
    if (mounted.current) {
      clearResult();
      setNeedsCancellation(true);
      setPending(true);
    }
    try {
      parseTranslationCancellation(await bridge!.cancelTranslation!());
      if (epoch.current !== ticket) return;
      cancellationRequired.current = false;
      if (mounted.current) setNeedsCancellation(false);
    } catch {
      if (mounted.current && epoch.current === ticket)
        setError(
          'Annulation non confirmée. Interromps à nouveau avant de continuer.',
        );
    } finally {
      cancelInFlight.current = false;
      if (epoch.current === ticket) {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      setActive(foreground.current);
      if (!foreground.current) {
        setText('');
        if (busy.current) cancel().catch(() => undefined);
        else {
          ++epoch.current;
          clearResult();
        }
      }
    });
    return () => {
      mounted.current = false;
      invalidate();
      listener.remove();
      if (busy.current) cancel().catch(() => undefined);
    };
    // The bridge methods and lifetime refs are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (blocked && busy.current) cancel().catch(() => undefined);
    else if (blocked) {
      ++epoch.current;
      clearResult();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);
  function changed(update: () => void) {
    update();
    ++epoch.current;
    clearResult();
  }
  async function run(
    action: 'availability' | 'translate',
    allowDownload: boolean,
  ) {
    if (
      !available ||
      busy.current ||
      cancellationRequired.current ||
      blockedRef.current ||
      !foreground.current
    )
      return;
    const sourceLanguage = source.trim();
    const targetLanguage = target.trim();
    if (
      !validTranslationLanguage(sourceLanguage, true) ||
      !validTranslationLanguage(targetLanguage) ||
      (action === 'translate' && !validTranslationText(text))
    ) {
      setError(
        'Choisis des codes de langue valides et un texte de 8 Kio maximum, sans marqueurs techniques.',
      );
      return;
    }
    const request: TranslationRequest = {
      schemaVersion: 1,
      requestId: `translation-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`,
      action,
      source_language: sourceLanguage,
      target_language: targetLanguage,
      allow_download: allowDownload,
      ...(action === 'translate' ? { text } : {}),
    };
    const ticket = ++epoch.current;
    busy.current = true;
    setPending(true);
    clearResult();
    try {
      const json = await bridge!.executeTranslation!(JSON.stringify(request));
      if (!current(ticket)) return;
      if (action === 'availability')
        setAvailability(parseTranslationAvailability(json, request));
      else setResult(parseTranslationResult(json, request));
    } catch {
      if (current(ticket))
        setError(
          'Traduction locale indisponible ou langues non installées. Choisis une langue source si la détection est incertaine; autorise un téléchargement pour installer une paire prise en charge.',
        );
    } finally {
      if (epoch.current === ticket) {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    }
  }
  const disabled =
    blocked || !active || pending || needsCancellation || !available;
  const style = [
    styles.input,
    {
      color: colors.text,
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.border,
    },
  ];
  return (
    <SurfaceGroup title="Traduction locale">
      <View style={styles.content}>
        {onClose && (
          <ActionButton
            label="Retour aux réglages"
            onPress={() => {
              if (busy.current) cancel().catch(() => undefined);
              onClose();
            }}
          />
        )}
        <Text style={[styles.body, { color: colors.muted }]}>
          Apple traduit sur cet appareil. Les langues peuvent nécessiter un
          téléchargement autorisé par toi.
        </Text>
        {!available && (
          <Text style={[styles.body, { color: colors.muted }]}>
            Cette capacité nécessite le nouveau binaire iOS.
          </Text>
        )}
        <TextInput
          accessibilityLabel="Texte à traduire"
          value={text}
          onChangeText={value => changed(() => setText(value))}
          editable={!disabled}
          multiline
          style={[...style, styles.text]}
          placeholder="Texte à traduire"
          placeholderTextColor={colors.muted}
        />
        <TextInput
          accessibilityLabel="Langue source"
          value={source}
          onChangeText={value => changed(() => setSource(value))}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          style={style}
          placeholder="Source : vide pour détecter, fr, en…"
          placeholderTextColor={colors.muted}
        />
        <TextInput
          accessibilityLabel="Langue cible"
          value={target}
          onChangeText={value => changed(() => setTarget(value))}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          style={style}
          placeholder="Cible : en, fr, es…"
          placeholderTextColor={colors.muted}
        />
        <ActionButton
          label="Vérifier les langues"
          disabled={disabled}
          onPress={() => {
            run('availability', false).catch(() => undefined);
          }}
        />
        <ActionButton
          label="Traduire avec les langues installées"
          disabled={disabled || !text.trim()}
          primary
          onPress={() => {
            run('translate', false).catch(() => undefined);
          }}
        />
        <ActionButton
          label="Autoriser le téléchargement et traduire"
          disabled={disabled || !text.trim()}
          onPress={() => {
            run('translate', true).catch(() => undefined);
          }}
          hint="Apple peut demander de télécharger les langues avant la traduction locale."
        />
        {(pending || needsCancellation) && (
          <ActionButton label="Interrompre la traduction" onPress={cancel} />
        )}
        {pending && (
          <Text
            accessibilityRole="text"
            style={[styles.body, { color: colors.muted }]}
          >
            Traduction en cours…
          </Text>
        )}
        {availability && (
          <View>
            <Text style={[styles.body, { color: colors.text }]}>
              Paire :{' '}
              {availability.status === 'installed'
                ? 'installée'
                : availability.status === 'supported'
                ? 'prise en charge, téléchargement requis'
                : availability.status === 'unsupported'
                ? 'non prise en charge'
                : 'choisis la source pour vérifier la paire'}
            </Text>
            <Text style={[styles.body, { color: colors.muted }]}>
              {availability.languages
                .map(language => `${language.label} (${language.identifier})`)
                .join(', ')}
            </Text>
          </View>
        )}
        {result && (
          <View>
            <Text style={[styles.body, { color: colors.muted }]}>
              {result.sourceDetected ? 'Source détectée' : 'Source'} :{' '}
              {result.sourceLanguage} → {result.targetLanguage}
            </Text>
            <Text selectable style={[styles.body, { color: colors.text }]}>
              {result.translatedText}
            </Text>
          </View>
        )}
        {error && (
          <Text
            accessibilityRole="alert"
            style={[styles.body, { color: colors.danger }]}
          >
            {error}
          </Text>
        )}
      </View>
    </SurfaceGroup>
  );
}
const styles = StyleSheet.create({
  content: {
    gap: uiGrammar.harmony.space.medium,
    padding: uiGrammar.harmony.space.medium,
  },
  body: uiGrammar.type.body,
  input: {
    minHeight: uiGrammar.touchTarget,
    borderWidth: 1,
    borderRadius: uiGrammar.radius.control,
    padding: 12,
    ...uiGrammar.type.body,
  },
  text: { minHeight: 120, textAlignVertical: 'top' },
});
