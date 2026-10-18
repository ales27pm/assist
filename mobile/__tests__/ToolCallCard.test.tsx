import React from 'react';
import { AccessibilityInfo, Platform, Pressable, Text } from 'react-native';
import { renderAsync, screen, userEvent } from '@testing-library/react-native';
import { AppearanceProvider, themes, useAppearance } from '../src/appearance';
import type { AppearanceId } from '../src/appearance';
import type { CalendarAgentTrace } from '../src/protocol';
import type { CalendarToolTransaction } from '../src/toolActivity';
import { ToolCallCard } from '../src/ToolCallCard';

const scope = {
  startISO: '2026-10-18T04:00:00.000Z',
  endISO: '2026-10-19T04:00:00.000Z',
  timeZoneIdentifier: 'America/Toronto',
};
const receipt: CalendarAgentTrace = {
  schemaVersion: 1,
  tool: 'calendar.list',
  callId: 'private-call-id',
  scope,
  returnedCount: 2,
  possiblyTruncated: false,
};

function transaction(
  status: CalendarToolTransaction['status'],
  extra: Partial<CalendarToolTransaction> = {},
): CalendarToolTransaction {
  return { id: 'private-transaction-id', status, scope, ...extra };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('preparation is a read-only proposal, not a completed read or an execution control', async () => {
  const onCancel = jest.fn();
  const onPermission = jest.fn();
  await renderAsync(
    <ToolCallCard
      transaction={transaction('proposed')}
      onCancel={onCancel}
      onPermission={onPermission}
    />,
  );

  expect(
    screen.getByRole('heading', { name: 'Consulter aujourd’hui' }),
  ).toBeOnTheScreen();
  expect(screen.getByText('Calendrier · lecture seule')).toBeOnTheScreen();
  expect(screen.getByText('Préparation')).toBeOnTheScreen();
  expect(screen.getByText('5 événements maximum')).toBeOnTheScreen();
  expect(screen.queryByText('Lecture confirmée')).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: /exécuter|consulter|autoriser/i }),
  ).not.toBeOnTheScreen();
  expect(onCancel).not.toHaveBeenCalled();
  expect(onPermission).not.toHaveBeenCalled();
});

test('scope is rendered in the supplied time zone, including its exclusive end, not as tomorrow', async () => {
  const user = userEvent.setup();
  await renderAsync(<ToolCallCard transaction={transaction('executing')} />);

  expect(screen.getByText('18 octobre · journée entière')).toBeOnTheScreen();
  expect(screen.queryByText(/^Période :/)).not.toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', { name: 'Détails de la consultation' }),
  );
  expect(screen.getByText(/^Période :/)).toHaveTextContent(
    /18 octobre 2026.*00 h 00/,
  );
  expect(screen.getByText(/^Période :/)).toHaveTextContent(
    /19 octobre 2026.*00 h 00.*fin exclue/,
  );
  expect(screen.queryByText(/demain/i)).not.toBeOnTheScreen();
  expect(screen.queryByText(/04 h 00/)).not.toBeOnTheScreen();
});

test.each([
  [
    '2026-03-08T05:00:00.000Z',
    '2026-03-09T04:00:00.000Z',
    '8 mars 2026',
    '9 mars 2026',
  ],
  [
    '2026-11-01T04:00:00.000Z',
    '2026-11-02T05:00:00.000Z',
    '1 novembre 2026',
    '2 novembre 2026',
  ],
])(
  'a civil day remains midnight to midnight across daylight-saving changes',
  async (startISO, endISO, firstDay, lastDay) => {
    const user = userEvent.setup();
    await renderAsync(
      <ToolCallCard
        transaction={transaction('executing', {
          scope: { ...scope, startISO, endISO },
        })}
      />,
    );
    await user.press(
      screen.getByRole('button', { name: 'Détails de la consultation' }),
    );
    expect(screen.getByText(/^Période :/)).toHaveTextContent(
      new RegExp(firstDay),
    );
    expect(screen.getByText(/^Période :/)).toHaveTextContent(
      new RegExp(lastDay),
    );
    expect(screen.getByText(/^Période :/)).toHaveTextContent(
      /00 h 00.*00 h 00/,
    );
  },
);

