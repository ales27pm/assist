import React, { act } from 'react';
import { Alert, AppState, Platform, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import {
  renderAsync,
  screen,
  userEvent,
  waitFor,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { DeviceToolsPanel } from '../src/DeviceToolsPanel';
import { SettingsScreen } from '../src/SettingsScreen';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getDeviceCapabilityStatus: jest.fn(),
    requestDeviceCapability: jest.fn(),
    searchContacts: jest.fn(),
    listCalendarEvents: jest.fn(),
    createCalendarEvent: jest.fn(),
    listReminders: jest.fn(),
    createReminder: jest.fn(),
    getCurrentLocation: jest.fn(),
    selectPhoto: jest.fn(),
    capturePhoto: jest.fn(),
    scheduleLocalNotification: jest.fn(),
    getBiometricStatus: jest.fn(),
    authenticateWithBiometrics: jest.fn(),
  },
}));

const native = jest.mocked(NativeAssist!);
const appStateDescriptor = Object.getOwnPropertyDescriptor(
  AppState,
  'currentState',
)!;
const snapshot = {
  capabilities: {
    contacts: 'notDetermined',
    calendar: 'authorized',
    reminders: 'denied',
    location: 'authorizedWhenInUse',
    camera: 'notDetermined',
    notifications: 'notDetermined',
    biometrics: { available: true, type: 'faceId' },
  },
  boundaries: {},
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  for (const method of Object.values(native)) method.mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  native.getDeviceCapabilityStatus.mockResolvedValue(JSON.stringify(snapshot));
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', appStateDescriptor);
});

async function openSection(name: string) {
  const user = userEvent.setup();
  await user.press(screen.getByRole('button', { name }));
  return user;
}

test('opening tools does not invoke native APIs; status is explicit and does not request access', async () => {
  const user = userEvent.setup();
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  for (const method of Object.values(native))
    expect(method).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Vérifier les autorisations' }),
  );
  expect(native.getDeviceCapabilityStatus).toHaveBeenCalledTimes(1);
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  expect(screen.getByText('Contacts : Non demandé')).toBeOnTheScreen();
  expect(screen.getByText('Rappels : Refusé')).toBeOnTheScreen();
});

test('requests only the named permission and bounds reads to five results and 24 hours', async () => {
  native.requestDeviceCapability.mockResolvedValue(
    JSON.stringify({ capability: 'contacts', status: 'limited' }),
  );
  native.searchContacts.mockResolvedValue(
    JSON.stringify({
      contacts: [
        {
          givenName: 'PrivateName',
          emailAddresses: [{ value: 'private@example.org' }],
        },
      ],
      query: 'Alice',
    }),
  );
  native.listCalendarEvents.mockResolvedValue(JSON.stringify({ events: [] }));
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Contacts');
  await user.press(
    screen.getByRole('button', { name: 'Demander l’accès aux contacts' }),
  );
  expect(native.requestDeviceCapability).toHaveBeenCalledWith('contacts');
  await user.type(screen.getByLabelText('Nom à rechercher'), 'Alice');
  await user.press(
    screen.getByRole('button', { name: 'Rechercher ces contacts' }),
  );
  expect(native.searchContacts).toHaveBeenCalledWith('Alice', '5');
  expect(
    screen.getByText(
      '1 contact trouvé. Les coordonnées ne sont pas affichées.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.queryByText(/PrivateName|private@example/),
  ).not.toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Calendrier' }));
  await user.press(
    screen.getByRole('button', {
      name: 'Lire les événements des prochaines 24 h',
    }),
  );
  const [, start, end, limit] = native.listCalendarEvents.mock.calls[0];
  expect(Date.parse(end) - Date.parse(start)).toBe(86_400_000);
  expect(limit).toBe('5');
});

test('creation requires a confirmation, uses its exact preview, and consumes confirmation once', async () => {
  native.createCalendarEvent.mockResolvedValue(
    JSON.stringify({ id: 'event-1' }),
  );
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Calendrier');
  await user.press(
    screen.getByRole('button', { name: 'Préparer un événement de test' }),
  );
  expect(native.createCalendarEvent).not.toHaveBeenCalled();
  const [title, message, buttons] = jest.mocked(Alert.alert).mock.calls[0];
  expect(title).toBe('Créer cet événement ?');
  expect(message).toContain('Test Assist');
  expect(message).toContain('calendrier par défaut');
  const confirm = buttons!.find(button => button.text === 'Créer')!.onPress!;
  await act(async () => {
    confirm();
    confirm();
  });
  await waitFor(() =>
    expect(native.createCalendarEvent).toHaveBeenCalledTimes(1),
  );
  const payload = JSON.parse(native.createCalendarEvent.mock.calls[0][0]);
  expect(payload.title).toBe('Test Assist');
  expect(Date.parse(payload.endISO) - Date.parse(payload.startISO)).toBe(
    1_800_000,
  );
  expect(message).toContain(new Date(payload.startISO).toLocaleString('fr-CA'));
  expect(await screen.findByText(/Événement de test créé/)).toBeOnTheScreen();
});

test('cancelled and stale confirmations never create an item', async () => {
  let lifecycle: ((state: AppStateStatus) => void) | undefined;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, listener) => {
      lifecycle = listener;
      return { remove: jest.fn() };
    });
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Rappels');
  await user.press(
    screen.getByRole('button', { name: 'Préparer un rappel de test' }),
  );
  const first = jest.mocked(Alert.alert).mock.calls[0][2]!;
  await act(async () => {
    first.find(button => button.text === 'Annuler')!.onPress!();
  });
  expect(native.createReminder).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Préparer un rappel de test' }),
  );
  const second = jest.mocked(Alert.alert).mock.calls[1][2]!;
  await act(async () => {
    lifecycle!('background');
    lifecycle!('active');
    second.find(button => button.text === 'Créer')!.onPress!();
  });
  expect(native.createReminder).not.toHaveBeenCalled();
});

