import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { ModelAssetProbePanel } from './ModelAssetProbePanel';
import { ModelLoadProbePanel } from './ModelLoadProbePanel';
import { MonitoringPanel } from './MonitoringPanel';
import { AdvancedDiagnosticsPanel } from './AdvancedDiagnosticsPanel';
import { SpecializationRepairPanel } from './SpecializationRepairPanel';
import { Disclosure, ScreenHeading } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';

type DiagnosticsWorkspaceProps = {
  headingRef?: React.Ref<React.ComponentRef<typeof Text>>;
  selected: boolean;
  selectionVersion: number;
  busy: boolean;
  ready: boolean;
  active: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
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
  children,
}: DiagnosticsWorkspaceProps) {
  const { theme } = useAppearance();
  return (
    <View style={styles.workspace}>
      <ScreenHeading
        headingRef={headingRef}
        title="Diagnostics"
        description="Suivre le moteur et vérifier son fonctionnement."
      />
      {busy && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.busyHint, { color: theme.colors.muted }]}
        >
          Contrôle en cours. Les résultats apparaîtront ici.
        </Text>
      )}
      <View style={styles.sections}>
        <Disclosure
          title="Suivi en direct"
          description="État, mémoire et événements de cette session."
          initiallyOpen
          plain
        >
          {active && <MonitoringPanel />}
        </Disclosure>
        <Disclosure
          title="Diagnostic avancé"
          description="Configurer le journal local, analyser ses constats et le partager."
          plain
        >
          {active && <AdvancedDiagnosticsPanel />}
        </Disclosure>
        <Disclosure
          title="Vérifier les fichiers"
          description="Comparer le dossier sélectionné à la référence F16."
          disabled={busy}
          keepMounted
          plain
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
          plain
        >
          <ModelLoadProbePanel
            selected={selected}
            busy={busy}
            modelLoaded={ready}
            perform={perform}
            showHeading={false}
          />
        </Disclosure>
        <Disclosure
          title="Réparer la spécialisation"
          description="Reconstruire la préparation native puis relancer son contrôle."
          disabled={busy}
          keepMounted
          plain
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
          plain
        >
          {children}
        </Disclosure>
      </View>
      <Text style={[styles.qualification, { color: theme.colors.muted }]}>
        Ces contrôles ne mesurent pas la qualité des réponses et ne prouvent pas
        l’utilisation de l’ANE.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  workspace: { gap: uiGrammar.harmony.space.section },
  sections: { gap: 0 },
  busyHint: uiGrammar.type.label,
  qualification: uiGrammar.type.caption,
});