test('cancel is an accessible callback and remains disabled while its acknowledgement is pending', async () => {
  const user = userEvent.setup();
  const onCancel = jest.fn();
  const { rerenderAsync } = await renderAsync(
    <ToolCallCard transaction={transaction('executing')} onCancel={onCancel} />,
  );

  expect(screen.getByText('Consultation en cours')).toBeOnTheScreen();
  expect(screen.getByText('Consultation en cours')).toBeBusy();
  await user.press(
    screen.getByRole('button', { name: 'Arrêter la consultation' }),
  );
  expect(onCancel).toHaveBeenCalledTimes(1);

  await rerenderAsync(
    <ToolCallCard
      transaction={transaction('executing', { cancelRequested: true })}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByText('Annulation demandée')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Annulation en cours…' }),
  ).toBeDisabled();
  await user.press(
    screen.getByRole('button', { name: 'Annulation en cours…' }),
  );
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Consultation interrompue')).not.toBeOnTheScreen();
});

test('observing is answer preparation and only claims a read when its receipt exists', async () => {
  const { rerenderAsync } = await renderAsync(
    <ToolCallCard transaction={transaction('observing')} />,
  );
  expect(screen.getByText('Réponse en préparation')).toBeOnTheScreen();
  expect(screen.queryByText('Lecture confirmée')).not.toBeOnTheScreen();
  expect(screen.queryByText('2 événements retournés.')).not.toBeOnTheScreen();

  await rerenderAsync(
    <ToolCallCard transaction={transaction('observing', { receipt })} />,
  );
  expect(screen.getByText('Réponse en préparation')).toBeOnTheScreen();
  expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
  expect(screen.getByText('2 événements retournés.')).toBeOnTheScreen();
});

test('success without a receipt remains explicitly unconfirmed', async () => {
  await renderAsync(<ToolCallCard transaction={transaction('success')} />);

  expect(screen.getByText('Lecture non confirmée')).toBeOnTheScreen();
  expect(screen.queryByText('Lecture confirmée')).not.toBeOnTheScreen();
  expect(screen.queryByText(/événements? retournés?/)).not.toBeOnTheScreen();
});

test('a model response without a tool call is not presented as a user cancellation', async () => {
  await renderAsync(<ToolCallCard transaction={transaction('cancelled')} />);
  expect(screen.getByText('Calendrier non consulté')).toBeOnTheScreen();
  expect(
    screen.getByText('Le modèle n’a pas demandé de lecture.'),
  ).toBeOnTheScreen();
  expect(screen.queryByText('Consultation interrompue')).not.toBeOnTheScreen();
});

test.each(['failed_safe', 'cancelled'] as const)(
  '%s preserves a confirmed read without pretending the answer completed',
  async status => {
    await renderAsync(
      <ToolCallCard
        transaction={transaction(status, { receipt, error: 'interrupted' })}
      />,
    );
    expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
    expect(screen.getByText('2 événements retournés.')).toBeOnTheScreen();
    expect(
      screen.getByText(
        status === 'cancelled'
          ? 'Réponse interrompue'
          : 'Réponse non finalisée',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Calendrier non consulté')).not.toBeOnTheScreen();
  },
);

test.each([0, 1, 5])(
  'a receipt reports %i returned items, without claiming a complete calendar',
  async count => {
    await renderAsync(
      <ToolCallCard
        transaction={transaction('success', {
          receipt: {
            ...receipt,
            returnedCount: count,
            possiblyTruncated: count === 5,
          },
        })}
      />,
    );

    expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
    const summary =
      count === 0
        ? 'Aucun événement retourné.'
        : `${count} événement${count > 1 ? 's' : ''} retourné${
            count > 1 ? 's' : ''
          }.`;
    expect(screen.getByText(summary)).toBeOnTheScreen();
    expect(
      screen.queryByText(/calendrier vide|liste complète/i),
    ).not.toBeOnTheScreen();
    if (count === 5)
      expect(
        screen.getByText('La liste peut être incomplète.'),
      ).toBeOnTheScreen();
  },
);

test('receipt scope is authoritative if a stale proposal scope differs', async () => {
  await renderAsync(
    <ToolCallCard
      transaction={transaction('success', {
        scope: {
          ...scope,
          startISO: '2026-10-20T04:00:00.000Z',
          endISO: '2026-10-21T04:00:00.000Z',
        },
        receipt,
      })}
    />,
  );
  expect(screen.getByText('18 octobre · journée entière')).toBeOnTheScreen();
  expect(screen.queryByText(/20 octobre 2026/)).not.toBeOnTheScreen();
});

test('permission action is opt-in and calls only its supplied callback', async () => {
  const user = userEvent.setup();
  const onPermission = jest.fn();
  await renderAsync(
    <ToolCallCard
      transaction={transaction('failed_safe', { error: 'permission' })}
      onPermission={onPermission}
    />,
  );

  expect(screen.getByText('Accès calendrier requis')).toBeOnTheScreen();
  expect(
    screen.getByHintText('Ouvrir Réglages, puis Outils de l’appareil.'),
  ).toBeOnTheScreen();
  expect(onPermission).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Gérer l’accès au calendrier' }),
  );
  expect(onPermission).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText(/jamais consulté|aucune consultation effectuée/i),
  ).not.toBeOnTheScreen();
});

