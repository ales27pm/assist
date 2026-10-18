import React from 'react';
import { Alert, AppState, Platform } from 'react-native';
import type { AppStateStatus } from 'react-native';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { DeviceToolsPanel } from '../src/DeviceToolsPanel';

// Keep the real JS wrappers and mock only the native transport boundary.
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
const locationReceipt = {
  latitude: 45.501234,
  longitude: -73.561234,
  horizontalAccuracy: 16,
  timestampISO: '2026-10-18T12:00:00.000Z',
};
let lifecycle: (state: AppStateStatus) => void;
let removeLifecycle: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));
  jest.clearAllMocks();
  for (const method of Object.values(native)) method.mockReset();
  jest.replaceProperty(Platform, 'OS', 'ios');
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  removeLifecycle = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, listener) => {
      lifecycle = listener;
      return { remove: removeLifecycle };
    });
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
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

function latestAlert() {
  const calls = jest.mocked(Alert.alert).mock.calls;
  const [title, message, buttons] = calls[calls.length - 1];
  return {
    title,
    message: message!,
    create: buttons!.find(button => button.text === 'Créer')!.onPress!,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('reminder read requests only five incomplete reminders over the next 24 hours', async () => {
  native.listReminders.mockResolvedValue(
    JSON.stringify({ reminders: [{ title: 'PRIVATE_REMINDER_TITLE' }] }),
  );
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Rappels');
  await user.press(
    screen.getByRole('button', {
      name: 'Lire les rappels des prochaines 24 h',
    }),
  );

  expect(native.listReminders).toHaveBeenCalledTimes(1);
  const [completed, start, end, limit] = native.listReminders.mock.calls[0];
  expect(completed).toBe(false);
  expect(Date.parse(end) - Date.parse(start)).toBe(86_400_000);
  expect(limit).toBe('5');
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      '1 rappel(s) reçu(s), cinq maximum sur les prochaines 24 h. Les titres ne sont pas affichés.',
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/PRIVATE_REMINDER_TITLE/)).not.toBeOnTheScreen();
});

test('one location is explicit and coordinates are not displayed', async () => {
  native.getCurrentLocation.mockResolvedValue(JSON.stringify(locationReceipt));
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Position');
  expect(native.getCurrentLocation).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Obtenir une position' }),
  );

  expect(native.getCurrentLocation).toHaveBeenCalledTimes(1);
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  expect(screen.getByText(/^Position reçue\./)).toBeOnTheScreen();
  expect(screen.queryByText(/45\.501234|-73\.561234/)).not.toBeOnTheScreen();
});

test.each([
  ['selectPhoto', 'Choisir une photo de test', 'photoLibrary', 'sélectionnée'],
  ['capturePhoto', 'Prendre une photo de test', 'camera', 'capturée'],
] as const)(
  '%s returns only an image receipt without exposing its private path',
  async (method, label, source, verb) => {
    native[method].mockResolvedValue(
      JSON.stringify({
        uri: 'file:///private/PRIVATE_ATTACHMENT.jpg',
        mediaType: 'image/jpeg',
        byteCount: 1234,
        source,
      }),
    );
    await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
    const user = await openSection('Photos et caméra');
    await user.press(screen.getByRole('button', { name: label }));

    expect(native[method]).toHaveBeenCalledTimes(1);
    expect(
      native[method === 'selectPhoto' ? 'capturePhoto' : 'selectPhoto'],
    ).not.toHaveBeenCalled();
    expect(native.requestDeviceCapability).not.toHaveBeenCalled();
    expect(
      screen.getByText(`Photo ${verb} (1234 octets). Aucun envoi au modèle.`),
    ).toBeOnTheScreen();
    expect(
      screen.queryByText(/PRIVATE_ATTACHMENT|file:\/\//),
    ).not.toBeOnTheScreen();
  },
);

test('biometric availability does not authenticate; authentication is a separate explicit action', async () => {
  native.getBiometricStatus.mockResolvedValue(
    JSON.stringify({ available: true, type: 'faceID', errorCode: 0 }),
  );
  native.authenticateWithBiometrics.mockResolvedValue(
    JSON.stringify({ authenticated: true }),
  );
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Biométrie');
  await user.press(
    screen.getByRole('button', { name: 'Vérifier la biométrie' }),
  );
  expect(native.authenticateWithBiometrics).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      'Biométrie disponible. L’authentification n’a pas encore été testée.',
    ),
  ).toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', {
      name: 'Tester l’authentification biométrique',
    }),
  );
  expect(native.authenticateWithBiometrics).toHaveBeenCalledWith(
    'Tester la confirmation biométrique dans Assist.',
  );
  expect(
    screen.getByText(/^Authentification biométrique réussie\./),
  ).toBeOnTheScreen();
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
});

