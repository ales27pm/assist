import {extendedToolEffect} from '../src/nativeBundleTools';
import React from 'react';
import { Pressable, Text } from 'react-native';
import { renderAsync, screen, userEvent } from '@testing-library/react-native';
import { AppearanceProvider, themes, useAppearance } from '../src/appearance';
import type { AppearanceId } from '../src/appearance';
import { DeviceToolCard } from '../src/DeviceToolCard';
import { DeviceToolDecisionSheet } from '../src/DeviceToolDecisionSheet';
import {
  DeviceToolTransaction,
  deviceToolLabels,
  deviceToolNames,
} from '../src/deviceToolProtocol';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const privateToken = 'PRIVATE_CONFIRMATION_TOKEN_NEVER_RENDER';
const effectTools = {
  read: 'calendar_list',
  write: 'calendar_create',
  interactive: 'photo_select',
} as const;
function transaction(
  status: DeviceToolTransaction['status'] = 'awaiting_confirmation',
  extra: Partial<DeviceToolTransaction> = {},
): DeviceToolTransaction {
  const selectedTool = extra.tool ?? 'calendar_create';
  const effect = extendedToolEffect(selectedTool) ?? ([
    'calendar_create',
    'reminder_create',
    'notification_schedule',
  ].includes(selectedTool)
    ? 'write'
    : ['photo_select', 'camera_capture', 'biometrics_authenticate'].includes(
        selectedTool,
      )
    ? 'interactive'
    : 'read');
  return {
    id: 'private-operation-id',
    revision: 1,
    tool: selectedTool,
    effect,
    title: deviceToolLabels[selectedTool],
    status,
    preview: [
      { label: 'Titre', value: 'Réunion {équipe}, "édition"' },
      { label: 'Période', value: '18 octobre, 14 h à 15 h' },
    ],
    ...(status === 'awaiting_confirmation'
      ? { confirmationToken: privateToken }
      : {}),
    ...(status === 'awaiting_permission'
      ? { capability: 'calendar' as const }
      : {}),
    ...(['success', 'outcome_unknown'].includes(status)
      ? {
          receipt: {
            operationId: 'private-operation-id',
            tool: selectedTool,
            status: status as 'success' | 'outcome_unknown',
            completedAt: '2026-10-18T18:00:00Z',
            summary: [
              {
                label: 'État natif',
                value:
                  status === 'success'
                    ? 'Création confirmée'
                    : 'Résultat inconnu',
              },
            ],
          },
        }
      : {}),
    ...extra,
  };
}
function sheetProps() {
  return {
    pending: false,
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    onPermission: jest.fn(),
    onDismiss: jest.fn(),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test.each(deviceToolNames)(
  'renders the named native action %s without internal IDs or tokens',
  async tool => {
    await renderAsync(
      <DeviceToolCard
        transaction={transaction('awaiting_confirmation', { tool })}
      />,
    );
    expect(
      screen.getByRole('heading', { name: deviceToolLabels[tool] }),
    ).toBeOnTheScreen();
    expect(
      screen.queryByText(
        /PRIVATE_CONFIRMATION_TOKEN|private-operation-id|confirmationToken/,
      ),
    ).not.toBeOnTheScreen();
  },
);

test.each([
  ['awaiting_confirmation', 'Ton accord est requis'],
  ['awaiting_permission', 'Accès iOS requis'],
  ['executing', 'Exécution en cours'],
  ['success', 'Résultat confirmé'],
  ['failed_safe', 'Action non aboutie'],
  ['outcome_unknown', 'Vérification requise'],
  ['cancelled', 'Action interrompue'],
] as const)('renders %s as its own truthful state', async (status, label) => {
  await renderAsync(<DeviceToolCard transaction={transaction(status)} />);
  expect(screen.getByText(label)).toBeOnTheScreen();
  if (status === 'executing') expect(screen.getByText(label)).toBeBusy();
  if (status !== 'success')
    expect(screen.queryByText('Résultat confirmé')).not.toBeOnTheScreen();
});

test.each(['read', 'write', 'interactive'] as const)(
  'labels the %s effect without broad phone-control claims',
  async effect => {
    await renderAsync(
      <DeviceToolCard
        transaction={transaction('executing', {
          tool: effectTools[effect],
          effect,
        })}
      />,
    );
    const label =
      effect === 'read'
        ? 'Lecture'
        : effect === 'write'
        ? 'Modification'
        : 'Interaction iOS';
    expect(screen.getByText(`${label} · sur cet appareil`)).toBeOnTheScreen();
    expect(
      screen.queryByText(/accès à tout|contrôle complet/i),
    ).not.toBeOnTheScreen();
  },
);

test.each(['maps_search', 'maps_directions', 'weather_forecast'] as const)(
  '%s states that Apple network services are used, not an offline read',
  async tool => {
    await renderAsync(
      <DeviceToolCard transaction={transaction('executing', { tool })} />,
    );
    expect(
      screen.getByText('Lecture · service Apple en ligne'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/sur cet appareil/)).not.toBeOnTheScreen();
  },
);

test('review is opt-in and opens no permission or execution by itself', async () => {
  const user = userEvent.setup();
  const onReview = jest.fn();
  await renderAsync(
    <DeviceToolCard transaction={transaction()} onReview={onReview} />,
  );
  expect(onReview).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Vérifier l’action' }));
  expect(onReview).toHaveBeenCalledTimes(1);
});

test.each([
  'executing',
  'success',
  'failed_safe',
  'outcome_unknown',
  'cancelled',
] as const)('%s exposes no retry or live consent control', async status => {
  await renderAsync(
    <DeviceToolCard transaction={transaction(status)} onReview={jest.fn()} />,
  );
  expect(
    screen.queryByRole('button', {
      name: /vérifier|réessayer|relancer|autoriser|confirmer/i,
    }),
  ).not.toBeOnTheScreen();
});

test('unknown outcome requires external verification and never invites a second write', async () => {
  await renderAsync(
    <DeviceToolCard
      transaction={transaction('outcome_unknown')}
      onReview={jest.fn()}
    />,
  );
  expect(screen.getByText(/L’action a peut-être eu lieu/)).toHaveTextContent(
    /Vérifie dans l’app concernée.*Aucun nouvel essai automatique/,
  );
  expect(screen.queryByText(/création confirmée/i)).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', {
      name: /réessayer|recréer|confirmer|relancer/i,
    }),
  ).not.toBeOnTheScreen();
});