test.each(['failed_safe', 'cancelled'] as const)(
  '%s does not imply that an earlier read never happened or offer an automatic retry',
  async status => {
    await renderAsync(
      <ToolCallCard
        transaction={transaction(status, { error: 'interrupted' })}
      />,
    );

    expect(
      screen.getByText(
        status === 'cancelled'
          ? 'Consultation interrompue'
          : 'Consultation non terminée',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.queryByText(
        /jamais consulté|aucune consultation effectuée|calendrier non consulté/i,
      ),
    ).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: /réessayer|relancer|autoriser/i }),
    ).not.toBeOnTheScreen();
  },
);

test('details are collapsed and accessible independently, and never reveal event data, raw JSON or identifiers', async () => {
  const user = userEvent.setup();
  const extraReceipt = {
    ...receipt,
    events: [{ title: 'SECRET_APPOINTMENT', notes: 'PRIVATE_NOTES' }],
  };
  await renderAsync(
    <ToolCallCard
      transaction={transaction('success', { receipt: extraReceipt })}
    />,
  );

  const details = screen.getByRole('button', {
    name: 'Détails de la consultation',
  });
  expect(details).toBeCollapsed();
  expect(
    screen.queryByText('Aucune création, modification ni suppression.'),
  ).not.toBeOnTheScreen();
  await user.press(details);
  expect(details).toBeExpanded();
  expect(
    screen.getByText('Aucune création, modification ni suppression.'),
  ).toBeOnTheScreen();
  expect(
    screen.queryByText(
      /SECRET_APPOINTMENT|PRIVATE_NOTES|private-call-id|private-transaction-id|calendar\.list|startISO/,
    ),
  ).not.toBeOnTheScreen();
  await user.press(details);
  expect(details).toBeCollapsed();
  expect(
    screen.queryByText('Aucune création, modification ni suppression.'),
  ).not.toBeOnTheScreen();
});

test('a different transaction starts with its details closed', async () => {
  const user = userEvent.setup();
  const { rerenderAsync } = await renderAsync(
    <ToolCallCard transaction={transaction('success', { receipt })} />,
  );
  await user.press(
    screen.getByRole('button', { name: 'Détails de la consultation' }),
  );
  await rerenderAsync(
    <ToolCallCard
      transaction={transaction('proposed', { id: 'next-transaction-id' })}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Détails de la consultation' }),
  ).toBeCollapsed();
});

test.each([
  { ...receipt, callId: '' },
  { ...receipt, returnedCount: -1 },
  { ...receipt, returnedCount: 6 },
  { ...receipt, returnedCount: 1.5 },
  { ...receipt, returnedCount: 5, possiblyTruncated: false },
])(
  'malformed receipt metadata never creates a success claim',
  async invalid => {
    await renderAsync(
      <ToolCallCard
        transaction={transaction('success', { receipt: invalid })}
      />,
    );
    expect(screen.getByText('Lecture non confirmée')).toBeOnTheScreen();
    expect(screen.queryByText('Lecture confirmée')).not.toBeOnTheScreen();
  },
);

