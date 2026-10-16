import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { InterfaceIcon } from './InterfaceIcon';
import type { EngineState } from './protocol';
import {
  ActionButton,
  Disclosure,
  ScreenHeading,
  SettingsRow,
} from './uiPrimitives';
import { uiGrammar } from './uiGrammar';

type ModelWorkspaceProps = {
  engine: EngineState;
  ready: boolean;
  busy: boolean;
  selected: boolean;
  nativeAvailable: boolean;
  translatedPhase: string;
  canShareReport: boolean;
  onLoadBundled: () => unknown;
  onSelectExport: () => unknown;
  onLoadSelected: () => unknown;
  onUnload: () => unknown;
  onConversation: () => unknown;
  onDiagnostics: () => unknown;
  onShareReport: () => unknown;
};

/** Presents native state and forwards actions; model lifecycle stays in App. */
export function ModelWorkspace({
  engine,
  ready,
  busy,
  selected,
  nativeAvailable,
  translatedPhase,
  canShareReport,
  onLoadBundled,
  onSelectExport,
  onLoadSelected,
  onUnload,
  onConversation,
  onDiagnostics,
  onShareReport,
}: ModelWorkspaceProps) {
  const { theme } = useAppearance();
  const textColor = { color: theme.colors.text };
  const mutedColor = { color: theme.colors.muted };

  return (
    <View style={styles.workspace}>
      <ScreenHeading title="Modèle" />
      <ScreenHeading
        eyebrow="SUR CET APPAREIL"
        title="Préparer l’assistant"
        description="Charge un modèle sur ton appareil pour démarrer une conversation."
      />

      <View style={styles.modelContent}>
        <View style={styles.identity}>
          <View style={styles.emblem}>
            <InterfaceIcon name="model" size={24} color={theme.colors.text} />
          </View>
          <View style={styles.identityCopy}>
            <Text style={[styles.modelName, textColor]}>
              {engine.modelName || 'Gemma 4 E2B'}
            </Text>
            <Text style={[styles.caption, mutedColor]}>
              Moteur local · Core AI · prototype
            </Text>
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.label, mutedColor]}
            >
              État : {nativeAvailable ? translatedPhase : 'Indisponible ici'}
            </Text>
          </View>
        </View>

        {(engine.contextCapacity > 0 ||
          busy ||
          engine.loadElapsedMs != null) && (
          <View style={styles.state}>
            {engine.contextCapacity > 0 && (
              <Text style={[styles.caption, mutedColor]}>
                Contexte détecté : {engine.contextCapacity} jetons
              </Text>
            )}
            {busy && (
              <Text style={[styles.caption, mutedColor]}>
                Opération native en cours…
              </Text>
            )}
            {engine.loadElapsedMs != null && (
              <Text style={[styles.caption, mutedColor]}>
                Dernier chargement : {(engine.loadElapsedMs / 1000).toFixed(2)}
                {' s. '}Le pic réel de chargement n’est pas mesuré.
              </Text>
            )}
          </View>
        )}

        {ready && (
          <View style={styles.actions}>
            <ActionButton
              label="Ouvrir la conversation"
              primary
              disabled={busy || !nativeAvailable}
              onPress={onConversation}
            />
            <ActionButton
              label="Décharger"
              destructive
              disabled={busy || !nativeAvailable}
              onPress={onUnload}
            />
          </View>
        )}
        <View style={styles.actions}>
          <ActionButton
            label="Charger Gemma intégré"
            primary={!ready}
            disabled={
              busy || ready || !engine.bundledModelAvailable || !nativeAvailable
            }
            onPress={onLoadBundled}
          />
          <Text style={[styles.caption, mutedColor]}>
            {engine.bundledModelAvailable === true
              ? 'Gemma intégré détecté. Chargement entièrement sur l’appareil.'
              : engine.bundledModelAvailable === false
              ? 'Gemma n’est pas intégré à cette build.'
              : 'Disponibilité du modèle intégré non confirmée.'}
          </Text>
        </View>

        {!nativeAvailable && (
          <View style={styles.platformNote}>
            <Text style={[styles.noteTitle, textColor]}>
              Moteur iOS indisponible ici
            </Text>
            <Text style={[styles.caption, mutedColor]}>
              Le chargement nécessite l’app iPhone. Ton brouillon reste
              disponible dans cet aperçu.
            </Text>
          </View>
        )}
      </View>

      <View style={styles.secondaryActions}>
        <Disclosure
          title="Importer un modèle"
          icon="import"
          description="Option avancée · un export local compatible"
          initiallyOpen={selected}
          disabled={busy}
          plain
        >
          <Text style={[styles.body, mutedColor]}>
            Dans Fichiers, place le dossier exporté complet dans Sur mon iPhone.
            Extrais le ZIP avant l’import : les emplacements iCloud sont
            refusés.
          </Text>
          <Text style={[styles.body, mutedColor]}>
            Sélectionne le dossier contenant metadata.json, l’asset .aimodel, le
            dossier tokenizer/ et le sidecar PLE. Le fichier .aimodel seul ne
            suffit pas.
          </Text>
          <Text style={[styles.caption, mutedColor]}>
            Un iPhone physique sous iOS 27.2 ou plus récent est requis. Garde
            l’app au premier plan pendant le premier chargement, qui peut être
            long.
          </Text>
          {selected && (
            <Text style={[styles.selection, textColor]}>
              Un dossier est sélectionné.
            </Text>
          )}
          <ActionButton
            label="Choisir un dossier exporté"
            disabled={busy || ready || !nativeAvailable}
            onPress={onSelectExport}
          />
          <ActionButton
            label="Charger le modèle"
            disabled={busy || ready || !selected || !nativeAvailable}
            onPress={onLoadSelected}
          />
        </Disclosure>
        <View
          style={[styles.diagnostics, { borderColor: theme.colors.separator }]}
        >
          <SettingsRow
            label="Afficher les diagnostics"
            icon="lab"
            disabled={busy}
            onPress={onDiagnostics}
            stacked
            last
          />
        </View>
      </View>

      <View
        style={[styles.sessionContent, { borderColor: theme.colors.separator }]}
      >
        <Text accessibilityRole="header" style={[styles.noteTitle, textColor]}>
          Session et vérification
        </Text>
        <Text style={[styles.body, mutedColor]}>
          L’historique reste en mémoire pendant cette session. La mémoire
          personnelle persistante et les outils ne sont pas encore disponibles.
        </Text>
        <ActionButton
          label="Partager le rapport"
          disabled={busy || !canShareReport || !nativeAvailable}
          onPress={onShareReport}
        />
        <Text style={[styles.caption, mutedColor]}>
          Le rapport peut contenir la réponse générée : vérifie son contenu
          avant de le partager.
        </Text>
      </View>

      <Text style={[styles.caption, mutedColor]}>
        Prototype à qualifier · exécution ANE non mesurée.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { gap: uiGrammar.harmony.space.large },
  platformNote: { gap: 4 },
  noteTitle: { ...uiGrammar.type.body, fontWeight: '600' },
  body: uiGrammar.type.body,
  caption: uiGrammar.type.caption,
  label: uiGrammar.type.label,
  modelContent: { paddingVertical: uiGrammar.harmony.space.medium, gap: 21 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 21 },
  emblem: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityCopy: { flex: 1, gap: 8 },
  modelName: { ...uiGrammar.type.body, fontWeight: '600' },
  state: { gap: 8 },
  actions: { gap: 13 },
  secondaryActions: { gap: 0 },
  diagnostics: { borderBottomWidth: 1 },
  selection: { ...uiGrammar.type.label, fontWeight: '600' },
  sessionContent: {
    borderTopWidth: 1,
    paddingTop: uiGrammar.harmony.space.large,
    marginTop: uiGrammar.harmony.space.medium,
    gap: uiGrammar.harmony.space.medium,
  },
});