test('browser preview never invokes native tools', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const user = userEvent.setup();
  const close = jest.fn();
  await renderAsync(<DeviceToolsPanel onClose={close} />);
  expect(screen.getByText(/nécessitent la version iOS/)).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Vérifier les autorisations' }),
  ).toBeDisabled();
  await user.press(screen.getByRole('button', { name: 'Fermer les outils' }));
  expect(close).toHaveBeenCalledTimes(1);
  for (const method of Object.values(native))
    expect(method).not.toHaveBeenCalled();
});

test('keeps a confirmed write receipt across backgrounding without repeating the write', async () => {
  let lifecycle: ((state: AppStateStatus) => void) | undefined;
  let complete!: (json: string) => void;
  native.createReminder.mockReturnValue(
    new Promise(resolve => {
      complete = resolve;
    }),
  );
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, listener) => {
      lifecycle = listener;
      return { remove: jest.fn() };
    });
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Rappels');
  await user.press(
    screen.getByRole('button', { name: 'Préparer un rappel de test' }),
  );
  await act(async () => {
    jest
      .mocked(Alert.alert)
      .mock.calls[0][2]!.find(button => button.text === 'Créer')!.onPress!();
  });
  await act(async () => {
    lifecycle!('background');
    complete(JSON.stringify({ id: 'accepted-reminder' }));
  });
  await act(async () => {
    lifecycle!('active');
  });
  expect(screen.getByText(/^Rappel de test créé\./)).toBeOnTheScreen();
  expect(native.createReminder).toHaveBeenCalledTimes(1);
  expect(Alert.alert).toHaveBeenCalledTimes(1);
});

test('settings provides an explicit tools entry and return without running a tool', async () => {
  const user = userEvent.setup();
  await renderAsync(
    <SettingsScreen
      modelStatus="Prêt"
      budget=""
      budgetError=""
      busy={false}
      responseOpen={false}
      onToggleResponse={jest.fn()}
      onBudgetChange={jest.fn()}
      onModel={jest.fn()}
      onAppearance={jest.fn()}
      appearanceRef={React.createRef<React.ComponentRef<typeof View>>()}
    />,
  );
  await user.press(
    screen.getByRole('button', { name: 'Outils de l’appareil' }),
  );
  expect(
    screen.getByRole('heading', { name: 'Outils de l’appareil' }),
  ).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Fermer les outils' }));
  expect(screen.getByRole('heading', { name: 'Réglages' })).toBeOnTheScreen();
  expect(native.getDeviceCapabilityStatus).not.toHaveBeenCalled();
});
