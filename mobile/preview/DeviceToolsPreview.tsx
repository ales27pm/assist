import React, { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppearanceProvider, themes, useAppearance } from '../src/appearance';
import type { AppearanceId } from '../src/appearance';
import { DeviceToolCard } from '../src/DeviceToolCard';
import { DeviceToolDecisionSheet } from '../src/DeviceToolDecisionSheet';
import { deviceToolLabels, deviceToolNames } from '../src/deviceToolProtocol';
import type {
  DeviceToolName,
  DeviceToolTransaction,
} from '../src/deviceToolProtocol';

const statuses: DeviceToolTransaction['status'][] = [
  'awaiting_confirmation',
  'awaiting_permission',
  'executing',
  'success',
  'failed_safe',
  'outcome_unknown',
  'cancelled',
];
const htmlStyles = {
  main: {
    minHeight: '100%',
    padding: 24,
    boxSizing: 'border-box',
    fontFamily: 'system-ui, sans-serif',
  },
  content: { maxWidth: 760, margin: '0 auto', minWidth: 0 },
  heading: { fontSize: 28, lineHeight: '36px', overflowWrap: 'anywhere' },
  controls: { display: 'flex', flexWrap: 'wrap', gap: 16, margin: '24px 0' },
  link: { display: 'inline-flex', alignItems: 'center', minHeight: 44 },
} satisfies Record<string, React.CSSProperties>;
function value(target: unknown): string {
  return target &&
    typeof target === 'object' &&
    'value' in target &&
    typeof target.value === 'string'
    ? target.value
    : '';
}
function PreviewContent() {
  const { theme, appearance, setAppearance } = useAppearance();
  const { colors } = theme;
  const [tool, setTool] = useState<DeviceToolName>('photo_select');
  const [status, setStatus] = useState<DeviceToolTransaction['status']>(
    'awaiting_confirmation',
  );
  const [decision, setDecision] = useState(false);
  const [notice, setNotice] = useState('');
  const effect = [
    'calendar_create',
    'reminder_create',
    'notification_schedule',
  ].includes(tool)
    ? 'write'
    : ['photo_select', 'camera_capture', 'biometrics_authenticate'].includes(
        tool,
      )
    ? 'interactive'
    : 'read';
  const preview = ['photo_select', 'camera_capture'].includes(tool)
    ? [
        {
          label: 'OCR local Apple',
          value:
            'Choisir une seule image et en reconnaître le texte sur cet appareil. Aucun envoi de l’image au modèle.',
        },
      ]
    : [
        {
          label: 'Intention fictive',
          value:
            'Prendre les mesures — rendez-vous de démonstration, sans données privées.',
        },
        { label: 'Date fictive', value: '2026-10-19T12:00:00Z' },
      ];
  const transaction: DeviceToolTransaction = {
    id: 'synthetic-device-tool',
    revision: 1,
    tool,
    effect,
    title: deviceToolLabels[tool],
    status,
    preview,
    ...(status === 'awaiting_confirmation'
      ? { confirmationToken: 'synthetic-token-never-executed' }
      : {}),
    ...(status === 'awaiting_permission'
      ? { capability: 'camera' as const }
      : {}),
    ...(['success', 'outcome_unknown'].includes(status)
      ? {
          receipt: {
            operationId: 'synthetic-device-tool',
            tool,
            status: status as 'success' | 'outcome_unknown',
            completedAt: '2026-10-18T12:00:00Z',
            summary: [
              { label: 'Preuve', value: 'Reçu fictif, aucune opération iOS' },
            ],
          },
        }
      : {}),
  };
  const control = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flex: '1 1 190px',
    minWidth: 0,
  } as React.CSSProperties;
  const select = {
    minHeight: 52,
    minWidth: 0,
    padding: 12,
    borderRadius: 12,
    color: colors.text,
    border: `1px solid ${colors.border}`,
    background: colors.surface,
  };
  const finish = () => {
    setDecision(false);
    setNotice(
      'Démonstration seulement : aucun bridge natif, aucune action exécutée.',
    );
  };
  return (
    <main
      style={{
        ...htmlStyles.main,
        background: colors.background,
        color: colors.text,
      }}
    >
      <div style={htmlStyles.content}>
        <p style={{ color: colors.muted }}>
          Assist · Fixtures visuelles · aucune action iOS
        </p>
        <h1 style={htmlStyles.heading}>Outils et OCR natif</h1>
        <p>
          Ces états utilisent les vrais composants. Les données et reçus sont
          fictifs; le moteur reste indisponible dans le navigateur.
        </p>
        <div style={htmlStyles.controls}>
          <label style={control}>
            Thème
            <select
              style={select}
              value={appearance}
              onChange={event =>
                setAppearance(value(event.target) as AppearanceId)
              }
            >
              {Object.values(themes).map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label style={control}>
            Outil
            <select
              style={select}
              value={tool}
              onChange={event => {
                setTool(value(event.target) as DeviceToolName);
                setDecision(false);
              }}
            >
              {deviceToolNames.map(name => (
                <option key={name} value={name}>
                  {deviceToolLabels[name]}
                </option>
              ))}
            </select>
          </label>
          <label style={control}>
            État
            <select
              style={select}
              value={status}
              onChange={event => {
                setStatus(
                  value(event.target) as DeviceToolTransaction['status'],
                );
                setDecision(false);
              }}
            >
              {statuses.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <DeviceToolCard
          transaction={transaction}
          onReview={() => setDecision(true)}
        />
        <p role="status" style={{ color: colors.muted }}>
          {notice}
        </p>
        <DeviceToolDecisionSheet
          transaction={decision ? transaction : null}
          pending={false}
          onConfirm={finish}
          onPermission={finish}
          onCancel={finish}
          onDismiss={() => undefined}
        />
        <a
          href="/"
          style={{
            color: colors.accent,
            ...htmlStyles.link,
          }}
        >
          Retour à Assist sans moteur natif
        </a>
      </div>
    </main>
  );
}
export default function DeviceToolsPreview() {
  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <PreviewContent />
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}
