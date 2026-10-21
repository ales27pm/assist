import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  Linking,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useAppearance } from './appearance';
import { ActionButton, Disclosure } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import {
  WeatherAttributionData,
  WeatherAttributionStatus,
  WeatherMark,
  parseWeatherAttribution,
  parseWeatherMark,
} from './weatherAttributionProtocol';

type MarkBridge = {
  renderWeatherAttribution(json: string): Promise<string>;
  cancelWeatherAttribution(requestId: string): Promise<string>;
};
const bridge = NativeAssist as Partial<MarkBridge> | null;
/** Shared attribution for manual forecasts and native tool-result cards. */
export function WeatherAttribution({
  attribution,
  blocked = false,
  onReady,
}: {
  attribution: WeatherAttributionData;
  blocked?: boolean;
  onReady: (status: WeatherAttributionStatus) => void;
}) {
  const {
    theme: { colors, isDark },
  } = useAppearance();
  const callback = useRef(onReady);
  callback.current = onReady;
  const mounted = useRef(false);
  const epoch = useRef(0);
  const active = useRef(AppState.currentState === 'active');
  const [foreground, setForeground] = useState(active.current);
  const request = useRef<string | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const [attempt, setAttempt] = useState(0);
  const [mark, setMark] = useState<{ key: string; value: WeatherMark } | null>(
    null,
  );
  const [status, setStatus] = useState<WeatherAttributionStatus>('loading');
  let credit: WeatherAttributionData | null = null;
  try {
    credit = parseWeatherAttribution(attribution);
  } catch {
    /* Invalid data never becomes an image or link. */
  }
  const appearance = isDark ? 'dark' : 'light';
  const markURL = credit
    ? isDark
      ? credit.combinedMarkDarkURL
      : credit.combinedMarkLightURL
    : '';
  const key = `${markURL}:${appearance}`;
  const available =
    Platform.OS === 'ios' &&
    typeof bridge?.renderWeatherAttribution === 'function' &&
    typeof bridge?.cancelWeatherAttribution === 'function';
  function notify(value: WeatherAttributionStatus) {
    setStatus(value);
    callback.current(value);
  }
  function invalidate() {
    ++epoch.current;
    const id = request.current;
    request.current = null;
    if (id && available)
      bridge!.cancelWeatherAttribution!(id).catch(() => undefined);
  }
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      active.current = state === 'active';
      setForeground(active.current);
      if (!active.current) {
        invalidate();
        setMark(null);
        notify('failed');
      }
    });
    return () => {
      mounted.current = false;
      invalidate();
      listener.remove();
    };
    // Lifetime refs fence each native request; no unrelated owner is cancelled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);
  useEffect(() => {
    invalidate();
    setMark(null);
    notify('loading');
    if (!available || blocked || !active.current || !markURL) {
      notify('failed');
      return;
    }
    const id = `mark-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    request.current = id;
    const ticket = epoch.current;
    Promise.resolve()
      .then(() => {
        if (
          !mounted.current ||
          ticket !== epoch.current ||
          !active.current ||
          blockedRef.current
        )
          throw new Error('Stale attribution owner');
        return bridge!.renderWeatherAttribution!(
          JSON.stringify({
            schemaVersion: 1,
            requestId: id,
            markURL,
            appearance,
          }),
        );
      })
      .then(json => {
        if (
          !mounted.current ||
          ticket !== epoch.current ||
          !active.current ||
          blockedRef.current
        )
          return;
        setMark({ key, value: parseWeatherMark(json, id, markURL) });
      })
      .catch(() => {
        if (mounted.current && ticket === epoch.current) notify('failed');
      });
    return invalidate;
    // Parent callback identity must not cause a refetch loop. It lives in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, markURL, appearance, blocked, attempt]);
  const shown = mark?.key === key ? mark.value : null;
  const copy = [styles.copy, { color: colors.muted }];
  return (
    <View style={styles.root}>
      {credit && (
        <>
          <Text style={copy}>{credit.serviceName}</Text>
          {shown && (
            <Image
              key={shown.requestId}
              accessibilityLabel="Marque officielle Apple Weather"
              role="img"
              source={{ uri: shown.pngDataURI }}
              resizeMode="contain"
              style={{
                width: Math.min(shown.width, 160),
                height:
                  (Math.min(shown.width, 160) * shown.height) / shown.width,
              }}
              onLoad={() => {
                if (
                  mounted.current &&
                  request.current === shown.requestId &&
                  active.current &&
                  !blockedRef.current
                )
                  notify('ready');
              }}
              onError={() => {
                if (mounted.current && request.current === shown.requestId)
                  notify('failed');
              }}
            />
          )}
          <ActionButton
            label="Sources et attribution Apple"
            disabled={blocked || !foreground}
            onPress={() => {
              if (!blockedRef.current && active.current)
                Linking.openURL(credit!.legalPageURL).catch(() => {
                  if (mounted.current) notify('failed');
                });
            }}
          />
          <Disclosure title="Mentions légales" plain>
            <Text style={copy}>{credit.legalAttributionText}</Text>
          </Disclosure>
        </>
      )}
      {status === 'loading' && (
        <Text style={copy}>
          Chargement natif de la marque officielle Apple Weather…
        </Text>
      )}
      {status === 'failed' && (
        <Text role="alert" style={[styles.copy, { color: colors.danger }]}>
          Attribution officielle indisponible ou format non pris en charge.
          Aucune marque de remplacement; les données météo restent masquées.
        </Text>
      )}
      {status === 'failed' && (
        <ActionButton
          label="Recharger la marque officielle"
          disabled={!available || blocked || !foreground || !credit}
          onPress={() => setAttempt(value => value + 1)}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { gap: uiGrammar.harmony.space.small },
  copy: { ...uiGrammar.type.caption },
});
