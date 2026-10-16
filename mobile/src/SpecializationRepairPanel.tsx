import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import {
  numericRepairCounts,
  parseSpecializationRepair,
  repairMatchesAction,
  RepairPrimitiveReport,
  RepairTarget,
  SpecializationRepairEvidence,
} from './specializationRepair';

type Props = {
  selected: boolean;
  busy: boolean;
  modelLoaded: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
};

export function SpecializationRepairPanel({
  selected,
  busy,
  modelLoaded,
  perform,
}: Props) {
  const [evidence, setEvidence] = useState<SpecializationRepairEvidence | null>(
    null,
  );
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const alive = useRef(true);
  const version = useRef(0);
  const inFlight = useRef(false);
  const available =
    typeof NativeAssist?.repairNumericalProbe === 'function' &&
    typeof NativeAssist?.repairModelLoadProbe === 'function' &&
    typeof NativeAssist?.getLastSpecializationRepair === 'function';
  const locked = busy || modelLoaded || running || !available;

  useEffect(() => {
    alive.current = true;
    let current = true;
    const requestedVersion = version.current;
    if (available) {
      NativeAssist!
        .getLastSpecializationRepair()
        .then(json => {
          if (
            current &&
            alive.current &&
            requestedVersion === version.current
          ) {
            setEvidence(parseSpecializationRepair(json));
          }
        })
        .catch(() => {
          if (
            current &&
            alive.current &&
            requestedVersion === version.current
          ) {
            setError('Le rapport de réparation enregistré est indisponible.');
          }
        });
    }
    return () => {
      current = false;
      alive.current = false;
    };
  }, [available]);

  async function run(target: RepairTarget) {
    if (
      locked ||
      inFlight.current ||
      (target === 'selected_f16_neural_engine' && !selected)
    ) {
      return;
    }
    inFlight.current = true;
    setRunning(true);
    const requestedVersion = ++version.current;
    setError('');
    setEvidence(null);
    const canUpdate = () =>
      alive.current && requestedVersion === version.current;
    try {
      await perform(async () => {
        let received = false;
        try {
          const json =
            target === 'bundled_f16_neural_engine'
              ? await NativeAssist!.repairNumericalProbe()
              : await NativeAssist!.repairModelLoadProbe('extend_1024_8');
          const parsed = parseSpecializationRepair(json);
          const repair =
            parsed?.kind === 'assistSpecializationRepairResult'
              ? parsed.repair
              : parsed;
          if (
            !parsed ||
            !repair ||
            !repairMatchesAction(target, repair.target)
          ) {
            throw new Error('Rapport absent.');
          }
          received = true;
          if (canUpdate()) {
            setEvidence(parsed);
          }
        } catch {
          if (canUpdate()) {
            setError('La réparation n’a pas retourné de rapport exploitable.');
          }
        } finally {
          // A successful wrapper contains the original qualification. A small persisted
          // marker must not replace it and silently discard its measured outputs.
          if (!received) {
            try {
              const saved = parseSpecializationRepair(
                await NativeAssist!.getLastSpecializationRepair(),
              );
              if (saved && canUpdate()) {
                setEvidence(saved);
                setError('');
              }
            } catch {
              if (canUpdate()) {
                setError(
                  'Le rapport de réparation enregistré est indisponible.',
                );
              }
            }
          }
        }
      });
    } catch {
      if (canUpdate()) {
        setError('La réparation n’a pas pu démarrer.');
      }
    } finally {
      inFlight.current = false;
      if (canUpdate()) {
        setRunning(false);
      }
    }
  }

  async function share() {
    if (!evidence || busy || running || inFlight.current) {
      return;
    }
    try {
      await Share.share({ message: JSON.stringify(evidence, null, 2) });
    } catch {
      if (alive.current) {
        setError('Le partage du rapport de réparation a échoué.');
      }
    }
  }

  const repair =
    evidence?.kind === 'assistSpecializationRepairResult'
      ? evidence.repair
      : evidence;
  const diagnostic =
    evidence?.kind === 'assistSpecializationRepairResult'
      ? evidence.diagnostic
      : null;
  const numeric =
    diagnostic?.kind === 'assistPrimitiveQualification'
      ? numericRepairCounts(diagnostic as RepairPrimitiveReport)
      : null;

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Réparation de la préparation native</Text>
      <Text style={styles.text}>
        Chaque bouton vérifie la source F16 puis retire uniquement sa
        préparation Neural Engine enregistrée. Le contrôle correspondant est
        ensuite relancé une fois. Les fichiers du modèle sont conservés. Garde
        Assist au premier plan.
      </Text>
      <Pressable
        role="button"
        aria-label="Réparer le calcul natif"
        disabled={locked}
        style={[styles.button, locked && styles.disabled]}
        onPress={() => run('bundled_f16_neural_engine')}
      >
        <Text style={styles.buttonText}>Réparer le calcul natif</Text>
      </Pressable>
      <Pressable
        role="button"
        aria-label="Réparer le chargement Gemma"
        disabled={locked || !selected}
        style={[styles.button, (locked || !selected) && styles.disabled]}
        onPress={() => run('selected_f16_neural_engine')}
      >
        <Text style={styles.buttonText}>Réparer le chargement Gemma</Text>
      </Pressable>
      <Text style={styles.text}>
        Pour Gemma, sélectionne le dossier F16 avant l’essai. Seule la fonction
        extend_1024_8 est chargée, sans génération. Le contexte reste à 32K.
      </Text>
      {!available && (
        <Text style={styles.text}>Disponible dans une nouvelle build iOS.</Text>
      )}
      {repair && (
        <>
          <Text selectable style={styles.text}>
            Modèle : {repair.modelName}
            {'\n'}Essai du {repair.attempt.startedAtUTC}
          </Text>
          <Text style={styles.text}>
            {repair.stage === 'failed'
              ? 'La réparation a retourné une erreur. Aucun nouvel essai automatique n’est lancé.'
              : repair.stage === 'completed'
              ? diagnostic
                ? 'La réparation et son contrôle ont rendu la main. Le résultat du contrôle est indiqué ci-dessous.'
                : 'Le dernier contrôle a rendu la main. Son résultat détaillé n’est pas conservé dans ce petit rapport.'
              : `Dernière étape enregistrée : ${repair.stage}. Cette trace seule ne détermine pas la cause d’une interruption.`}
          </Text>
          {repair.errorCode && (
            <Text selectable style={styles.text}>
              Code : {repair.errorCode}
            </Text>
          )}
          {repair.nativeErrors && (
            <Text selectable style={styles.text}>
              {repair.nativeErrors
                .map(
                  item =>
                    `${item.domain} (${item.code ?? 'code indisponible'})`,
                )
                .join(' → ')}
            </Text>
          )}
          {numeric && (
            <>
              <Text style={styles.text}>
                Sorties mesurées : {numeric.measured}/48. Erreurs natives :{' '}
                {numeric.nativeErrors}. Cas en écart numérique :{' '}
                {numeric.numericalDeviations}.
              </Text>
              <Text style={styles.text}>
                {numeric.allOutputsMeasured
                  ? 'Les 48 sorties natives ont été produites. Les écarts numériques restent indiqués séparément.'
                  : 'Le contrôle n’a pas produit toutes les sorties natives.'}
              </Text>
            </>
          )}
          {diagnostic?.kind === 'assistModelLoadDiagnostic' && (
            <Text style={styles.text}>
              {diagnostic.stage === 'completed'
                ? 'La fonction Gemma a été chargée. La génération reste à vérifier.'
                : 'Le chargement de la fonction Gemma a retourné une erreur.'}
            </Text>
          )}
          <Pressable
            role="button"
            aria-label="Partager le rapport de réparation"
            disabled={busy || running}
            style={[styles.button, (busy || running) && styles.disabled]}
            onPress={share}
          >
            <Text style={styles.buttonText}>
              Partager le rapport de réparation
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