test('iOS announces each state change once at low priority, not on repeated renders', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
  const { rerenderAsync } = await renderAsync(
    <ToolCallCard transaction={transaction('proposed')} />,
  );
  expect(announce).toHaveBeenLastCalledWith('Calendrier. Préparation.', {
    priority: 'low',
  });
  await rerenderAsync(
    <ToolCallCard transaction={transaction('proposed')} onCancel={jest.fn()} />,
  );
  expect(announce).toHaveBeenCalledTimes(1);
  await rerenderAsync(<ToolCallCard transaction={transaction('executing')} />);
  expect(announce).toHaveBeenLastCalledWith(
    'Calendrier. Consultation en cours.',
    { priority: 'low' },
  );
  await rerenderAsync(
    <ToolCallCard transaction={transaction('observing', { receipt })} />,
  );
  expect(announce).toHaveBeenLastCalledWith(
    'Calendrier. Réponse en préparation. Lecture confirmée. 2 événements retournés.',
    { priority: 'low' },
  );
  await rerenderAsync(
    <ToolCallCard
      transaction={transaction('observing', { receipt: { ...receipt } })}
    />,
  );
  expect(announce).toHaveBeenCalledTimes(3);
});

test('Android retains a polite live region without using the iOS announcement API', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
  await renderAsync(
    <ToolCallCard
      transaction={transaction('executing')}
      onCancel={jest.fn()}
    />,
  );
  expect(screen.getByText('Consultation en cours')).toHaveProp(
    'accessibilityLiveRegion',
    'polite',
  );
  expect(
    screen.getByRole('button', { name: 'Arrêter la consultation' }),
  ).toBeOnTheScreen();
  expect(announce).not.toHaveBeenCalled();
});

test.each([
  { ...scope, timeZoneIdentifier: 'private-invalid-zone' },
  { ...scope, startISO: 'invalid-date' },
  { ...scope, endISO: scope.startISO },
  {
    ...scope,
    startISO: '2026-02-30T04:00:00.000Z',
    endISO: '2026-03-03T04:00:00.000Z',
  },
  {
    ...scope,
    startISO: '2026-10-18T00:00:00-04:00',
    endISO: '2026-10-19T00:00:00-04:00',
  },
])(
  'unavailable scope is bounded and never exposes its raw values',
  async invalid => {
    await renderAsync(
      <ToolCallCard
        transaction={transaction('executing', { scope: invalid })}
      />,
    );
    expect(screen.getByText('Période indisponible.')).toBeOnTheScreen();
    expect(
      screen.queryByText(/private-invalid-zone|invalid-date|NaN|Invalid Date/),
    ).not.toBeOnTheScreen();
  },
);

test('a proposal waits for native scope without presenting an unavailable period as an error', async () => {
  await renderAsync(
    <ToolCallCard
      transaction={transaction('proposed', { scope: undefined })}
    />,
  );
  expect(
    screen.getByText('Aujourd’hui · période vérifiée avant lecture'),
  ).toBeOnTheScreen();
  expect(screen.queryByText('Période indisponible.')).not.toBeOnTheScreen();
});

test('an unknown scope and unavailable permission action stay non-executable', async () => {
  await renderAsync(
    <ToolCallCard
      transaction={transaction('failed_safe', {
        scope: undefined,
        error: 'permission',
      })}
    />,
  );
  expect(screen.getByText('Période indisponible.')).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Gérer l’accès au calendrier' }),
  ).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Arrêter la consultation' }),
  ).not.toBeOnTheScreen();
});

test.each(['light', 'graphite', 'blue'] as const)(
  'shared appearance colors remain readable in %s',
  async appearance => {
    const user = userEvent.setup();
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
          <ToolCallCard
            transaction={transaction('failed_safe', { error: 'unconfirmed' })}
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
      screen.getByRole('heading', { name: 'Consulter aujourd’hui' }),
    ).toHaveStyle({ color: themes[appearance].colors.text });
    expect(screen.getByText('Consultation non terminée')).toHaveStyle({
      color: themes[appearance].colors.danger,
    });
    expect(screen.getByText('5 événements maximum')).toHaveStyle({
      color: themes[appearance].colors.muted,
    });
  },
);
