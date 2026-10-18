import React, { useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAppearance } from './appearance';
import { VOICE_COMPARISON_SAMPLES } from './speechVoices';
import { useSpeechVoiceComparison } from './useSpeechVoiceComparison';
import { ActionButton, SurfaceGroup } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import { scheduleAccessibilityFocus } from './focusAccessibility';

const criteria = [
  ['accent', 'Accent québécois'],
  ['clarity', 'Intelligibilité'],
  ['rhythm', 'Rythme naturel'],
  ['pronunciation', 'Prononciation des noms et des nombres'],
  ['continuity', 'Continuité entre les segments'],
  ['identity', 'Stabilité de la voix'],
] as const;
type Criterion = (typeof criteria)[number][0];
type Trial = {
  id: number;
  voiceId: string;
  label: string;
  sampleId: string;
  mode: 'whole' | 'segmented';
  listeningBlind: boolean;
  ratings: Partial<Record<Criterion, number>>;
  ratingsBlind: Partial<Record<Criterion, boolean>>;
};

/** Fixed text only. Listening never records audio or starts the voice agent. */
export function VoiceComparisonPanel({ onClose }: { onClose: () => void }) {
  const { theme } = useAppearance();
  const { colors } = theme;
  const comparison = useSpeechVoiceComparison();
  const [sampleIndex, setSampleIndex] = useState(0);
  const [mode, setMode] = useState<'whole' | 'segmented'>('whole');
  const [revealed, setRevealed] = useState(false);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [activeTrialId, setActiveTrialId] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [closing, setClosing] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const inventory = comparison.candidates
    .map(voice => voice.id)
    .sort()
    .join('\n');
  const previousInventory = useRef(inventory);
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  useEffect(() => scheduleAccessibilityFocus(() => heading.current), []);
  useEffect(() => {
    if (previousInventory.current !== inventory) {
      previousInventory.current = inventory;
      setTrials([]);
      setActiveTrialId(null);
      setRevealed(false);
      setNotice('');
    }
  }, [inventory]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const busy =
    comparison.loading ||
    comparison.saving ||
    comparison.playingId !== null ||
    closing;
  const sample = VOICE_COMPARISON_SAMPLES[sampleIndex];
  const activeTrial = trials.find(trial => trial.id === activeTrialId);
  const labelFor = (index: number) => `Voix ${index + 1}`;
  const qualityName = {
    default: 'standard',
    enhanced: 'améliorée',
    premium: 'premium',
  };

  async function listen(voiceId: string, label: string) {
    setNotice('');
    const trial: Trial = {
      id: ++sequence.current,
      voiceId,
      label,
      sampleId: sample.id,
      mode,
      listeningBlind: !revealed,
      ratings: {},
      ratingsBlind: {},
    };
    const completed = await comparison.play(
      voiceId,
      mode === 'whole' ? [sample.text] : [...sample.segments],
    );
    if (!mounted.current || !completed) return;
    setTrials(previous => [...previous, trial].slice(-100));
    setActiveTrialId(trial.id);
    setNotice(`${label} : écoute terminée. Tu peux noter cet essai.`);
  }

  function rate(criterion: Criterion, score: number) {
    setTrials(previous =>
      previous.map(trial =>
        trial.id === activeTrialId
          ? {
              ...trial,
              ratings: { ...trial.ratings, [criterion]: score },
              ratingsBlind: { ...trial.ratingsBlind, [criterion]: !revealed },
            }
          : trial,
      ),
    );
  }

  async function close() {
    setClosing(true);
    const stopped = await comparison.stop();
    if (!mounted.current) return;
    setClosing(false);
    if (stopped) onClose();
  }

  async function choose(id: string) {
    setNotice('');
    if (await comparison.chooseVoice(id)) {
      if (mounted.current)
        setNotice('Choix enregistré pour les prochaines réponses vocales.');
    }
  }

  async function share() {
    setNotice('');
    try {
      await Share.share({
        title: 'Comparaison des voix fr-CA',
        message: JSON.stringify(
          {
            schemaVersion: 1,
            kind: 'assistVoiceComparison',
            locale: 'fr-CA',
            nativeBuild: comparison.catalog?.nativeBuild ?? null,
            osVersion: comparison.catalog?.osVersion ?? null,
            engine: 'Apple AVSpeechSynthesizer',
            playback: 'system preview; no microphone or duplex audio graph',
            offlineVerified: false,
            latencyMeasured: false,
            ratingScale: { 1: 'Faible', 2: 'Moyen', 3: 'Bon' },
            criteria: Object.fromEntries(criteria),
            voices: comparison.candidates,
            selectedVoiceId: comparison.catalog?.selectedVoiceId ?? '',
            samples: VOICE_COMPARISON_SAMPLES,
            trials,
            retention: '100 most recent completed listening trials',
          },
          null,
          2,
        ),
      });
    } catch {
      if (mounted.current)
        setNotice('Le rapport n’a pas pu être partagé. Réessaie.');
    }
  }

  return (
    <View style={styles.panel}>
      <Text
        ref={heading}
        {...(Platform.OS === 'web' ? { tabIndex: -1 as const } : {})}
        role="heading"
        style={[styles.title, { color: colors.text }]}
      >
        Comparer les voix fr-CA
      </Text>
      <Text style={[styles.body, { color: colors.muted }]}>
        Écoute les mêmes phrases, puis compare tes impressions. Les noms sont
        masqués au départ. Le micro reste fermé.
      </Text>
      <ActionButton
        label="Fermer le comparatif"
        disabled={closing}
        onPress={close}
      />
      {!comparison.supported && (
        <Text role="alert" style={[styles.body, { color: colors.muted }]}>
          Le comparatif nécessite une version iOS d’Assist qui le prend en
          charge.
        </Text>
      )}
      {comparison.loading && (
        <Text role="status" style={[styles.body, { color: colors.muted }]}>
          Recherche des voix disponibles…
        </Text>
      )}
      {!!comparison.error && (
        <Text role="alert" style={[styles.body, { color: colors.danger }]}>
          {comparison.error}
        </Text>
      )}
      {!!notice && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.body, { color: colors.text }]}
        >
          {notice}
        </Text>
      )}
      {comparison.supported && (
        <>
          <ActionButton
            label="Actualiser les voix"
            disabled={busy}
            onPress={comparison.refresh}
          />
          {comparison.catalog?.selectionMissing &&
            comparison.catalog.resolvedVoiceId && (
              <Text style={[styles.body, { color: colors.muted }]}>
                La voix enregistrée n’est plus disponible. Le mode vocal utilise
                une autre voix fr-CA disponible jusqu’à ton prochain choix.
              </Text>
            )}
          {comparison.catalog && comparison.candidates.length === 0 && (
            <Text style={[styles.body, { color: colors.muted }]}>
              Aucune voix Apple fr-CA disponible. Ajoute une voix française
              canadienne dans les réglages de parole d’iOS, puis actualise la
              liste.
            </Text>
          )}
          {comparison.candidates.length > 0 && (
            <>
              {comparison.candidates.length === 1 && (
                <Text style={[styles.body, { color: colors.muted }]}>
                  Une seule voix est disponible. Tu peux comparer sa lecture
                  entière et sa lecture segmentée, ou ajouter d’autres voix dans
                  les réglages de parole d’iOS.
                </Text>
              )}
              <SurfaceGroup title="Phrase d’essai">
                <ChoiceGroup
                  label="Phrase d’essai"
                  options={VOICE_COMPARISON_SAMPLES.map((item, index) => ({
                    value: String(index),
                    label: item.label,
                  }))}
                  value={String(sampleIndex)}
                  disabled={busy}
                  onChange={value => setSampleIndex(Number(value))}
                />
              </SurfaceGroup>
              <Text style={[styles.body, { color: colors.text }]}>
                {sample.text}
              </Text>
              <SurfaceGroup title="Lecture">
                <ChoiceGroup
                  label="Lecture"
                  options={[
                    { value: 'whole', label: 'Phrase entière' },
                    { value: 'segmented', label: 'Segments successifs' },
                  ]}
                  value={mode}
                  disabled={busy}
                  onChange={value => setMode(value as typeof mode)}
                />
              </SurfaceGroup>
              {comparison.playingId !== null && (
                <ActionButton
                  label="Arrêter l’aperçu"
                  primary
                  onPress={comparison.stop}
                />
              )}
              <SurfaceGroup title="Écoute comparative">
                {comparison.candidates.map((voice, index) => {
                  const label = labelFor(index);
                  return (
                    <View key={voice.id} style={styles.voice}>
                      <Text
                        role="heading"
                        style={[styles.label, { color: colors.text }]}
                      >
                        {label}
                        {revealed
                          ? ` · ${voice.name} · ${qualityName[voice.quality]}`
                          : ''}
                      </Text>
                      <ActionButton
                        label={`Écouter ${label}`}
                        disabled={busy}
                        onPress={() => listen(voice.id, label)}
                      />
                      {comparison.playingId === voice.id && (
                        <Text
                          accessibilityLiveRegion="polite"
                          style={[styles.body, { color: colors.muted }]}
                        >
                          Lecture de {label}…
                        </Text>
                      )}
                      {revealed && (
                        <ActionButton
                          label={`Utiliser ${label}`}
                          hint="Enregistre cette voix pour les prochaines réponses du mode vocal."
                          disabled={busy}
                          onPress={() => choose(voice.id)}
                        />
                      )}
                      {revealed &&
                        comparison.catalog?.selectedVoiceId === voice.id && (
                          <Text style={[styles.body, { color: colors.muted }]}>
                            Voix enregistrée
                          </Text>
                        )}
                    </View>
                  );
                })}
              </SurfaceGroup>
              {activeTrial && (
                <SurfaceGroup title={`Ton avis · ${activeTrial.label}`}>
                  <Text style={[styles.body, { color: colors.muted }]}>
                    {
                      VOICE_COMPARISON_SAMPLES.find(
                        item => item.id === activeTrial.sampleId,
                      )?.label
                    }
                    {' · '}
                    {activeTrial.mode === 'whole'
                      ? 'phrase entière'
                      : 'segments successifs'}
                  </Text>
                  {criteria.map(([key, label]) => (
                    <View key={key} style={styles.rating}>
                      <Text style={[styles.label, { color: colors.text }]}>
                        {label}
                      </Text>
                      {key === 'continuity' && activeTrial.mode === 'whole' ? (
                        <Text style={[styles.body, { color: colors.muted }]}>
                          À évaluer avec la lecture segmentée.
                        </Text>
                      ) : (
                        <ChoiceGroup
                          label={label}
                          options={['Faible', 'Moyen', 'Bon'].map(
                            (text, index) => ({
                              value: String(index + 1),
                              label: text,
                            }),
                          )}
                          value={String(activeTrial.ratings[key] ?? '')}
                          disabled={busy}
                          onChange={value => rate(key, Number(value))}
                        />
                      )}
                    </View>
                  ))}
                </SurfaceGroup>
              )}
              {!revealed && (
                <ActionButton
                  label="Révéler les noms des voix"
                  disabled={busy || trials.length === 0}
                  onPress={() => setRevealed(true)}
                />
              )}
              {revealed && (
                <ActionButton
                  label="Revenir au choix automatique"
                  disabled={busy}
                  onPress={() => choose('')}
                />
              )}
              <ActionButton
                label="Partager le rapport d’écoute"
                disabled={busy || trials.length === 0 || !revealed}
                onPress={share}
              />
              <Text style={[styles.caption, { color: colors.muted }]}>
                Tes avis restent dans ce comparatif jusqu’à sa fermeture. Le
                rapport contient les essais terminés et tes notes. Ces aperçus
                servent à comparer les voix; ils ne mesurent pas la latence ou
                l’annulation d’écho du mode vocal.
              </Text>
            </>
          )}
        </>
      )}
    </View>
  );
}

