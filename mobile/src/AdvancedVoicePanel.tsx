import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
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
export function AdvancedVoicePanel({ onClose, onConfigurationChange }: {
  onClose: () => void;
  onConfigurationChange?: () => void;
}) {
  const { theme } = useAppearance();
  const { colors } = theme;
  const voice = useAdvancedVoice(onConfigurationChange);
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
      state.resources[variant]
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
    restore: 'Restauration du pack précédent…',
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
                            Modèles requis.
                          </Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </SurfaceGroup>
              <SurfaceGroup title="Voix PocketTTS">
                <Text style={[styles.body, text]}>
                  Voix française : Estelle.
                </Text>
                <Text style={[styles.body, muted]}>
                  Cette voix est incluse dans le pack de modèles.
                </Text>
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
                      {label} : {state.resources[key] ? 'importé' : 'absent'}.
                    </Text>
                  ))}
                  {!!state.packVersion && (
                    <Text style={[styles.caption, muted]}>
                      Version du pack : {state.packVersion}.
                    </Text>
                  )}
                  {!!state.previousPackAvailable &&
                    voice.canRestorePreviousPack && (
                      <Pressable
                        role="button"
                        accessibilityLabel="Restaurer le pack précédent"
                        accessibilityState={{ disabled }}
                        disabled={disabled}
                        onPress={voice.restorePreviousPack}
                        style={({ pressed }) => [
                          styles.restore,
                          { borderColor: colors.border },
                          disabled && styles.disabled,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.restoreText, text]}>
                          Restaurer le pack précédent
                        </Text>
                      </Pressable>
                    )}
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
  restore: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  restoreText: { ...uiGrammar.type.caption, fontWeight: '600' },
  choices: { gap: 10, paddingTop: 12 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  choice: {
    minHeight: 48,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderRadius: 12,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});
