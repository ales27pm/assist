import {
  AppleDirectionsRequest,
  AppleForecastRequest,
  appleAttributionURL,
  appleCoordinate,
  parseAppleCancellation,
  parseAppleDirections,
  parseAppleForecast,
  parseAppleOpenReceipt,
  parseApplePlacesStatus,
  parseAppleSearch,
  validAppleQuery,
} from '../src/applePlacesProtocol';

const coordinate = { latitude: 46.8139, longitude: -71.208 };
const date = '2026-10-19T12:00:00Z';
const encode = JSON.stringify;
const search = {
  schemaVersion: 1,
  requestId: 's1',
  provider: 'Apple Maps',
  results: [{ id: 'p1', name: 'Bibliothèque', address: 'Québec', coordinate }],
  truncated: false,
  untrusted: true,
};
const request: AppleForecastRequest = {
  schemaVersion: 1,
  requestId: 'w1',
  coordinate,
  unit: 'celsius',
  hourlyCount: 12,
  dailyCount: 5,
};
const forecast = {
  schemaVersion: 1,
  requestId: 'w1',
  coordinate,
  temperatureUnit: 'celsius',
  retrievedAt: date,
  attribution: {
    serviceName: 'Apple Weather',
    legalPageURL: 'https://weatherkit.apple.com/legal-attribution.html',
    combinedMarkLightURL: 'https://weatherkit.apple.com/assets/mark-light.svg',
    combinedMarkDarkURL: 'https://weatherkit.apple.com/assets/mark-dark.svg',
    legalAttributionText: 'Attribution légale exacte fournie par Apple.',
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
};
const routeRequest: AppleDirectionsRequest = {
  schemaVersion: 1,
  requestId: 'd1',
  origin: coordinate,
  destination: { latitude: 46.82, longitude: -71.22 },
  transport: 'walking',
};
const directions = {
  ...routeRequest,
  provider: 'Apple Maps',
  distanceMeters: 1200,
  expectedTravelSeconds: 900,
  name: 'Rue Saint-Joseph',
  calculatedAt: date,
  estimateOnly: true,
  navigationStarted: false,
};

test('validates explicit text, coordinate boundaries and no permission authority', () => {
  expect(validAppleQuery('Bibliothèque, Québec')).toBe(true);
  for (const text of ['', '  ', 'a\nb', '<|tool_call>', 'é'.repeat(129)])
    expect(validAppleQuery(text)).toBe(false);
  expect(appleCoordinate({ latitude: -90, longitude: 180 })).toEqual({
    latitude: -90,
    longitude: 180,
  });
  for (const value of [
    { latitude: 91, longitude: 0 },
    { latitude: true, longitude: 0 },
    { latitude: 0, longitude: Number.NaN },
    { latitude: 0, longitude: -181 },
    { ...coordinate, gps: true },
  ])
    expect(() => appleCoordinate(value)).toThrow();
});
test('requires the exact native status and refuses a fake verified WeatherKit claim', () => {
  const status = {
    schemaVersion: 1,
    maps: 'available',
    weather: 'requires_signed_weatherkit_entitlement',
    weatherDeviceVerified: false,
    locationMode: 'explicit_text_or_coordinates',
  };
  expect(parseApplePlacesStatus(encode(status))).toEqual(status);
  expect(() =>
    parseApplePlacesStatus(encode({ ...status, weatherDeviceVerified: true })),
  ).toThrow();
  expect(() =>
    parseApplePlacesStatus(encode({ ...status, weather: 'enabled' })),
  ).toThrow();
});
test('search binds identity, closed fields, provider and bounded result IDs', () => {
  expect(parseAppleSearch(encode(search), 's1')).toEqual(search);
  for (const invalid of [
    { ...search, requestId: 'old' },
    { ...search, provider: 'Made up' },
    { ...search, untrusted: false },
    { ...search, extra: 'execute' },
    { ...search, results: Array(11).fill(search.results[0]) },
    { ...search, results: [search.results[0], search.results[0]] },
    { ...search, results: [{ ...search.results[0], name: 'x'.repeat(257) }] },
    {
      ...search,
      results: [
        { ...search.results[0], coordinate: { latitude: 100, longitude: 0 } },
      ],
    },
  ])
    expect(() => parseAppleSearch(encode(invalid), 's1')).toThrow();
});
test('direction receipt is an estimate of exactly the requested endpoints and transport', () => {
  expect(parseAppleDirections(encode(directions), routeRequest)).toEqual(
    directions,
  );
  for (const invalid of [
    { ...directions, navigationStarted: true },
    { ...directions, estimateOnly: false },
    { ...directions, origin: { latitude: 0, longitude: 0 } },
    { ...directions, transport: 'automobile' },
    { ...directions, expectedTravelSeconds: -1 },
    { ...directions, distanceMeters: null },
    { ...directions, calculatedAt: '2026-02-30T12:00:00Z' },
  ])
    expect(() => parseAppleDirections(encode(invalid), routeRequest)).toThrow();
});
test.each([
  'http://weatherkit.apple.com/a',
  'https://apple.com.evil.test/a',
  'https://127.0.0.1/a',
  'https://apple.com@evil.test/a',
  'https://user:secret@apple.com/a',
  'https://weatherkit.apple.com:8443/a',
  'https://weatherkit.apple.com/a#x',
  'javascript:alert(1)', // eslint-disable-line no-script-url -- rejection fixture, never executed
  'https://weatherkit.apple.com\\@evil.test/a',
])('does not fetch or open an untrusted attribution URL %s', value => {
  expect(appleAttributionURL(value)).toBe(false);
});
test('forecast validates actual required attribution and request units/counts', () => {
  expect(parseAppleForecast(encode(forecast), request)).toEqual(forecast);
  expect(appleAttributionURL(forecast.attribution.combinedMarkLightURL)).toBe(
    true,
  );
  for (const invalid of [
    { ...forecast, requestId: 'stale' },
    { ...forecast, temperatureUnit: 'fahrenheit' },
    { ...forecast, forecastNotGuarantee: false },
    { ...forecast, coordinate: { latitude: 0, longitude: 0 } },
    { ...forecast, hourly: Array(13).fill(forecast.hourly[0]) },
    { ...forecast, daily: Array(6).fill(forecast.daily[0]) },
    {
      ...forecast,
      attribution: { ...forecast.attribution, legalAttributionText: '' },
    },
    {
      ...forecast,
      attribution: { ...forecast.attribution, serviceName: '<|tool_call>' },
    },
    {
      ...forecast,
      attribution: {
        ...forecast.attribution,
        combinedMarkDarkURL: 'https://evil.test/tracker.svg',
      },
    },
    { ...forecast, current: { ...forecast.current, humidity: 60 } },
    {
      ...forecast,
      hourly: [{ ...forecast.hourly[0], precipitationChance: 20 }],
    },
    {
      ...forecast,
      daily: [{ ...forecast.daily[0], highTemperature: 1, lowTemperature: 5 }],
    },
  ])
    expect(() => parseAppleForecast(encode(invalid), request)).toThrow();
  expect(() =>
    parseAppleForecast(encode(forecast), { ...request, hourlyCount: 0 }),
  ).toThrow();
  expect(() =>
    parseAppleForecast(encode(forecast), { ...request, dailyCount: 6 }),
  ).toThrow();
  expect(() =>
    parseAppleForecast(' '.repeat(24 * 1024 + 1), request),
  ).toThrow();
});
test('opening and cancellation acknowledgments do not mean navigation or weather availability', () => {
  expect(
    parseAppleOpenReceipt(
      encode({ schemaVersion: 1, opened: true, navigationStarted: false }),
    ),
  ).toBe(true);
  expect(
    parseAppleOpenReceipt(
      encode({ schemaVersion: 1, opened: false, navigationStarted: false }),
    ),
  ).toBe(false);
  expect(() =>
    parseAppleOpenReceipt(
      encode({ schemaVersion: 1, opened: true, navigationStarted: true }),
    ),
  ).toThrow();
  expect(
    parseAppleCancellation(encode({ schemaVersion: 1, cancelled: true })),
  ).toBeUndefined();
  expect(() =>
    parseAppleCancellation(encode({ schemaVersion: 1, cancelled: false })),
  ).toThrow();
});