function ChoiceGroup({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { theme } = useAppearance();
  const { colors } = theme;
  const controls = useRef<(React.ComponentRef<typeof Pressable> | null)[]>([]);
  const selectedIndex = options.findIndex(option => option.value === value);
  return (
    <View role="radiogroup" accessibilityLabel={label} style={styles.choices}>
      {options.map((option, index) => {
        const selected = option.value === value;
        const webProps =
          Platform.OS === 'web'
            ? {
                tabIndex: (index === Math.max(0, selectedIndex) ? 0 : -1) as
                  | 0
                  | -1,
                onKeyDown: (event: {
                  nativeEvent: {
                    key: string;
                    altKey?: boolean;
                    ctrlKey?: boolean;
                    metaKey?: boolean;
                  };
                  preventDefault: () => void;
                }) => {
                  if (disabled) return;
                  const key = event.nativeEvent.key;
                  if (
                    event.nativeEvent.altKey ||
                    event.nativeEvent.ctrlKey ||
                    event.nativeEvent.metaKey
                  )
                    return;
                  let next: number;
                  if (key === 'ArrowDown' || key === 'ArrowRight')
                    next = (index + 1) % options.length;
                  else if (key === 'ArrowUp' || key === 'ArrowLeft')
                    next = (index + options.length - 1) % options.length;
                  else if (key === 'Home') next = 0;
                  else if (key === 'End') next = options.length - 1;
                  else return;
                  event.preventDefault();
                  onChange(options[next].value);
                  controls.current[next]?.focus();
                },
              }
            : {};
        return (
          <Pressable
            {...webProps}
            key={option.value}
            ref={node => {
              controls.current[index] = node;
            }}
            role="radio"
            accessibilityLabel={`${label} : ${option.label}`}
            accessibilityState={{ checked: selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.choice,
              {
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: selected
                  ? colors.activeSurface
                  : colors.surface,
              },
              disabled && { opacity: 0.5 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.body, { color: colors.text }]}>
              {selected ? '● ' : '○ '}
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 16 },
  title: uiGrammar.type.title,
  body: uiGrammar.type.body,
  label: { ...uiGrammar.type.body, fontWeight: '600' },
  caption: uiGrammar.type.caption,
  voice: { gap: 12, paddingVertical: 16 },
  rating: { gap: 8, paddingVertical: 12 },
  choices: { gap: 8 },
  choice: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 12 },
});
