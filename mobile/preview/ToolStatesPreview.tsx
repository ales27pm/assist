import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppearanceProvider, themes, useAppearance } from '../src/appearance';
import type { AppearanceId } from '../src/appearance';
import type { CalendarAgentTrace } from '../src/protocol';
import type { CalendarToolTransaction } from '../src/toolActivity';
import { ToolCallCard } from '../src/ToolCallCard';
import { uiGrammar } from '../src/uiGrammar';

const scope = {
  startISO: '2026-10-18T04:00:00.000Z',
  endISO: '2026-10-19T04:00:00.000Z',
  timeZoneIdentifier: 'America/Toronto',
};
const receipt: CalendarAgentTrace = {
  schemaVersion: 1,
  tool: 'calendar.list',
  callId: 'synthetic-read',
  scope,
  returnedCount: 5,
  possiblyTruncated: true,
};
const fixtures = {
  proposed: {
    label: 'Préparation',
    transaction: { id: 'synthetic-proposed', status: 'proposed' },
  },
  executing: {
    label: 'Consultation en cours',
    transaction: { id: 'synthetic-executing', status: 'executing', scope },
  },
  observing: {
    label: 'Réponse en préparation · reçu présent',
    transaction: {
      id: 'synthetic-observing',
      status: 'observing',
      scope,
      receipt,
    },
  },
  success0: {
    label: 'Lecture confirmée · 0 événement',
    transaction: {
      id: 'synthetic-empty',
      status: 'success',
      scope,
      receipt: { ...receipt, returnedCount: 0, possiblyTruncated: false },
    },
  },
  success5: {
    label: 'Lecture confirmée · 5 événements',
    transaction: { id: 'synthetic-five', status: 'success', scope, receipt },
  },
  permission: {
    label: 'Autorisation requise',
    transaction: {
      id: 'synthetic-permission',
      status: 'failed_safe',
      scope,
      error: 'permission',
    },
  },
  cancelRequested: {
    label: 'Annulation demandée · attente',
    transaction: {
      id: 'synthetic-stopping',
      status: 'executing',
      scope,
      cancelRequested: true,
    },
  },
  cancelled: {
    label: 'Interruption · aucun reçu',
    transaction: {
      id: 'synthetic-cancelled',
      status: 'cancelled',
      scope,
      error: 'interrupted',
    },
  },
  cancelledReceipt: {
    label: 'Réponse interrompue · lecture confirmée',
    transaction: {
      id: 'synthetic-cancelled-receipt',
      status: 'cancelled',
      scope,
      receipt,
      error: 'interrupted',
    },
  },
  failedReceipt: {
    label: 'Réponse non finalisée · lecture confirmée',
    transaction: {
      id: 'synthetic-failed-receipt',
      status: 'failed_safe',
      scope,
      receipt,
      error: 'unconfirmed',
    },
  },
  noCall: {
    label: 'Le modèle n’a demandé aucune lecture',
    transaction: { id: 'synthetic-no-call', status: 'cancelled', scope },
  },
} satisfies Record<
  string,
  { label: string; transaction: CalendarToolTransaction }
>;
type FixtureId = keyof typeof fixtures;

// Native lineHeight is measured in points; CSS numbers are multipliers.
function webType(type: { fontSize: number; lineHeight: number }) {
  return { fontSize: type.fontSize, lineHeight: `${type.lineHeight}px` };
}

const htmlStyles = {
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minWidth: 0,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  header: { flexShrink: 0, padding: '16px 24px', borderBottom: '1px solid' },
  banner: { display: 'block', ...webType(uiGrammar.type.label) },
  main: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
  content: {
    maxWidth: 760,
    minWidth: 0,
    margin: '0 auto',
    padding: uiGrammar.gutter,
  },
  title: {
    ...webType(uiGrammar.type.title),
    fontWeight: 500,
    margin: '0 0 12px',
  },
  body: { ...webType(uiGrammar.type.body), margin: '0 0 21px' },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 13, marginBottom: 21 },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flex: '1 1 180px',
    minWidth: 0,
  },
  stateLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flex: '2 1 240px',
    minWidth: 0,
  },
  zoomLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flex: '1 1 160px',
    minWidth: 0,
  },
  caption: webType(uiGrammar.type.caption),
  thread: { minWidth: 0 },
  notice: webType(uiGrammar.type.label),
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: uiGrammar.touchTarget,
    marginTop: 21,
  },
} satisfies Record<string, React.CSSProperties>;

// The app's TS configuration intentionally has no DOM lib. This browser-only
// boundary still checks a select's value without changing global native types.
function controlValue(target: unknown): string {
  return target &&
    typeof target === 'object' &&
    'value' in target &&
    typeof target.value === 'string'
    ? target.value
    : '';
}

const answers: Partial<Record<FixtureId, string>> = {
  success0:
    'Exemple fictif : aucun événement retourné pour cette période. Cela ne qualifie pas un calendrier iOS réel.',
  success5:
    'Exemple fictif : cinq événements retournés. La liste peut être incomplète ; aucun contenu privé n’est utilisé ici.',
  cancelledReceipt:
    'Exemple fictif : la lecture est confirmée, mais la réponse a été interrompue.',
  failedReceipt:
    'Exemple fictif : la lecture est confirmée, mais la réponse n’a pas pu être finalisée.',
  noCall:
    'Exemple fictif : le modèle a répondu sans demander de lecture du calendrier.',
};