test('native receipt summary is distinct from a collapsed immutable preview', async () => {
  const user = userEvent.setup();
  await renderAsync(<DeviceToolCard transaction={transaction('success')} />);
  expect(screen.getByText('État natif : Création confirmée')).toBeOnTheScreen();
  const disclosure = screen.getByRole('button', {
    name: 'Détails de l’action',
  });
  expect(disclosure).toBeCollapsed();
  expect(
    screen.queryByText('Titre : Réunion {équipe}, "édition"'),
  ).not.toBeOnTheScreen();
  await user.press(disclosure);
  expect(disclosure).toBeExpanded();
  expect(
    screen.getByText('Titre : Réunion {équipe}, "édition"'),
  ).toBeOnTheScreen();
  expect(
    screen.queryByText(/private-operation-id|completedAt|confirmationToken/),
  ).not.toBeOnTheScreen();
});

test.each(['photo_select', 'camera_capture'] as const)(
  '%s qualifies Apple OCR as local text, not image vision or reliable truth',
  async tool => {
    await renderAsync(
      <DeviceToolCard
        transaction={transaction('executing', { tool, effect: 'interactive' })}
      />,
    );
    expect(screen.getByText(/OCR Apple sur cet appareil/)).toHaveTextContent(
      /seul le texte reconnu est transmis à Gemma, pas l’image/,
    );
    expect(screen.getByText(/OCR Apple sur cet appareil/)).toHaveTextContent(
      /peut contenir des erreurs/,
    );
  },
);

