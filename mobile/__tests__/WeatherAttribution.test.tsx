import React, { act } from 'react';
import { AppState, AppStateStatus, Linking, Platform } from 'react-native';
import {
  fireEventAsync,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { AppearanceProvider, useAppearance } from '../src/appearance';
import { ActionButton } from '../src/uiPrimitives';
import { WeatherAttribution } from '../src/WeatherAttribution';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    renderWeatherAttribution: jest.fn(),
    cancelWeatherAttribution: jest.fn(),
    cancelApplePlaces: jest.fn(),
    generate: jest.fn(),
    speak: jest.fn(),
    beginSpeech: jest.fn(),
    enqueueSpeech: jest.fn(),
    finishSpeech: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const light =
  'https://weatherkit.apple.com/assets/branding/en/Apple_Weather_blk_en_3X_090122.png';
const dark =
  'https://weatherkit.apple.com/assets/branding/en/Apple_Weather_wht_en_3X_090122.png';
const credit = {
  serviceName: 'Apple Weather',
  legalPageURL: 'https://weatherkit.apple.com/legal-attribution.html',
  combinedMarkLightURL: light,
  combinedMarkDarkURL: dark,
  legalAttributionText: 'Texte légal Apple complet, sans modification.',
};
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=';
function response(json: string) {
  const request = JSON.parse(json);
  return JSON.stringify({
    schemaVersion: 1,
    requestId: request.requestId,
    sourceURL: request.markURL,
    pngDataURI: png,
    width: 231,
    height: 42,
    rendered: true,
  });
}
let lifecycle: (state: AppStateStatus) => void;
const original = Object.getOwnPropertyDescriptor(AppState, 'currentState')!;
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
  native.renderWeatherAttribution.mockImplementation(async json =>
    response(json),
  );
  native.cancelWeatherAttribution.mockImplementation(async requestId =>
    JSON.stringify({ schemaVersion: 1, requestId, cancelled: true }),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', original);
  jest.useRealTimers();
});
test('official mark and source link remain visible while complete legal text opens and closes independently of image readiness', async () => {
  const ready = jest.fn();
  await renderAsync(
    <WeatherAttribution attribution={credit} onReady={ready} />,
  );
  expect(
    JSON.parse(native.renderWeatherAttribution.mock.calls[0][0]),
  ).toMatchObject({ schemaVersion: 1, appearance: 'light', markURL: light });
  const image = screen.getByLabelText('Marque officielle Apple Weather');
  expect(image).toHaveProp('source', { uri: png });
  expect(image).toHaveStyle({ width: 160, height: (160 * 42) / 231 });
  expect(ready).toHaveBeenLastCalledWith('loading');
  expect(screen.queryByText(credit.legalAttributionText)).not.toBeOnTheScreen();
  const legal = screen.getByRole('button', { name: 'Mentions légales' });
  const sources = screen.getByRole('button', {
    name: 'Sources et attribution Apple',
  });
  expect(legal).toBeCollapsed();
  expect(sources).toBeOnTheScreen();
  const readinessCalls = ready.mock.calls.length;
  const user = userEvent.setup();
  await user.press(legal);
  expect(legal).toBeExpanded();
  expect(screen.getByText(credit.legalAttributionText)).toHaveTextContent(
    credit.legalAttributionText,
    { exact: true, normalizer: value => value },
  );
  expect(image).toBeOnTheScreen();
  expect(sources).toBeOnTheScreen();
  expect(ready).toHaveBeenCalledTimes(readinessCalls);
  expect(ready).not.toHaveBeenCalledWith('ready');
  await user.press(legal);
  expect(legal).toBeCollapsed();
  expect(screen.queryByText(credit.legalAttributionText)).not.toBeOnTheScreen();
  expect(ready).toHaveBeenCalledTimes(readinessCalls);
  await fireEventAsync(image, 'load');
  expect(ready).toHaveBeenLastCalledWith('ready');
  expect(screen.queryByText(credit.legalAttributionText)).not.toBeOnTheScreen();
  const readyCalls = ready.mock.calls.length;
  await user.press(legal);
  await user.press(legal);
  expect(ready).toHaveBeenCalledTimes(readyCalls);
  expect(native.renderWeatherAttribution).toHaveBeenCalledTimes(1);
  expect(native.cancelWeatherAttribution).not.toHaveBeenCalled();
  await user.press(sources);
  expect(Linking.openURL).toHaveBeenCalledWith(credit.legalPageURL);
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  expect(native.finishSpeech).not.toHaveBeenCalled();
});
test('native or final Image failure never declares the branding ready', async () => {
  const ready = jest.fn();
  native.renderWeatherAttribution.mockRejectedValueOnce(
    new Error('raw private error'),
  );
  await renderAsync(
    <WeatherAttribution attribution={credit} onReady={ready} />,
  );
  expect(ready).toHaveBeenLastCalledWith('failed');
  expect(screen.queryByText(/raw private/)).not.toBeOnTheScreen();
  expect(
    screen.queryByLabelText('Marque officielle Apple Weather'),
  ).not.toBeOnTheScreen();
  await userEvent
    .setup()
    .press(
      screen.getByRole('button', { name: 'Recharger la marque officielle' }),
    );
  await fireEventAsync(
    screen.getByLabelText('Marque officielle Apple Weather'),
    'error',
  );
  expect(ready).toHaveBeenLastCalledWith('failed');
  expect(ready).not.toHaveBeenCalledWith('ready');
});
test('malformed URLs and missing native bridge fail before a remote image is created', async () => {
  const ready = jest.fn();
  await renderAsync(
    <WeatherAttribution
      attribution={{
        ...credit,
        combinedMarkLightURL: 'https://evil.test/mark.svg',
      }}
      onReady={ready}
    />,
  );
  expect(native.renderWeatherAttribution).not.toHaveBeenCalled();
  expect(ready).toHaveBeenLastCalledWith('failed');
  await screen.unmountAsync();
  const methods = native as unknown as Record<string, unknown>;
  const previous = methods.renderWeatherAttribution;
  delete methods.renderWeatherAttribution;
  try {
    await renderAsync(
      <WeatherAttribution attribution={credit} onReady={ready} />,
    );
    expect(
      screen.getByRole('button', { name: 'Recharger la marque officielle' }),
    ).toBeDisabled();
  } finally {
    methods.renderWeatherAttribution = previous;
  }
});
test('inactive cancels this request only, rejects late image and never auto-retries on foreground', async () => {
  let resolve!: (value: string) => void;
  native.renderWeatherAttribution.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const ready = jest.fn();
  await renderAsync(
    <WeatherAttribution attribution={credit} onReady={ready} />,
  );
  const json = native.renderWeatherAttribution.mock.calls[0][0];
  const id = JSON.parse(json).requestId;
  await act(async () => {
    lifecycle('inactive');
    lifecycle('active');
    resolve(response(json));
  });
  expect(native.cancelWeatherAttribution).toHaveBeenCalledWith(id);
  expect(native.cancelApplePlaces).not.toHaveBeenCalled();
  expect(native.renderWeatherAttribution).toHaveBeenCalledTimes(1);
  expect(ready).toHaveBeenLastCalledWith('failed');
  expect(
    screen.queryByLabelText('Marque officielle Apple Weather'),
  ).not.toBeOnTheScreen();
});
test('new theme invalidates the old image and requests the actual dark mark rather than recoloring', async () => {
  const ready = jest.fn();
  function Harness() {
    const { setAppearance } = useAppearance();
    return (
      <>
        <ActionButton
          label="Thème sombre"
          onPress={() => setAppearance('graphite')}
        />
        <WeatherAttribution attribution={credit} onReady={ready} />
      </>
    );
  }
  await renderAsync(
    <AppearanceProvider>
      <Harness />
    </AppearanceProvider>,
  );
  await fireEventAsync(
    screen.getByLabelText('Marque officielle Apple Weather'),
    'load',
  );
  expect(ready).toHaveBeenLastCalledWith('ready');
  await userEvent
    .setup()
    .press(screen.getByRole('button', { name: 'Thème sombre' }));
  expect(
    JSON.parse(native.renderWeatherAttribution.mock.calls[1][0]),
  ).toMatchObject({ appearance: 'dark', markURL: dark });
  expect(ready).toHaveBeenLastCalledWith('loading');
  await fireEventAsync(
    screen.getByLabelText('Marque officielle Apple Weather'),
    'load',
  );
  expect(ready).toHaveBeenLastCalledWith('ready');
});
test('changing callback identity does not fetch again and unmount cancels only its correlation ID', async () => {
  const first = jest.fn();
  const second = jest.fn();
  await renderAsync(
    <WeatherAttribution attribution={credit} onReady={first} />,
  );
  const id = JSON.parse(
    native.renderWeatherAttribution.mock.calls[0][0],
  ).requestId;
  await screen.rerenderAsync(
    <WeatherAttribution attribution={credit} onReady={second} />,
  );
  expect(native.renderWeatherAttribution).toHaveBeenCalledTimes(1);
  await fireEventAsync(
    screen.getByLabelText('Marque officielle Apple Weather'),
    'load',
  );
  expect(second).toHaveBeenLastCalledWith('ready');
  await screen.unmountAsync();
  expect(native.cancelWeatherAttribution).toHaveBeenCalledWith(id);
  expect(native.cancelApplePlaces).not.toHaveBeenCalled();
});