test('reminder confirmation freezes the preview and cannot create twice', async () => {
  native.createReminder.mockResolvedValue(JSON.stringify({ id: 'reminder-1' }));
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Rappels');
  const before = Date.now();
  await user.press(
    screen.getByRole('button', { name: 'Préparer un rappel de test' }),
  );
  const prepared = Date.now();
  const preview = latestAlert();
  expect(preview.title).toBe('Créer ce rappel ?');
  expect(preview.message).toContain('liste par défaut');
  expect(preview.message).toContain('Supprime-le ensuite dans Rappels');
  expect(native.createReminder).not.toHaveBeenCalled();

  await act(async () => {
    jest.advanceTimersByTime(90_000);
    preview.create();
    preview.create();
  });
  expect(native.createReminder).toHaveBeenCalledTimes(1);
  const input = JSON.parse(native.createReminder.mock.calls[0][0]);
  expect(Object.keys(input).sort()).toEqual(['dueISO', 'title']);
  expect(input.title).toBe('Test Assist');
  expect(Date.parse(input.dueISO)).toBeGreaterThanOrEqual(before + 600_000);
  expect(Date.parse(input.dueISO)).toBeLessThanOrEqual(prepared + 600_000);
  expect(preview.message).toContain(
    new Date(input.dueISO).toLocaleString('fr-CA'),
  );
  expect(screen.getByText(/^Rappel de test créé\./)).toBeOnTheScreen();
});

test('notification confirmation sends the fixed replacement payload and reports scheduling, not delivery', async () => {
  native.scheduleLocalNotification.mockResolvedValue(
    JSON.stringify({ id: 'assist-device-tools-test', scheduled: true }),
  );
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Notifications');
  await user.press(
    screen.getByRole('button', { name: 'Préparer une notification de test' }),
  );
  expect(native.scheduleLocalNotification).not.toHaveBeenCalled();
  const preview = latestAlert();
  expect(preview.title).toBe('Programmer cette notification ?');
  expect(preview.message).toContain('60 secondes après confirmation');
  expect(preview.message).toContain(
    'La programmation ne garantit pas sa présentation',
  );
  await act(async () => {
    preview.create();
    preview.create();
  });
  expect(native.scheduleLocalNotification).toHaveBeenCalledTimes(1);
  expect(JSON.parse(native.scheduleLocalNotification.mock.calls[0][0])).toEqual(
    {
      id: 'assist-device-tools-test',
      title: 'Test Assist',
      body: 'Notification locale de test.',
      timeIntervalSeconds: 60,
    },
  );
  expect(
    screen.getByText(
      'Notification de test programmée pour dans 60 secondes. Sa réception et son affichage restent à vérifier sur l’iPhone.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.queryByText(/Notification .* (reçue|livrée|affichée)\./),
  ).not.toBeOnTheScreen();
});

test('a pending native read serializes taps and all other actions', async () => {
  const pending = deferred<string>();
  native.getCurrentLocation.mockReturnValue(pending.promise);
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Position');
  const button = screen.getByRole('button', { name: 'Obtenir une position' });
  await user.press(button);
  await user.press(button);
  await user.press(
    screen.getByRole('button', { name: 'Vérifier les autorisations' }),
  );
  expect(native.getCurrentLocation).toHaveBeenCalledTimes(1);
  expect(native.getDeviceCapabilityStatus).not.toHaveBeenCalled();
  expect(button).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Fermer les outils' }),
  ).toBeDisabled();

  await act(async () => {
    pending.resolve(JSON.stringify(locationReceipt));
  });
  expect(screen.getByText(/^Position reçue\./)).toBeOnTheScreen();
  expect(button).toBeEnabled();
});

