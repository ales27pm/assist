import {
  officialWeatherMarkURL,
  parseWeatherAttribution,
  parseWeatherMark,
} from '../src/weatherAttributionProtocol';
const light =
  'https://weatherkit.apple.com/assets/branding/en/Apple_Weather_blk_en_3X_090122.png';
const dark =
  'https://weatherkit.apple.com/assets/branding/fr-CA/Apple_Weather_wht_fr-CA_3X_090122.png';
const credit = {
  serviceName: 'Apple Weather',
  legalPageURL: 'https://weatherkit.apple.com/legal-attribution.html',
  combinedMarkLightURL: light,
  combinedMarkDarkURL: dark,
  legalAttributionText: 'Attribution exacte Apple.',
};
const rendered = {
  schemaVersion: 1,
  requestId: 'mark-1',
  sourceURL: light,
  pngDataURI:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=',
  width: 231,
  height: 42,
  rendered: true,
};
test('current official SDK PNG paths and complete legal metadata are accepted without rewriting', () => {
  expect(officialWeatherMarkURL(light, 'light')).toBe(true);
  expect(officialWeatherMarkURL(dark, 'dark')).toBe(true);
  expect(parseWeatherAttribution(credit)).toEqual(credit);
  expect(parseWeatherMark(JSON.stringify(rendered), 'mark-1', light)).toEqual(
    rendered,
  );
});
test.each([
  light.replace('https:', 'http:'),
  light + '?secret=x',
  light + '#x',
  light.replace('.png', '.svg'),
  light.replace('weatherkit.apple.com', 'weatherkit.apple.com.evil.test'),
  light.replace('_blk_', '_wht_'),
  light.replace('/assets/branding/', '/api/v1/'),
  light.replace('_3X_', '_9X_'),
])('never hands an arbitrary branding URL to native %s', value => {
  expect(officialWeatherMarkURL(value, 'light')).toBe(false);
});
test('rejects missing/truncated legal metadata and unsafe source links', () => {
  for (const value of [
    { ...credit, legalAttributionText: '' },
    { ...credit, extra: 'html' },
    { ...credit, legalPageURL: 'https://evil.test/legal' },
    { ...credit, combinedMarkLightURL: 'data:image/png;base64,abc' },
    { ...credit, legalAttributionText: 'x'.repeat(4097) },
  ])
    expect(() => parseWeatherAttribution(value)).toThrow();
});
test('requires bounded decoded PNG data, exact request/source and native completion proof', () => {
  for (const value of [
    { ...rendered, requestId: 'stale' },
    { ...rendered, sourceURL: dark },
    { ...rendered, rendered: false },
    { ...rendered, width: 769 },
    { ...rendered, width: 600, height: 128 },
    { ...rendered, height: 0 },
    { ...rendered, pngDataURI: 'https://evil.test/tracker.png' },
    { ...rendered, pngDataURI: 'data:image/svg+xml;base64,PHN2Zz4=' },
    {
      ...rendered,
      pngDataURI: 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(44 * 1024),
    },
    { ...rendered, html: '<script/>' },
  ])
    expect(() =>
      parseWeatherMark(JSON.stringify(value), 'mark-1', light),
    ).toThrow();
});
