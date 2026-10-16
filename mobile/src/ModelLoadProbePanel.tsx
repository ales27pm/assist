import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
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
};

export function ModelLoadProbePanel({
  selected,
  busy,
  modelLoaded,
  perform,
}: Props) {
  const [functionIndex, setFunctionIndex] = useState(0);
  const [report, setReport] = useState<LoadProbeReport | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const version = useRef(0);
  const available =
    typeof NativeAssist?.runModelLoadProbe === 'function' &&
    typeof NativeAssist?.getLastModelLoadProbe === 'function';
  const disabled = busy || modelLoaded || !selected || !available;

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
      <Text style={styles.title}>Diagnostic de chargement</Text>
      <Text style={styles.text}>
        Sélectionne le dossier déjà téléchargé, sans charger le modèle. Ce test
        demande une seule fonction du modèle 32K, sans générer de réponse. Garde
        l’app au premier plan. Le dernier appel est enregistré avant le
        chargement et peut être partagé après réouverture si l’app se ferme.
      </Text>
      <Text selectable style={styles.text}>
        {loadProbeFunctions[functionIndex]}
      </Text>
      <Pressable
        role="button"
        aria-label="Fonction suivante"
        disabled={busy || !available}
        style={[styles.button, (busy || !available) && styles.disabled]}
        onPress={() =>
          setFunctionIndex(index => (index + 1) % loadProbeFunctions.length)
        }
      >
        <Text style={styles.buttonText}>Fonction suivante</Text>
      </Pressable>
      <Pressable
        role="button"
        aria-label="Tester ce graphe"
        disabled={disabled}
        style={[styles.button, disabled && styles.disabled]}
        onPress={run}
      >
        <Text style={styles.buttonText}>Tester ce graphe</Text>
      </Pressable>
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
          <Pressable
            role="button"
            aria-label="Partager le diagnostic de chargement"
            disabled={busy}
            style={[styles.button, busy && styles.disabled]}
            onPress={share}
          >
            <Text style={styles.buttonText}>
              Partager le diagnostic de chargement
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
