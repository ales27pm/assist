import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { ModelAssetProbePanel } from './ModelAssetProbePanel';
import { ModelLoadProbePanel } from './ModelLoadProbePanel';
import { MonitoringPanel } from './MonitoringPanel';
import { SpecializationRepairPanel } from './SpecializationRepairPanel';
import { ActionButton, Disclosure, ScreenHeading } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';

type DiagnosticsWorkspaceProps = {
  headingRef?: React.Ref<React.ComponentRef<typeof Text>>;
  selected: boolean;
  selectionVersion: number;
  busy: boolean;
  ready: boolean;
  active: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
  onModel: () => void;
  children: React.ReactNode;
};

export function DiagnosticsWorkspace({
  headingRef,
  selected,
  selectionVersion,
  busy,
  ready,
  active,
  perform,
  onModel,
  children,
}: DiagnosticsWorkspaceProps) {
  const { theme } = useAppearance();
  return (
    <View style={styles.workspace}>
      <ScreenHeading
        headingRef={headingRef}
        eyebrow="DIAGNOSTICS"
        title="Comprendre le moteur"
        description="Ces résultats décrivent le fonctionnement technique du moteur. Ils ne mesurent pas la qualité des réponses et ne prouvent pas l’utilisation de l’ANE."
      />
      {busy && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.busyHint, { color: theme.colors.muted }]}
        >
          Contrôle en cours. Les résultats apparaîtront ici.
        </Text>
      )}
      <ActionButton label="Gérer le modèle" onPress={onModel} disabled={busy} />
      <Disclosure
        title="Suivi en direct"
        description="État, mémoire et événements de cette session."
        initiallyOpen
      >
        {active && <MonitoringPanel />}
      </Disclosure>
      <Disclosure
        title="Vérifier les fichiers"
        description="Comparer le dossier sélectionné à la référence F16."
        disabled={busy}
        keepMounted
      >
        <ModelAssetProbePanel
          selected={selected}
          selectionVersion={selectionVersion}
          busy={busy}
          modelLoaded={ready}
          perform={perform}
        />
      </Disclosure>
      <Disclosure
        title="Vérifier le chargement"
        description="Charger une fonction sans générer de réponse."
        disabled={busy}
        keepMounted
      >
        <ModelLoadProbePanel
          selected={selected}
          busy={busy}
          modelLoaded={ready}
          perform={perform}
        />
      </Disclosure>
      <Disclosure
        title="Réparer la spécialisation"
        description="Reconstruire la préparation native puis relancer son contrôle."
        disabled={busy}
        keepMounted
      >
        <SpecializationRepairPanel
          selected={selected}
          busy={busy}
          modelLoaded={ready}
          perform={perform}
        />
      </Disclosure>
      <Disclosure
        title="Calcul natif"
        description="Consulter les contrôles et leurs rapports détaillés."
        disabled={busy}
        keepMounted
      >
        {children}
      </Disclosure>
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { gap: 16 },
  busyHint: uiGrammar.type.label,
});