test('unmount removes the lifecycle listener and ignores a late native result', async () => {
  const pending = deferred<string>();
  native.getCurrentLocation.mockReturnValue(pending.promise);
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Position');
  await user.press(
    screen.getByRole('button', { name: 'Obtenir une position' }),
  );
  await screen.unmountAsync();
  expect(removeLifecycle).toHaveBeenCalledTimes(1);
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  await act(async () => {
    pending.resolve(JSON.stringify(locationReceipt));
  });
  expect(screen.queryByText(/^Position reçue\./)).not.toBeOnTheScreen();
  expect(native.getCurrentLocation).toHaveBeenCalledTimes(1);
});

test('a status read completed in background cannot repopulate stale permissions on return', async () => {
  const pending = deferred<string>();
  native.getDeviceCapabilityStatus.mockReturnValue(pending.promise);
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = userEvent.setup();
  await user.press(
    screen.getByRole('button', { name: 'Vérifier les autorisations' }),
  );
  await act(async () => {
    lifecycle('background');
  });
  await act(async () => {
    pending.resolve(
      JSON.stringify({
        capabilities: {
          contacts: 'limited',
          calendar: 'authorized',
          reminders: 'authorized',
          location: 'authorizedWhenInUse',
          camera: 'authorized',
          notifications: 'authorized',
          biometrics: { available: true, type: 'faceID' },
        },
        boundaries: {},
      }),
    );
  });
  await act(async () => {
    lifecycle('active');
  });
  expect(screen.queryByText('Contacts : Accès limité')).not.toBeOnTheScreen();
  expect(
    screen.queryByText(
      'État des autorisations relu sans nouvelle demande d’accès.',
    ),
  ).not.toBeOnTheScreen();
  expect(native.getDeviceCapabilityStatus).toHaveBeenCalledTimes(1);
});

test('an alert callback retained past unmount never creates a reminder', async () => {
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Rappels');
  await user.press(
    screen.getByRole('button', { name: 'Préparer un rappel de test' }),
  );
  const preview = latestAlert();
  await screen.unmountAsync();
  await act(async () => {
    preview.create();
  });
  expect(native.createReminder).not.toHaveBeenCalled();
});

