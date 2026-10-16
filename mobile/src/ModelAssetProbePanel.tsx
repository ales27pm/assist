import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import {
  AssetProbeErrorCode,
  ModelAssetProbeReport,
  parseAssetProbeReport,
} from './assetProbe';

type Props = {
  selected: boolean;
  selectionVersion?: number;
  busy: boolean;
  modelLoaded: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
};
const failureMessages: Record<AssetProbeErrorCode, string> = {
  E_ASSET_IDENTITY_LOCAL_ONLY:
    'Le dossier doit être entièrement local et lisible.',
  E_ASSET_IDENTITY_IO: 'Un fichier n’a pas pu être lu.',
  E_ASSET_IDENTITY_CHANGED: 'Un fichier a changé pendant la vérification.',
  E_ASSET_IDENTITY_MISMATCH:
    'Au moins un fichier ne correspond pas à la référence F16.',
};

export function ModelAssetProbePanel({
  selected,
  selectionVersion = 0,
  busy,
  modelLoaded,
  perform,
}: Props) {
  const [report, setReport] = useState<ModelAssetProbeReport | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const version = useRef(0);
  const selection = useRef({ selected, selectionVersion });
  const available =
    typeof NativeAssist?.runModelAssetProbe === 'function' &&
    typeof NativeAssist?.getLastModelAssetProbe === 'function';
  const disabled = busy || modelLoaded || !selected || !available;

  useEffect(() => {
    alive.current = true;
    let current = true;
    const requestedVersion = version.current;
    if (available) {
      NativeAssist!
        .getLastModelAssetProbe()
        .then(json => {
          if (
            current &&
            alive.current &&
            version.current === requestedVersion
          ) {
            setReport(parseAssetProbeReport(json));
          }
        })
        .catch(() => {
          if (
            current &&
            alive.current &&
            version.current === requestedVersion
          ) {
            setError('Le rapport d’identité enregistré est indisponible.');
          }
        });
    }
    return () => {
      current = false;
      alive.current = false;
    };
  }, [available]);

  useEffect(() => {
    if (
      selection.current.selected !== selected ||
      selection.current.selectionVersion !== selectionVersion
    ) {
      selection.current = { selected, selectionVersion };
      // Saved reports do not identify the selected folder. A new selection
      // invalidates both visible evidence and pending restores/manual results.
      version.current += 1;
      setReport(null);
      setError('');
    }
  }, [selected, selectionVersion]);

  async function run() {
    if (disabled) {
      return;
    }
    await perform(async () => {
      const requestedVersion = ++version.current;
      setError('');
      try {
        const parsed = parseAssetProbeReport(
          await NativeAssist!.runModelAssetProbe(),
        );
        if (!parsed) {
          throw new Error('Rapport absent.');
        }
        if (alive.current && version.current === requestedVersion) {
          setReport(parsed);
        }
      } catch {
        if (alive.current && version.current === requestedVersion) {
          setError('La vérification n’a pas retourné de rapport exploitable.');
        }
      } finally {
        try {
          const saved = parseAssetProbeReport(
            await NativeAssist!.getLastModelAssetProbe(),
          );
          if (alive.current && version.current === requestedVersion && saved) {
            setReport(saved);
          }
        } catch {
          if (alive.current && version.current === requestedVersion) {
            setError('Le rapport d’identité enregistré est indisponible.');
          }
        }
      }
    });
  }

  async function share() {
    if (!report || busy) {
      return;
    }
    try {
      await Share.share({ message: JSON.stringify(report, null, 2) });
    } catch {
      if (alive.current) {
        setError('Le partage du rapport d’identité a échoué.');
      }
    }
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Identité de l’asset F16</Text>
      <Text style={styles.text}>
        Vérifie que quatre fichiers du dossier sélectionné correspondent à la
        référence F16. Cette lecture inclut un fichier d’environ 1,38 Go et peut
        prendre du temps. Garde Assist au premier plan.
      </Text>
      <Text style={styles.text}>
        Le modèle n’est pas chargé par cette vérification. Les embeddings par
        couche et le tokenizer ne sont pas vérifiés. La durée de lecture et le
        pic mémoire ne sont pas mesurés.
      </Text>
      <Pressable
        role="button"
        aria-label="Vérifier l’asset F16"
        disabled={disabled}
        style={[styles.button, disabled && styles.disabled]}
        onPress={run}
      >
        <Text style={styles.buttonText}>Vérifier l’asset F16</Text>
      </Pressable>
      {!available && (
        <Text style={styles.text}>Disponible dans une nouvelle build iOS.</Text>
      )}
      {report && (
        <>
          <Text selectable style={styles.text}>
            Référence : {report.expectedModelName}
            {'\n'}Essai du {report.attempt.startedAtUTC}
          </Text>
          <Text style={styles.text}>
            {report.stage === 'completed'
              ? 'Les quatre fichiers correspondent à la référence F16. Le chargement du modèle reste à vérifier.'
              : report.stage === 'failed'
              ? 'La vérification n’a pas confirmé l’identité de l’asset.'
              : 'Dernière étape enregistrée : vérification des fichiers. Cette trace seule ne détermine pas la cause d’une interruption.'}
          </Text>
          <Text style={styles.text}>
            Fichiers conformes dans ce rapport :{' '}
            {report.files.filter(file => file.matchesExpected === true).length}
            /4.
          </Text>
          {report.errorCode && (
            <Text selectable style={styles.text}>
              {failureMessages[report.errorCode]}
              {'\n'}Code : {report.errorCode}
            </Text>
          )}
          {report.posixErrno !== undefined && (
            <Text selectable style={styles.text}>
              Erreur système enregistrée : errno {report.posixErrno}.
            </Text>
          )}
          <Text style={styles.text}>
            Partage ce rapport avant une autre vérification.
          </Text>
          <Pressable
            role="button"
            aria-label="Partager le rapport d’identité F16"
            disabled={busy}
            style={[styles.button, busy && styles.disabled]}
            onPress={share}
          >
            <Text style={styles.buttonText}>
              Partager le rapport d’identité F16
            </Text>
          </Pressable>
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

const styles = StyleSheet.create({
  disabled: { opacity: 0.4 },
  panel: {
    backgroundColor: '#142329',
    borderColor: '#34494c',
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 12,
  },
  title: { color: '#e3efea', fontSize: 22, fontWeight: '600' },
  text: { color: '#a7b8b6', fontSize: 15, lineHeight: 22 },
  button: {
    backgroundColor: '#b1d8c8',
    borderRadius: 9,
    padding: 14,
    minHeight: 48,
  },
  buttonText: {
    color: '#132925',
    fontSize: 16,
    textAlign: 'center',
    fontWeight: '600',
  },
});
