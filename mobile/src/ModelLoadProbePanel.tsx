import React, { useEffect, useRef, useState } from 'react';
import {
  KeyDownEvent,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { AssistTheme, useAppearance } from './appearance';
import { uiGrammar } from './uiGrammar';
import { ActionButton } from './uiPrimitives';
import {
  LoadProbeReport,
  loadProbeFunctions,
  parseLoadProbeReport,
} from './loadProbe';

type Props = {
  selected: boolean;
  busy: boolean;
  modelLoaded: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
  showHeading?: boolean;
};

export function ModelLoadProbePanel({
  selected,
  busy,
  modelLoaded,
  perform,
  showHeading = true,
}: Props) {
  const { theme } = useAppearance();
  const styles = createStyles(theme);
  const [functionIndex, setFunctionIndex] = useState(0);
  const [focusedFunctionIndex, setFocusedFunctionIndex] = useState<
    number | null
  >(null);
  const functionRefs = useRef<
    Array<React.ComponentRef<typeof Pressable> | null>
  >([]);
  const [report, setReport] = useState<LoadProbeReport | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const version = useRef(0);
  const available =
    typeof NativeAssist?.runModelLoadProbe === 'function' &&
    typeof NativeAssist?.getLastModelLoadProbe === 'function';
  const disabled = busy || modelLoaded || !selected || !available;
  const selectionDisabled = busy || !available;

  function handleFunctionKeyDown(event: KeyDownEvent, index: number) {
    const { key, altKey, ctrlKey, metaKey, shiftKey, isComposing } =
      event.nativeEvent;
    if (
      selectionDisabled ||
      altKey ||
      ctrlKey ||
      metaKey ||
      shiftKey ||
      isComposing
    ) {
      return;
    }
    let nextIndex: number;
    switch (key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex =
          (index - 1 + loadProbeFunctions.length) % loadProbeFunctions.length;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (index + 1) % loadProbeFunctions.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = loadProbeFunctions.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setFunctionIndex(nextIndex);
    functionRefs.current[nextIndex]?.focus();
  }

  useEffect(() => {
    alive.current = true;
    const requestedVersion = version.current;
    if (available) {
      NativeAssist!
        .getLastModelLoadProbe()
        .then(json => {
          if (alive.current && version.current === requestedVersion) {
            setReport(parseLoadProbeReport(json));
          }
        })
        .catch(() => {
          if (alive.current && version.current === requestedVersion) {
            setError('Le diagnostic enregistré est indisponible.');
          }
        });
    }
    return () => {
      alive.current = false;
    };
  }, [available]);

  async function run() {
    if (disabled) {
      return;
    }
    await perform(async () => {
      version.current += 1;
      setError('');
      try {
        const json = await NativeAssist!.runModelLoadProbe(
          loadProbeFunctions[functionIndex],
        );
        if (alive.current) {
          setReport(parseLoadProbeReport(json));
        }
      } finally {
        try {
          const json = await NativeAssist!.getLastModelLoadProbe();
          if (alive.current) {
            setReport(parseLoadProbeReport(json));
          }
        } catch {
          if (alive.current) {
            setError('Le diagnostic enregistré est indisponible.');
          }
        }
      }
    });
  }

  async function share() {
    if (!report) {
      return;
    }
    try {
      await Share.share({ message: JSON.stringify(report, null, 2) });
    } catch {
      if (alive.current) {
        setError('Le partage du diagnostic a échoué.');
      }
    }
  }

  return (
    <View style={styles.panel}>
      {showHeading && (
        <Text accessibilityRole="header" style={styles.title}>
          Diagnostic de chargement
        </Text>
      )}
      <Text style={styles.text}>
        Teste une fonction du modèle 32K, sans générer de réponse. Garde l’app
        au premier plan. Le dernier essai reste disponible après réouverture.
      </Text>
      <Text style={styles.groupLabel}>Fonction à tester</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Fonction à tester"
        style={styles.functions}
      >
        {loadProbeFunctions.map((functionName, index) => {
          const checked = functionIndex === index;
          return (
            <Pressable
              key={functionName}
              ref={node => {
                functionRefs.current[index] = node;
              }}
              accessibilityRole="radio"
              accessibilityLabel={functionName}
              accessibilityHint="Sélectionner cette fonction sans lancer de test."
              accessibilityState={{ checked, disabled: selectionDisabled }}
              aria-checked={checked}
              tabIndex={
                Platform.OS === 'web'
                  ? checked && !selectionDisabled
                    ? 0
                    : -1
                  : undefined
              }
              disabled={selectionDisabled}
              style={({ pressed }) => [
                styles.function,
                checked && styles.selectedFunction,
                focusedFunctionIndex === index && styles.focusedFunction,
                selectionDisabled && styles.disabled,
                pressed && styles.pressed,
              ]}
              onPress={() => setFunctionIndex(index)}
              onKeyDown={
                Platform.OS === 'web'
                  ? event => handleFunctionKeyDown(event, index)
                  : undefined
              }
              onFocus={() => setFocusedFunctionIndex(index)}
              onBlur={() => setFocusedFunctionIndex(null)}
            >
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.radio, checked && styles.checkedRadio]}
              >
                {checked && <View style={styles.radioDot} />}
              </View>
              <Text style={styles.functionName}>{functionName}</Text>
            </Pressable>
          );
        })}
      </View>
      <ActionButton
        label="Tester ce graphe"
        primary
        disabled={disabled}
        onPress={run}
      />
      {!available && (
        <Text style={styles.text}>Disponible dans une nouvelle build iOS.</Text>
      )}
      {report && (
        <>
          <Text selectable style={styles.text}>
            Dernier diagnostic : {report.functionName}
          </Text>
          <Text selectable style={styles.text}>
            Modèle : {report.modelName}
            {report.attempt ? `\nEssai du ${report.attempt.startedAtUTC}` : ''}
          </Text>
          <Text style={styles.text}>
            {report.stage === 'completed'
              ? 'Ce graphe a été chargé. La génération et le chargement cumulé restent à vérifier.'
              : report.stage === 'failed'
              ? 'Le diagnostic a retourné une erreur.'
              : `Dernière étape enregistrée : ${report.stage}. Cette trace seule ne détermine pas la cause d’une interruption.`}
          </Text>
          {report.nativeErrors && (
            <Text selectable style={styles.text}>
              {report.nativeErrors
                .map(
                  item =>
                    `${item.domain} (${item.code ?? 'code indisponible'})`,
                )
                .join(' → ')}
            </Text>
          )}
          {report.preparedLibrary && (
            <Text selectable style={styles.text}>
              Fonctions reconnues : {report.preparedLibrary.functionCount}
              {'\n'}Liste conforme à la source :{' '}
              {report.preparedLibrary.matchesSourceSummary ? 'oui' : 'non'}
              {'\n'}Descripteur de la fonction choisie :{' '}
              {report.preparedLibrary.selectedDescriptorPresent
                ? 'présent'
                : 'absent'}
            </Text>
          )}
          <Text style={styles.text}>
            Partage ce rapport avant un autre essai.
          </Text>
          <ActionButton
            label="Partager le diagnostic de chargement"
            disabled={busy}
            onPress={share}
          />
        </>
      )}
      {!!error && (
        <Text role="alert" style={styles.text}>
          {error}
        </Text>
      )}
    </View>
  );
}

const createStyles = (theme: AssistTheme) =>
  StyleSheet.create({
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    panel: {
      gap: uiGrammar.harmony.space.medium,
    },
    title: {
      ...uiGrammar.type.body,
      color: theme.colors.text,
      fontWeight: '600',
    },
    text: { ...uiGrammar.type.label, color: theme.colors.muted },
    groupLabel: {
      ...uiGrammar.type.label,
      color: theme.colors.text,
      fontWeight: '600',
    },
    functions: { gap: uiGrammar.harmony.space.small },
    function: {
      minHeight: uiGrammar.touchTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: uiGrammar.harmony.space.medium,
      borderRadius: uiGrammar.radius.control,
      borderWidth: 1,
      borderColor: 'transparent',
      paddingVertical: uiGrammar.harmony.space.medium,
      paddingHorizontal: uiGrammar.harmony.space.medium,
    },
    selectedFunction: { backgroundColor: theme.colors.surfaceRaised },
    focusedFunction: { borderColor: theme.colors.accent },
    functionName: {
      ...uiGrammar.type.label,
      color: theme.colors.text,
      flexShrink: 1,
    },
    radio: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkedRadio: { borderColor: theme.colors.accent },
    radioDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: theme.colors.accent,
    },
  });
