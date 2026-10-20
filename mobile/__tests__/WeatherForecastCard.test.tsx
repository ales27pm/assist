import React from 'react';
import { renderAsync, screen, userEvent } from '@testing-library/react-native';
import { WeatherForecastCard } from '../src/WeatherForecastCard';
import { AppleForecast } from '../src/applePlacesProtocol';
import { AppearanceProvider, useAppearance } from '../src/appearance';

jest.mock('../src/WeatherAttribution', () => {
  const React = require('react');
  const { Text, Pressable } = require('react-native');
  return {
    WeatherAttribution: ({
      onReady,
    }: {
      onReady: (status: string) => void;
    }) => (
      <>
        <Text>Marque du fournisseur</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Marque chargée"
          onPress={() => onReady('ready')}
        >
          <Text>Charger</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Marque en échec"
          onPress={() => onReady('failed')}
        >
          <Text>Échec</Text>
        </Pressable>
      </>
    ),
  };
});
const forecast: AppleForecast = {
  schemaVersion: 1,
  requestId: 'forecast1',
  coordinate: { latitude: 46.8, longitude: -71.2 },
  temperatureUnit: 'celsius',
  retrievedAt: '2026-10-19T12:00:00Z',
  attribution: {
    serviceName: 'Apple Weather',
    legalPageURL: 'https://weatherkit.apple.com/legal-attribution.html',
    combinedMarkLightURL:
      'https://weatherkit.apple.com/assets/branding/en/Apple_Weather_blk_en_3X_090122.png',
    combinedMarkDarkURL:
      'https://weatherkit.apple.com/assets/branding/en/Apple_Weather_wht_en_3X_090122.png',
    legalAttributionText: 'Attribution originale.',
  },
  current: {
    date: '2026-10-19T09:00:00Z',
    temperature: 7.5,
    apparentTemperature: 6,
    condition: 'clear',
    symbolName: 'sun.max',
    humidity: 0.5,
    windKilometersPerHour: 10,
  },
  hourly: [],
  daily: [],
  forecastNotGuarantee: true,
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
test('native forecast values wait for the official mark and preserve evidence timestamps', async () => {
  const ready = jest.fn();
  await renderAsync(
    <WeatherForecastCard forecast={forecast} onReady={ready} />,
  );
  expect(screen.queryByText(/7.5 °C/)).not.toBeOnTheScreen();
  const user = userEvent.setup();
  await user.press(screen.getByRole('button', { name: 'Marque chargée' }));
  expect(screen.getByText(/7.5 °C/)).toBeOnTheScreen();
  expect(screen.getByText(/Conditions datées du/)).toHaveTextContent(
    /Consultation/,
  );
  expect(ready).toHaveBeenLastCalledWith('ready');
  await user.press(screen.getByRole('button', { name: 'Marque en échec' }));
  expect(screen.queryByText(/7.5 °C/)).not.toBeOnTheScreen();
});
test('a new native forecast identity cannot reuse the previous presentation approval', async () => {
  await renderAsync(<WeatherForecastCard forecast={forecast} />);
  const user = userEvent.setup();
  await user.press(screen.getByRole('button', { name: 'Marque chargée' }));
  await screen.rerenderAsync(
    <WeatherForecastCard forecast={{ ...forecast, requestId: 'forecast2' }} />,
  );
  expect(screen.queryByText(/7.5 °C/)).not.toBeOnTheScreen();
});
test('changing theme immediately withdraws data until that official variant loads', async () => {
  function Case() {
    const { setAppearance } = useAppearance();
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Thème sombre"
          onPress={() => setAppearance('graphite')}
        >
          <Text>Sombre</Text>
        </Pressable>
        <WeatherForecastCard forecast={forecast} />
      </>
    );
  }
  await renderAsync(
    <AppearanceProvider>
      <Case />
    </AppearanceProvider>,
  );
  const user = userEvent.setup();
  await user.press(screen.getByRole('button', { name: 'Marque chargée' }));
  expect(screen.getByText(/7.5 °C/)).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Thème sombre' }));
  expect(screen.queryByText(/7.5 °C/)).not.toBeOnTheScreen();
});
