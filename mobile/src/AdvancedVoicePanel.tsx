import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAppearance } from './appearance';
import { useAdvancedVoice } from './useAdvancedVoice';
import { ActionButton, Disclosure, SurfaceGroup } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import { scheduleAccessibilityFocus } from './focusAccessibility';
import type {
  AdvancedVoiceBackend,
  AdvancedVoiceVariant,
} from './advancedVoice';

/** Resource management only. Opening this screen never requests the microphone. */
export function AdvancedVoicePanel({ onClose }: { onClose: () => void }) {
  const { theme } = useAppearance();
  const { colors } = theme;
  const voice = useAdvancedVoice();
  const [speakerName, setSpeakerName] = useState('');
  const [consent, setConsent] = useState(false);
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  useEffect(() => scheduleAccessibilityFocus(() => heading.current), []);
  const state = voice.state;
  const disabled = voice.busy || voice.loading;
  const text = { color: colors.text };
  const muted = { color: colors.muted };
  const available = (variant: AdvancedVoiceVariant) =>
    !!(
      state?.resources.pocket &&
      state.resources.silero &&
      state.resources[variant] &&
      state.reference.ready
    );
  const options: {
    label: string;
    backend: AdvancedVoiceBackend;
    variant: AdvancedVoiceVariant;
    available: boolean;
  }[] = [
    {
      label: 'Voix Apple',
      backend: 'apple',
      variant: state?.selectedVariant || 'redux',
      available: true,
    },
    {
      label: 'FluidAudio · Parakeet Redux',
      backend: 'fluid',
      variant: 'redux',
      available: available('redux'),
    },
    {
      label: 'FluidAudio · Parakeet Ultra',
      backend: 'fluid',
      variant: 'ultra',
      available: available('ultra'),
    },
  ];
  const operationLabel = {
    pack: 'Importation et vérification du pack en cours…',
    backend: 'Enregistrement du moteur vocal…',
    reference: 'Importation de la voix et de son consentement…',
    'remove-reference': 'Suppression de la référence vocale…',
  };

  return (
    <View style={styles.panel}>
      <Text
        ref={heading}
        role="heading"
        {...(Platform.OS === 'web' ? { tabIndex: -1 as const } : {})}
        style={[styles.title, text]}
      >
        Voix locale avancée
      </Text>
      <Text style={[styles.body, muted]}>
        Prépare les modèles sur ordinateur, puis importe-les depuis Fichiers. La
        reconnaissance et la synthèse s’exécutent sur l’iPhone. Le micro reste
        fermé ici.
      </Text>
      <ActionButton
        label="Retour aux réglages"
        disabled={voice.busy}
        onPress={onClose}
      />
      {!!voice.error && (
        <Text role="alert" style={[styles.body, { color: colors.danger }]}>
          {voice.error}
        </Text>
      )}
      {(voice.loading || voice.busy) && (
        <View style={styles.activity}>
          <ActivityIndicator accessibilityLabel="Préparation de la voix locale" />
          <Text role="status" style={[styles.body, muted]}>
            {voice.operation
              ? operationLabel[voice.operation]
              : 'Vérification des ressources locales…'}
          </Text>
        </View>
      )}
      {voice.supported && (
        <>
          <ActionButton
            label="Actualiser les ressources"
            disabled={disabled}
            onPress={voice.refresh}
          />
          {state && (
            <>
              <SurfaceGroup title="Moteur vocal">
                <Text style={[styles.body, text]}>
                  Configuration :{' '}
                  {state.effectiveBackend === 'fluid'
                    ? 'FluidAudio'
                    : 'Voix Apple'}
                  .
                </Text>
                {state.effectiveBackend === 'fluid' && (
                  <Text style={[styles.body, muted]}>
                    Les modèles FluidAudio sont chargés à l’ouverture du mode
                    vocal.
                  </Text>
                )}
                {!!state.reason && (
                  <Text style={[styles.body, muted]}>{state.reason}</Text>
                )}
                <View
                  role="radiogroup"
                  accessibilityLabel="Moteur vocal"
                  style={styles.choices}
                >
                  {options.map(option => {
                    const selected =
                      state.selectedBackend === option.backend &&
                      (option.backend === 'apple' ||
                        state.selectedVariant === option.variant);
                    const unavailable = disabled || !option.available;
                    return (
                      <Pressable
                        key={option.label}
                        role="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{
                          checked: selected,
                          disabled: unavailable,
                        }}
                        disabled={unavailable}
                        onPress={() =>
                          voice.setBackend(option.backend, option.variant)
                        }
                        style={({ pressed }) => [
                          styles.choice,
                          {
                            borderColor: selected
                              ? colors.accent
                              : colors.border,
                            backgroundColor: selected
                              ? colors.activeSurface
                              : colors.surface,
                          },
                          unavailable && styles.disabled,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.body, text]}>
                          {selected ? '● ' : '○ '}
                          {option.label}
                        </Text>
                        {!option.available && (
                          <Text style={[styles.caption, muted]}>
                            Modèles et référence autorisée requis.
                          </Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </SurfaceGroup>
              <SurfaceGroup title="Modèles sur cet iPhone">
                <View style={styles.section}>
                  {(
                    [
                      ['pocket', 'PocketTTS français · 24 couches'],
                      ['redux', 'Parakeet Redux'],
                      ['ultra', 'Parakeet Ultra'],
                      ['silero', 'Silero'],
                    ] as const
                  ).map(([key, label]) => (
                    <Text key={key} style={[styles.body, text]}>
                      {label} : {state.resources[key] ? 'prêt' : 'absent'}.
                    </Text>
                  ))}
                  <ActionButton
                    label="Importer un pack de modèles"
                    primary
                    disabled={disabled}
                    onPress={voice.importPack}
                  />
                  <Disclosure title="Préparer le pack" disabled={voice.busy}>
                    <Text style={[styles.body, muted]}>
                      Prévois environ 1,25 Go avec Redux, 1,66 Go avec Ultra, ou
                      1,88 Go pour les deux, ainsi que l’espace nécessaire à la
                      copie locale. Utilise le pack préparé sur ordinateur, avec
                      son manifeste de vérification, PocketTTS, Silero et
                      Parakeet Redux ou Ultra. Transfère le dossier complet sur
                      l’iPhone, puis sélectionne-le dans Fichiers. Assist copie
                      et vérifie les modèles avant de les utiliser.
                    </Text>
                  </Disclosure>
                </View>
              </SurfaceGroup>
              <SurfaceGroup title="Ta référence vocale">
                <View style={styles.section}>
                  <Text style={[styles.body, text]}>
                    {state.reference.ready
                      ? `Référence prête${
                          state.reference.speakerName
                            ? ` · ${state.reference.speakerName}`
                            : ''
                        }.`
                      : 'Aucune référence importée. Les voix Apple restent disponibles.'}
                  </Text>
                  <Text style={[styles.body, muted]}>
                    Pour reproduire une voix, importe un fichier WAV de 3 à 30
                    secondes de la personne autorisée, puis son document de
                    consentement PDF, texte ou JSON (5 Mo maximum). Ces fichiers
                    sont conservés localement pour le clonage et la reproduction
                    de sa voix dans Assist.
                  </Text>
                  <TextInput
                    aria-label="Nom de la personne autorisée"
                    value={speakerName}
                    onChangeText={value => {
                      setSpeakerName(value);
                      setConsent(false);
                    }}
                    maxLength={120}
                    editable={!disabled}
                    autoCorrect={false}
                    autoCapitalize="words"
                    placeholder="Nom de la personne autorisée"
                    placeholderTextColor={colors.placeholder}
                    style={[
                      styles.input,
                      text,
                      {
                        borderColor: colors.border,
                        backgroundColor: colors.surfaceRaised,
                      },
                    ]}
                  />
                  <Pressable
                    role="checkbox"
                    accessibilityLabel="Je confirme l’autorisation de cloner et reproduire cette voix localement"
                    accessibilityState={{ checked: consent, disabled }}
                    disabled={disabled}
                    onPress={() => setConsent(value => !value)}
                    style={({ pressed }) => [
                      styles.choice,
                      { borderColor: colors.border },
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.body, text]}>
                      {consent ? '☑ ' : '☐ '}Je confirme l’autorisation de
                      cloner et reproduire cette voix localement.
                    </Text>
                  </Pressable>
                  <ActionButton
                    label={
                      state.reference.ready
                        ? 'Remplacer la référence et son consentement'
                        : 'Importer la référence et son consentement'
                    }
                    disabled={disabled || !consent || !speakerName.trim()}
                    onPress={() => voice.importReference(speakerName, consent)}
                  />
                  {state.reference.ready && (
                    <ActionButton
                      label="Supprimer la référence et son consentement"
                      destructive
                      disabled={disabled}
                      onPress={voice.removeReference}
                    />
                  )}
                </View>
              </SurfaceGroup>
            </>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 20 },
  title: uiGrammar.type.title,
  body: uiGrammar.type.body,
  caption: uiGrammar.type.caption,
  section: { gap: 14 },
  choices: { gap: 10, paddingTop: 12 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  choice: {
    minHeight: 48,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderRadius: 12,
  },
  input: {
    ...uiGrammar.type.body,
    minHeight: 48,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});