test('a notification receipt proves scheduling, never alert presentation or delivery', async () => {
  await renderAsync(
    <DeviceToolCard
      transaction={transaction('success', { tool: 'notification_schedule' })}
    />,
  );
  expect(screen.getByText('Résultat confirmé')).toBeOnTheScreen();
  expect(
    screen.getByText(
      'Programmation acceptée, pas une preuve de présentation de l’alerte.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.queryByText(/notification livrée|alerte affichée/i),
  ).not.toBeOnTheScreen();
});

test.each(['light', 'graphite', 'blue'] as const)(
  'long previews and uncertainty remain readable using the %s theme',
  async appearance => {
    const user = userEvent.setup();
    const longValue = 'Texte reconnu, {données}, "citation". '.repeat(100);
    function Fixture({ selected }: { selected: AppearanceId }) {
      const { setAppearance } = useAppearance();
      return (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Changer le thème"
            onPress={() => setAppearance(selected)}
          >
            <Text>Changer le thème</Text>
          </Pressable>
          <DeviceToolCard
            transaction={transaction('outcome_unknown', {
              preview: [{ label: 'Texte long', value: longValue }],
            })}
          />
        </>
      );
    }
    await renderAsync(
      <AppearanceProvider>
        <Fixture selected={appearance} />
      </AppearanceProvider>,
    );
    await user.press(screen.getByRole('button', { name: 'Changer le thème' }));
    expect(
      screen.getByRole('heading', { name: 'Créer un événement' }),
    ).toHaveStyle({ color: themes[appearance].colors.text });
    expect(screen.getByText('Vérification requise')).toHaveStyle({
      color: themes[appearance].colors.danger,
    });
    await user.press(
      screen.getByRole('button', { name: 'Détails de l’action' }),
    );
    expect(screen.getByText(`Texte long : ${longValue.trim()}`)).toHaveStyle({
      color: themes[appearance].colors.text,
    });
  },
);

describe('tactile native decision sheet', () => {
  test('nothing is rendered when no native operation is awaiting a decision', async () => {
    await renderAsync(
      <DeviceToolDecisionSheet transaction={null} {...sheetProps()} />,
    );
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });
  test.each([
    ['read', 'Autoriser cette lecture'],
    ['write', 'Confirmer cette modification'],
    ['interactive', 'Continuer dans iOS'],
  ] as const)(
    'requires a fresh tactile %s confirmation and never renders its token',
    async (effect, label) => {
      const user = userEvent.setup();
      const props = sheetProps();
      await renderAsync(
        <DeviceToolDecisionSheet
          transaction={transaction('awaiting_confirmation', {
            tool: effectTools[effect],
            effect,
          })}
          {...props}
        />,
      );
      expect(
        screen.getByRole('header', {
          name: deviceToolLabels[effectTools[effect]],
        }),
      ).toBeOnTheScreen();
      expect(
        screen.getByText(
          /Seul ce toucher autorise cette action, une seule fois/,
        ),
      ).toBeOnTheScreen();
      expect(screen.getByText('Réunion {équipe}, "édition"')).toBeOnTheScreen();
      expect(screen.queryByText(privateToken)).not.toBeOnTheScreen();
      expect(props.onConfirm).not.toHaveBeenCalled();
      expect(props.onPermission).not.toHaveBeenCalled();
      await user.press(screen.getByRole('button', { name: label }));
      expect(props.onConfirm).toHaveBeenCalledTimes(1);
      expect(props.onPermission).not.toHaveBeenCalled();
      expect(props.onCancel).not.toHaveBeenCalled();
    },
  );
  test('pending acknowledgement disables both confirmation and cancel to prevent double submission', async () => {
    const user = userEvent.setup();
    const props = sheetProps();
    await renderAsync(
      <DeviceToolDecisionSheet
        transaction={transaction()}
        {...props}
        pending
      />,
    );
    const confirm = screen.getByRole('button', {
      name: 'Confirmer cette modification',
    });
    const cancel = screen.getByRole('button', { name: 'Annuler l’action' });
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    await user.press(confirm);
    await user.press(cancel);
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });
  test('cancel is a distinct user decision, not a confirmation or permission request', async () => {
    const user = userEvent.setup();
    const props = sheetProps();
    await renderAsync(
      <DeviceToolDecisionSheet transaction={transaction()} {...props} />,
    );
    await user.press(screen.getByRole('button', { name: 'Annuler l’action' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onPermission).not.toHaveBeenCalled();
  });
  test('permission management is explicitly separate from the action and never reruns it', async () => {
    const user = userEvent.setup();
    const props = sheetProps();
    await renderAsync(
      <DeviceToolDecisionSheet
        transaction={transaction('awaiting_permission')}
        {...props}
      />,
    );
    expect(
      screen.getByText(
        /L’accès iOS et ton accord pour cette action sont deux décisions séparées/,
      ),
    ).toHaveTextContent(/rien ne sera relancé automatiquement/);
    expect(
      screen.queryByRole('button', {
        name: /Confirmer cette modification|Autoriser cette lecture|Continuer dans iOS/,
      }),
    ).not.toBeOnTheScreen();
    await user.press(
      screen.getByRole('button', { name: 'Gérer cet accès iOS' }),
    );
    expect(props.onPermission).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });
  test('permission management is also disabled while its acknowledgement is pending', async () => {
    const props = sheetProps();
    await renderAsync(
      <DeviceToolDecisionSheet
        transaction={transaction('awaiting_permission')}
        {...props}
        pending
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Gérer cet accès iOS' }),
    ).toBeDisabled();
  });
});
