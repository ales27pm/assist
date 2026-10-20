import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppleForecast } from './applePlacesProtocol';
import { useAppearance } from './appearance';
import { WeatherAttribution } from './WeatherAttribution';
import { WeatherPresentationStatus } from './WeatherPresentationGate';
import { uiGrammar } from './uiGrammar';

/** Native-validated evidence only. Model prose never supplies a provider mark. */
export function WeatherForecastCard({
  forecast,
  onReady,
  blocked = false,
}: {
  forecast: AppleForecast;
  onReady?: (status: WeatherPresentationStatus) => void;
  blocked?: boolean;
}) {
  const {
    theme: { colors, isDark },
  } = useAppearance();
  const [readyId, setReadyId] = useState<string | null>(null);
  const presentationId = `${forecast.requestId}:${isDark}`;
  const ready = !blocked && readyId === presentationId;
  const unit = forecast.temperatureUnit === 'celsius' ? '°C' : '°F';
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.separator },
      ]}
    >
      <Text role="heading" style={[styles.heading, { color: colors.text }]}>
        Prévisions Apple Weather
      </Text>
      <WeatherAttribution
        attribution={forecast.attribution}
        blocked={blocked}
        onReady={status => {
          setReadyId(status === 'ready' ? presentationId : null);
          onReady?.(status);
        }}
      />
      {ready && (
        <>
          <Text style={[styles.body, { color: colors.text }]}>
            {forecast.current.temperature.toFixed(1)} {unit} ·{' '}
            {forecast.current.condition}
          </Text>
          <Text style={[styles.caption, { color: colors.muted }]}>
            Conditions datées du{' '}
            {new Date(forecast.current.date).toLocaleString('fr-CA')}.
            Consultation :{' '}
            {new Date(forecast.retrievedAt).toLocaleString('fr-CA')}.
          </Text>
          <Text style={[styles.caption, { color: colors.muted }]}>
            Prévisions, pas une garantie. Coordonnées choisies :{' '}
            {forecast.coordinate.latitude.toFixed(4)},{' '}
            {forecast.coordinate.longitude.toFixed(4)}.
          </Text>
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: uiGrammar.radius.surface,
    padding: 16,
    gap: uiGrammar.harmony.space.small,
  },
  heading: { ...uiGrammar.type.body, fontWeight: '600' },
  body: { ...uiGrammar.type.body },
  caption: { ...uiGrammar.type.caption },
});