function PreviewContent() {
  const { theme, appearance, setAppearance } = useAppearance();
  const { colors } = theme;
  const [selected, setSelected] = useState<FixtureId>('proposed');
  const [zoom, setZoom] = useState('1');
  const [notice, setNotice] = useState('');
  const fixture = fixtures[selected];
  const control: React.CSSProperties = {
    minWidth: 0,
    maxWidth: '100%',
    minHeight: uiGrammar.action.height,
    padding: '12px',
    borderRadius: uiGrammar.radius.control,
    border: `1px solid ${colors.border}`,
    background: colors.surfaceRaised,
    color: colors.text,
    font: 'inherit',
  };

  return (
    <div
      style={{
        ...htmlStyles.shell,
        background: colors.background,
        color: colors.text,
      }}
    >
      <header
        style={{
          ...htmlStyles.header,
          borderColor: colors.separator,
          background: colors.surface,
        }}
      >
        <strong style={htmlStyles.banner}>
          Aperçu visuel · données fictives · aucune lecture iOS
        </strong>
      </header>
      <main style={htmlStyles.main}>
        <div style={htmlStyles.content}>
          <h1 style={htmlStyles.title}>États des outils</h1>
          <p
            style={{
              ...htmlStyles.body,
              color: colors.muted,
            }}
          >
            La vraie carte d’interface, dans un fil synthétique. Les contrôles
            modifient seulement cet aperçu : aucun moteur, accès calendrier ni
            appel natif.
          </p>
          <div style={htmlStyles.controls}>
            <label style={htmlStyles.label}>
              <span>Apparence</span>
              <select
                aria-label="Apparence de l’aperçu"
                value={appearance}
                style={control}
                onChange={event =>
                  setAppearance(
                    controlValue(event.currentTarget) as AppearanceId,
                  )
                }
              >
                {(Object.keys(themes) as AppearanceId[]).map(id => (
                  <option key={id} value={id}>
                    {themes[id].label}
                  </option>
                ))}
              </select>
            </label>
            <label style={htmlStyles.stateLabel}>
              <span>État fictif</span>
              <select
                aria-label="État fictif de la carte"
                value={selected}
                style={control}
                onChange={event => {
                  setSelected(controlValue(event.currentTarget) as FixtureId);
                  setNotice('');
                }}
              >
                {(Object.keys(fixtures) as FixtureId[]).map(id => (
                  <option key={id} value={id}>
                    {fixtures[id].label}
                  </option>
                ))}
              </select>
            </label>
            <label style={htmlStyles.zoomLabel}>
              <span>Zoom visuel</span>
              <select
                aria-label="Zoom visuel de l’aperçu"
                value={zoom}
                style={control}
                onChange={event => setZoom(controlValue(event.currentTarget))}
              >
                <option value="1">100 %</option>
                <option value="1.5">150 %</option>
                <option value="2">200 %</option>
              </select>
            </label>
          </div>
          <p style={{ ...htmlStyles.caption, color: colors.muted }}>
            Le zoom sert à éprouver le retour à la ligne ; il ne qualifie pas
            Dynamic Type ou VoiceOver sur iPhone.
          </p>
          <section
            aria-label="Fil de conversation fictif"
            style={{ ...htmlStyles.thread, zoom: Number(zoom) }}
          >
            <View style={styles.thread}>
              <View
                style={[styles.user, { backgroundColor: colors.userBubble }]}
              >
                <Text style={[styles.caption, { color: colors.userText }]}>
                  Message fictif
                </Text>
                <Text style={[styles.body, { color: colors.userText }]}>
                  Consulte mon calendrier d’aujourd’hui.
                </Text>
              </View>
              <ToolCallCard
                key={selected}
                transaction={fixture.transaction}
                onCancel={() => {
                  setSelected('cancelRequested');
                  setNotice(
                    'Simulation visuelle uniquement : aucun arrêt iOS demandé.',
                  );
                }}
                onPermission={() =>
                  setNotice(
                    'Simulation visuelle uniquement : aucune autorisation iOS demandée.',
                  )
                }
              />
              <View style={styles.answer}>
                <Text style={[styles.caption, { color: colors.muted }]}>
                  Assistant · exemple fictif
                </Text>
                <Text style={[styles.body, { color: colors.text }]}>
                  {answers[selected] ??
                    'Aucune réponse réelle : cet écran montre seulement la présentation de l’état sélectionné.'}
                </Text>
              </View>
            </View>
          </section>
          {notice && (
            <p
              role="status"
              style={{ ...htmlStyles.notice, color: colors.muted }}
            >
              {notice}
            </p>
          )}
          <a
            href="/"
            style={{
              ...htmlStyles.link,
              color: colors.accent,
            }}
          >
            Revenir à l’app sans moteur
          </a>
        </div>
      </main>
    </div>
  );
}

/** Browser-only fixtures. NativeAssist remains null in the preview alias. */
export default function ToolStatesPreview() {
  return (
    <AppearanceProvider>
      <PreviewContent />
    </AppearanceProvider>
  );
}

const styles = StyleSheet.create({
  thread: { gap: uiGrammar.harmony.space.large, paddingVertical: 21 },
  user: {
    alignSelf: 'flex-end',
    maxWidth: '90%',
    borderRadius: uiGrammar.radius.bubble,
    padding: 16,
    gap: 8,
  },
  answer: { gap: 8 },
  caption: { ...uiGrammar.type.caption },
  body: { ...uiGrammar.type.body },
});