test('a failed write is never retried automatically and does not expose native errors', async () => {
  native.createReminder.mockRejectedValue(
    Object.assign(new Error('PRIVATE_ACCOUNT_PATH'), {
      code: 'E_REMINDER_SAVE',
    }),
  );
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = await openSection('Rappels');
  await user.press(
    screen.getByRole('button', { name: 'Préparer un rappel de test' }),
  );
  await act(async () => {
    latestAlert().create();
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Création non confirmée. Vérifie l’app concernée avant de réessayer : un élément peut avoir été créé.',
  );
  expect(screen.queryByText(/PRIVATE_ACCOUNT_PATH/)).not.toBeOnTheScreen();
  await act(async () => {
    jest.advanceTimersByTime(3_600_000);
    lifecycle('background');
    lifecycle('active');
  });
  expect(native.createReminder).toHaveBeenCalledTimes(1);
  expect(Alert.alert).toHaveBeenCalledTimes(1);
});

test.each([
  [
    'selectPhoto',
    'Photos et caméra',
    'Choisir une photo de test',
    'E_CANCELLED',
  ],
  [
    'authenticateWithBiometrics',
    'Biométrie',
    'Tester l’authentification biométrique',
    'E_BIOMETRIC_AUTH',
  ],
] as const)(
  '%s cancellation is not success and does not trigger a retry',
  async (method, section, label, code) => {
    native[method].mockRejectedValue(
      Object.assign(new Error('PRIVATE_DETAIL'), { code }),
    );
    await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
    const user = await openSection(section);
    await user.press(screen.getByRole('button', { name: label }));
    expect(
      screen.getByText(
        'Essai annulé ou refusé. Aucune nouvelle tentative automatique.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/PRIVATE_DETAIL/)).not.toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(native[method]).toHaveBeenCalledTimes(1);
  },
);

test('an older bridge missing one method disables native actions without invoking partial support', async () => {
  const original = native.capturePhoto;
  Object.defineProperty(native, 'capturePhoto', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
    const user = await openSection('Rappels');
    expect(screen.getByText(/nécessitent la version iOS/)).toBeOnTheScreen();
    const action = screen.getByRole('button', {
      name: 'Lire les rappels des prochaines 24 h',
    });
    expect(action).toBeDisabled();
    await user.press(action);
    expect(native.listReminders).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Vérifier les autorisations' }),
    ).toBeDisabled();
  } finally {
    Object.defineProperty(native, 'capturePhoto', {
      configurable: true,
      writable: true,
      value: original,
    });
  }
});

test('a busy model blocks manual native actions while allowing a return to settings', async () => {
  const close = jest.fn();
  await renderAsync(<DeviceToolsPanel onClose={close} blocked />);
  const user = await openSection('Rappels');
  const action = screen.getByRole('button', {
    name: 'Préparer un rappel de test',
  });
  expect(action).toBeDisabled();
  await user.press(action);
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Vérifier les autorisations' }),
  ).toBeDisabled();
  await user.press(screen.getByRole('button', { name: 'Fermer les outils' }));
  expect(close).toHaveBeenCalledTimes(1);
  for (const method of Object.values(native))
    expect(method).not.toHaveBeenCalled();
});

test.each([
  [
    'a non-array reminder list',
    'listReminders',
    'Rappels',
    'Lire les rappels des prochaines 24 h',
    { reminders: { length: 1 } },
  ],
  [
    'an oversized reminder list',
    'listReminders',
    'Rappels',
    'Lire les rappels des prochaines 24 h',
    { reminders: Array.from({ length: 6 }, () => ({})) },
  ],
  [
    'non-numeric coordinates',
    'getCurrentLocation',
    'Position',
    'Obtenir une position',
    { ...locationReceipt, latitude: '45' },
  ],
  [
    'an oversized JPEG receipt',
    'selectPhoto',
    'Photos et caméra',
    'Choisir une photo de test',
    {
      uri: 'file:///private/photo.jpg',
      source: 'photoLibrary',
      mediaType: 'image/jpeg',
      byteCount: 10 * 1024 * 1024 + 1,
    },
  ],
  [
    'an incorrect image format',
    'capturePhoto',
    'Photos et caméra',
    'Prendre une photo de test',
    {
      uri: 'file:///private/photo.jpg',
      source: 'camera',
      mediaType: 'image/png',
      byteCount: 100,
    },
  ],
  [
    'a missing image URI',
    'selectPhoto',
    'Photos et caméra',
    'Choisir une photo de test',
    { source: 'photoLibrary', mediaType: 'image/jpeg', byteCount: 100 },
  ],
  [
    'a mismatched image source',
    'capturePhoto',
    'Photos et caméra',
    'Prendre une photo de test',
    {
      uri: 'file:///private/photo.jpg',
      source: 'photoLibrary',
      mediaType: 'image/jpeg',
      byteCount: 100,
    },
  ],
  [
    'a false authentication receipt',
    'authenticateWithBiometrics',
    'Biométrie',
    'Tester l’authentification biométrique',
    { authenticated: false },
  ],
  [
    'a non-boolean biometric status',
    'getBiometricStatus',
    'Biométrie',
    'Vérifier la biométrie',
    { available: 'yes', type: 'faceID' },
  ],
] as const)(
  'rejects %s rather than displaying success',
  async (_description, method, section, label, result) => {
    native[method].mockResolvedValue(JSON.stringify(result));
    await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
    const user = await openSection(section);
    await user.press(screen.getByRole('button', { name: label }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^L’essai n’a pas abouti\./,
    );
    expect(native[method]).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ['createReminder', 'Rappels', 'Préparer un rappel de test', { id: '' }],
  [
    'scheduleLocalNotification',
    'Notifications',
    'Préparer une notification de test',
    { id: 'n-1', scheduled: false },
  ],
] as const)(
  '%s malformed mutation receipts report uncertainty, not confirmed creation',
  async (method, section, label, result) => {
    native[method].mockResolvedValue(JSON.stringify(result));
    await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
    const user = await openSection(section);
    await user.press(screen.getByRole('button', { name: label }));
    await act(async () => {
      latestAlert().create();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^Création non confirmée\./,
    );
    expect(native[method]).toHaveBeenCalledTimes(1);
  },
);

test('malformed capability data is not reported as a successful status read', async () => {
  native.getDeviceCapabilityStatus.mockResolvedValue(
    JSON.stringify({ capabilities: {}, boundaries: {} }),
  );
  await renderAsync(<DeviceToolsPanel onClose={jest.fn()} />);
  const user = userEvent.setup();
  await user.press(
    screen.getByRole('button', { name: 'Vérifier les autorisations' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /^L’essai n’a pas abouti\./,
  );
  expect(
    screen.queryByText(
      'État des autorisations relu sans nouvelle demande d’accès.',
    ),
  ).not.toBeOnTheScreen();
});
