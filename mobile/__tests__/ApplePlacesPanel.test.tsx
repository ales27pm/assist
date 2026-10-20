import React, { act } from 'react';
import { AppState, AppStateStatus, Linking, Platform } from 'react-native';
import {
  fireEventAsync,
  renderAsync,
  screen,
  userEvent,
  waitFor,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { ApplePlacesPanel } from '../src/ApplePlacesPanel';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getApplePlacesStatus: jest.fn(),
    searchApplePlaces: jest.fn(),
    getAppleDirections: jest.fn(),
    getAppleForecast: jest.fn(),
    openApplePlace: jest.fn(),
    cancelApplePlaces: jest.fn(),
    renderWeatherAttribution: jest.fn(),
    cancelWeatherAttribution: jest.fn(),
    getCurrentLocation: jest.fn(),
    generate: jest.fn(),
    generateWithTools: jest.fn(),
    searchPrivateService: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const encode = JSON.stringify;
const date = '2026-10-19T12:00:00Z';
const place = {
  id: 'p1',
  name: 'Bibliothèque',
  address: 'Québec',
  coordinate: { latitude: 46.8139, longitude: -71.208 },
};
let lifecycle: (state: AppStateStatus) => void;
const originalState = Object.getOwnPropertyDescriptor(
  AppState,
  'currentState',
)!;
function searchResult(requestId: string) {
  return encode({
    schemaVersion: 1,
    requestId,
    provider: 'Apple Maps',
    results: [place],
    truncated: false,
    untrusted: true,
  });
}
function forecastResult(request: { requestId: string; coordinate: unknown }) {
  return encode({
    schemaVersion: 1,
    requestId: request.requestId,
    coordinate: request.coordinate,
    temperatureUnit: 'celsius',
    retrievedAt: date,
    attribution: {
      serviceName: 'Apple Weather',
      legalPageURL: 'https://weatherkit.apple.com/legal-attribution.html',
      combinedMarkLightURL:
        'https://weatherkit.apple.com/assets/branding/en/Apple_Weather_blk_en_3X_090122.png',
      combinedMarkDarkURL:
        'https://weatherkit.apple.com/assets/branding/en/Apple_Weather_wht_en_3X_090122.png',
      legalAttributionText: 'Texte légal exact du fournisseur Apple.',
    },
    current: {
      date,
      condition: 'clear',
      symbolName: 'sun.max',
      temperature: 12,
      apparentTemperature: 11,
      humidity: 0.6,
      windKilometersPerHour: 10,
    },
    hourly: [
      { date, condition: 'clear', temperature: 12, precipitationChance: 0.2 },
    ],
    daily: [
      {
        date,
        condition: 'clear',
        highTemperature: 15,
        lowTemperature: 5,
        precipitationChance: 0.2,
      },
    ],
    forecastNotGuarantee: true,
  });
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  Object.values(native).forEach(method => method.mockReset());
  jest.replaceProperty(Platform, 'OS', 'ios');
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      lifecycle = listener;
      return { remove: jest.fn() };
    });
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  native.getApplePlacesStatus.mockResolvedValue(
    encode({
      schemaVersion: 1,
      maps: 'available',
      weather: 'requires_signed_weatherkit_entitlement',
      weatherDeviceVerified: false,
      locationMode: 'explicit_text_or_coordinates',
    }),
  );
  native.searchApplePlaces.mockImplementation(async json =>
    searchResult(JSON.parse(json).requestId),
  );
  native.getAppleForecast.mockImplementation(async json =>
    forecastResult(JSON.parse(json)),
  );
  native.renderWeatherAttribution.mockImplementation(async json => {
    const request = JSON.parse(json);
    return encode({
      schemaVersion: 1,
      requestId: request.requestId,
      sourceURL: request.markURL,
      pngDataURI:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=',
      width: 231,
      height: 42,
      rendered: true,
    });
  });
  native.cancelWeatherAttribution.mockImplementation(async requestId =>
    encode({ schemaVersion: 1, requestId, cancelled: true }),
  );
  native.getAppleDirections.mockImplementation(async json =>
    encode({
      ...JSON.parse(json),
      provider: 'Apple Maps',
      distanceMeters: 1200,
      expectedTravelSeconds: 900,
      name: 'Rue Saint-Joseph',
      calculatedAt: date,
      estimateOnly: true,
      navigationStarted: false,
    }),
  );
  native.openApplePlace.mockResolvedValue(
    encode({ schemaVersion: 1, opened: true, navigationStarted: false }),
  );
  native.cancelApplePlaces.mockResolvedValue(
    encode({ schemaVersion: 1, cancelled: true }),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', originalState);
  jest.useRealTimers();
});
async function findPlaces() {
  const user = userEvent.setup();
  await user.paste(
    screen.getByLabelText('Lieu et ville à rechercher'),
    'Bibliothèque, Québec',
  );
  await user.press(
    screen.getByRole('button', { name: 'Rechercher le lieu dans Plans' }),
  );
  await screen.findByRole('button', { name: 'Météo : Bibliothèque' });
  return user;
}
test('metadata only on mount; no GPS, search, weather, gateway or model operation is implicit', async () => {
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  expect(native.getApplePlacesStatus).toHaveBeenCalledTimes(1);
  for (const method of [
    native.searchApplePlaces,
    native.getAppleForecast,
    native.getAppleDirections,
    native.getCurrentLocation,
    native.generate,
    native.generateWithTools,
    native.searchPrivateService,
  ])
    expect(method).not.toHaveBeenCalled();
  expect(
    screen.getByText(/météo sur cet appareil.*pas encore qualifiés/),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Rechercher le lieu dans Plans' }),
  ).toBeDisabled();
});
test('search uses explicit text, then opening uses only the retained native IDs', async () => {
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = await findPlaces();
  const request = JSON.parse(native.searchApplePlaces.mock.calls[0][0]);
  expect(request).toEqual({
    schemaVersion: 1,
    requestId: expect.any(String),
    query: 'Bibliothèque, Québec',
    limit: 5,
  });
  await user.press(
    screen.getByRole('button', { name: 'Ouvrir Plans : Bibliothèque' }),
  );
  expect(native.openApplePlace).toHaveBeenCalledWith(request.requestId, 'p1');
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect(screen.getByText(/Aucun guidage lancé/)).toBeOnTheScreen();
  expect(native.getCurrentLocation).not.toHaveBeenCalled();
});
test('weather requires touching a selected place and actual attribution logo before showing data', async () => {
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = await findPlaces();
  expect(native.getAppleForecast).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Météo : Bibliothèque' }),
  );
  const request = JSON.parse(native.getAppleForecast.mock.calls[0][0]);
  expect(request).toEqual({
    schemaVersion: 1,
    requestId: expect.any(String),
    coordinate: place.coordinate,
    unit: 'celsius',
    hourlyCount: 12,
    dailyCount: 5,
  });
  expect(
    screen.getByText('Texte légal exact du fournisseur Apple.'),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/Maintenant :/)).not.toBeOnTheScreen();
  await fireEventAsync(
    screen.getByLabelText('Marque officielle Apple Weather'),
    'load',
  );
  expect(screen.getByText('Maintenant : 12.0 °C · clear')).toBeOnTheScreen();
  expect(screen.getByText(/Prévisions, pas une garantie/)).toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', { name: 'Sources et attribution Apple' }),
  );
  expect(Linking.openURL).toHaveBeenCalledWith(
    'https://weatherkit.apple.com/legal-attribution.html',
  );
  expect(native.generate).not.toHaveBeenCalled();
});
test('consultation time never masquerades as the date of the weather conditions', async () => {
  const observedAt = '2026-10-19T09:00:00Z';
  native.getAppleForecast.mockImplementation(async json => {
    const result = JSON.parse(forecastResult(JSON.parse(json)));
    result.current.date = observedAt;
    return encode(result);
  });
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = await findPlaces();
  await user.press(
    screen.getByRole('button', { name: 'Météo : Bibliothèque' }),
  );
  await fireEventAsync(
    screen.getByLabelText('Marque officielle Apple Weather'),
    'load',
  );
  expect(
    screen.getByText(
      `Prévisions, pas une garantie. Consultation : ${new Date(
        date,
      ).toLocaleString('fr-CA')}.`,
    ),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(
      `Conditions datées du ${new Date(observedAt).toLocaleString('fr-CA')}.`,
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/Mise à jour :/)).not.toBeOnTheScreen();
});
test('a native-decoded official mark that fails final Image rendering stays fail-closed', async () => {
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = await findPlaces();
  await user.press(
    screen.getByRole('button', { name: 'Météo : Bibliothèque' }),
  );
  await fireEventAsync(
    screen.getByLabelText('Marque officielle Apple Weather'),
    'error',
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    /les données météo restent masquées/,
  );
  expect(screen.queryByText(/Maintenant :/)).not.toBeOnTheScreen();
});
test('explicit endpoints and chosen automobile transport produce an estimate without navigation', async () => {
  const destination = {
    ...place,
    id: 'p2',
    name: 'Musée',
    coordinate: { latitude: 46.82, longitude: -71.22 },
  };
  native.searchApplePlaces.mockImplementation(async json =>
    encode({
      schemaVersion: 1,
      requestId: JSON.parse(json).requestId,
      provider: 'Apple Maps',
      results: [place, destination],
      truncated: false,
      untrusted: true,
    }),
  );
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = await findPlaces();
  await user.press(
    screen.getByRole('button', { name: 'Départ : Bibliothèque' }),
  );
  await user.press(screen.getByRole('button', { name: 'Destination : Musée' }));
  expect(native.getAppleDirections).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'En auto' }));
  await user.press(
    screen.getByRole('button', {
      name: 'Estimer le trajet entre les lieux choisis',
    }),
  );
  expect(JSON.parse(native.getAppleDirections.mock.calls[0][0])).toMatchObject({
    origin: place.coordinate,
    destination: destination.coordinate,
    transport: 'automobile',
  });
  expect(screen.getByText('Trajet estimé : 1.2 km · 15 min')).toBeOnTheScreen();
  expect(screen.getByText(/sans démarrer de navigation/)).toBeOnTheScreen();
  expect(native.openApplePlace).not.toHaveBeenCalled();
});
test('a malformed provider result never becomes an actionable place', async () => {
  native.searchApplePlaces.mockImplementation(async json =>
    searchResult(JSON.parse(json).requestId).replace(
      'Apple Maps',
      'Untrusted provider',
    ),
  );
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = userEvent.setup();
  await user.paste(
    screen.getByLabelText('Lieu et ville à rechercher'),
    'Québec',
  );
  await user.press(
    screen.getByRole('button', { name: 'Rechercher le lieu dans Plans' }),
  );
  expect(screen.getByRole('alert')).toHaveTextContent(/réponse incompatible/);
  expect(
    screen.queryByRole('button', { name: 'Météo : Bibliothèque' }),
  ).not.toBeOnTheScreen();
});
test('foreground cannot enable another operation until native cancellation is acknowledged', async () => {
  let resolveSearch!: (value: string) => void;
  let resolveCancel!: (value: string) => void;
  native.searchApplePlaces.mockImplementation(
    () =>
      new Promise(done => {
        resolveSearch = done;
      }),
  );
  native.cancelApplePlaces.mockImplementation(
    () =>
      new Promise(done => {
        resolveCancel = done;
      }),
  );
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = userEvent.setup();
  await user.paste(
    screen.getByLabelText('Lieu et ville à rechercher'),
    'Québec',
  );
  await user.press(
    screen.getByRole('button', { name: 'Rechercher le lieu dans Plans' }),
  );
  const request = JSON.parse(native.searchApplePlaces.mock.calls[0][0]);
  await act(async () => {
    lifecycle('inactive');
    lifecycle('active');
  });
  await act(async () => {
    resolveSearch(searchResult(request.requestId));
  });
  expect(
    screen.getByRole('button', { name: 'Vérifier Cartes et Météo' }),
  ).toBeDisabled();
  expect(screen.queryByText('Résultats Apple Maps')).not.toBeOnTheScreen();
  await act(async () => {
    resolveCancel(encode({ schemaVersion: 1, cancelled: true }));
  });
  expect(
    screen.getByRole('button', { name: 'Vérifier Cartes et Météo' }),
  ).toBeEnabled();
  expect(native.searchApplePlaces).toHaveBeenCalledTimes(1);
});
test('parent startup blocked then unblocked performs one metadata handshake, no query replay', async () => {
  let resolveCancel!: (value: string) => void;
  native.cancelApplePlaces.mockImplementation(
    () =>
      new Promise(done => {
        resolveCancel = done;
      }),
  );
  await renderAsync(<ApplePlacesPanel blocked />);
  expect(native.getApplePlacesStatus).not.toHaveBeenCalled();
  await screen.rerenderAsync(<ApplePlacesPanel blocked={false} />);
  expect(
    screen.getByRole('button', { name: 'Vérifier Cartes et Météo' }),
  ).toBeDisabled();
  await act(async () => {
    resolveCancel(encode({ schemaVersion: 1, cancelled: true }));
  });
  expect(native.getApplePlacesStatus).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Lieu et ville à rechercher')).toBeEnabled();
  expect(native.searchApplePlaces).not.toHaveBeenCalled();
  expect(native.getAppleForecast).not.toHaveBeenCalled();
});
test('strict effect replay does not retain an obsolete busy lock', async () => {
  await renderAsync(
    <React.StrictMode>
      <ApplePlacesPanel blocked={false} />
    </React.StrictMode>,
  );
  expect(screen.getByLabelText('Lieu et ville à rechercher')).toBeEnabled();
  expect(native.searchApplePlaces).not.toHaveBeenCalled();
});
test('cancel revokes the pending request before a late response can be accepted', async () => {
  let resolve!: (value: string) => void;
  native.searchApplePlaces.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = userEvent.setup();
  await user.paste(
    screen.getByLabelText('Lieu et ville à rechercher'),
    'Québec',
  );
  await user.press(
    screen.getByRole('button', { name: 'Rechercher le lieu dans Plans' }),
  );
  const request = JSON.parse(native.searchApplePlaces.mock.calls[0][0]);
  await user.press(
    screen.getByRole('button', { name: 'Interrompre Cartes et Météo' }),
  );
  await act(async () => {
    resolve(searchResult(request.requestId));
  });
  expect(native.cancelApplePlaces).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Résultats Apple Maps')).not.toBeOnTheScreen();
  expect(
    screen.getByLabelText('Lieu et ville à rechercher'),
  ).toHaveDisplayValue('');
});
test('inactive purges choices, cancels only Apple owner and never auto-resumes on foreground', async () => {
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  await findPlaces();
  await act(async () => {
    lifecycle('inactive');
  });
  expect(native.cancelApplePlaces).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Résultats Apple Maps')).not.toBeOnTheScreen();
  await act(async () => {
    lifecycle('active');
  });
  expect(native.searchApplePlaces).toHaveBeenCalledTimes(1);
  expect(native.getAppleForecast).not.toHaveBeenCalled();
});
test('blocked and missing native bridges keep actions unavailable', async () => {
  await renderAsync(<ApplePlacesPanel blocked />);
  expect(native.getApplePlacesStatus).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Rechercher le lieu dans Plans' }),
  ).toBeDisabled();
  await screen.unmountAsync();
  const methods = native as unknown as Record<string, unknown>;
  const saved = methods.getAppleForecast;
  delete methods.getAppleForecast;
  try {
    await renderAsync(<ApplePlacesPanel blocked={false} />);
    expect(
      screen.getByText(/nécessitent le nouveau binaire/),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Vérifier Cartes et Météo' }),
    ).toBeDisabled();
  } finally {
    methods.getAppleForecast = saved;
  }
});
test('safe generic error hides provider errors and bad native output', async () => {
  native.getAppleForecast.mockRejectedValue(
    new Error('PRIVATE_RAW_ACCOUNT_TOKEN_MUST_NOT_DISPLAY'),
  );
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = await findPlaces();
  await user.press(
    screen.getByRole('button', { name: 'Météo : Bibliothèque' }),
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    /non autorisé ou réponse incompatible/,
  );
  expect(screen.queryByText(/PRIVATE_RAW/)).not.toBeOnTheScreen();
});
test('unmount cancels only Apple and discards a late provider response', async () => {
  let resolve!: (value: string) => void;
  native.searchApplePlaces.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  await renderAsync(<ApplePlacesPanel blocked={false} />);
  const user = userEvent.setup();
  await user.paste(
    screen.getByLabelText('Lieu et ville à rechercher'),
    'Québec',
  );
  await user.press(
    screen.getByRole('button', { name: 'Rechercher le lieu dans Plans' }),
  );
  const request = JSON.parse(native.searchApplePlaces.mock.calls[0][0]);
  await screen.unmountAsync();
  await act(async () => {
    resolve(searchResult(request.requestId));
  });
  await waitFor(() =>
    expect(native.cancelApplePlaces).toHaveBeenCalledTimes(1),
  );
  expect(native.getCurrentLocation).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
});
