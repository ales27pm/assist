import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useAppearance } from './appearance';
import { ActionButton, SurfaceGroup } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import {
  AppleDirections,
  AppleDirectionsRequest,
  AppleForecast,
  AppleForecastRequest,
  ApplePlace,
  AppleSearch,
  parseAppleCancellation,
  parseAppleDirections,
  parseAppleForecast,
  parseAppleOpenReceipt,
  parseApplePlacesStatus,
  parseAppleSearch,
  validAppleQuery,
  applePlacesFailureMessage,
} from './applePlacesProtocol';
import { WeatherAttribution } from './WeatherAttribution';
import { WeatherAttributionStatus } from './weatherAttributionProtocol';

type PlacesBridge = {
  getApplePlacesStatus(): Promise<string>;
  searchApplePlaces(json: string): Promise<string>;
  getAppleDirections(json: string): Promise<string>;
  getAppleForecast(json: string): Promise<string>;
  openApplePlace(requestId: string, resultId: string): Promise<string>;
  cancelApplePlaces(): Promise<string>;
};
const methods: (keyof PlacesBridge)[] = [
  'getApplePlacesStatus',
  'searchApplePlaces',
  'getAppleDirections',
  'getAppleForecast',
  'openApplePlace',
  'cancelApplePlaces',
];
const bridge = NativeAssist as Partial<PlacesBridge> | null;
// Correlation only. This is not a credential, consent ticket or operation permit.
function newRequestId() {
  return `places-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Explicit controls only; no result is sent to Gemma or the private gateway. */
export function ApplePlacesPanel({ blocked }: { blocked: boolean }) {
  const {
    theme: { colors, isDark },
  } = useAppearance();
  const available =
    Platform.OS === 'ios' &&
    methods.every(method => typeof bridge?.[method] === 'function');
  const mounted = useRef(false);
  const foreground = useRef(AppState.currentState === 'active');
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const epoch = useRef(0);
  const busy = useRef(false);
  const cancelling = useRef(false);
  const cancellationRequired = useRef(false);
  const metadataNeeded = useRef(true);
  const [active, setActive] = useState(foreground.current);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [needsCancellation, setNeedsCancellation] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<AppleSearch | null>(null);
  const [origin, setOrigin] = useState<ApplePlace | null>(null);
  const [destination, setDestination] = useState<ApplePlace | null>(null);
  const [transport, setTransport] = useState<'walking' | 'automobile'>(
    'walking',
  );
  const [directions, setDirections] = useState<AppleDirections | null>(null);
  const [forecast, setForecast] = useState<AppleForecast | null>(null);
  const [logo, setLogo] = useState<{
    key: string;
    state: WeatherAttributionStatus;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function current(ticket: number) {
    return (
      mounted.current &&
      foreground.current &&
      !blockedRef.current &&
      epoch.current === ticket
    );
  }
  function invalidate() {
    ++epoch.current;
  }
  function purge() {
    setQuery('');
    setSearch(null);
    setOrigin(null);
    setDestination(null);
    setDirections(null);
    setForecast(null);
    setLogo(null);
    setNotice(null);
  }
  async function cancel() {
    if (!available || cancelling.current) return;
    const ticket = ++epoch.current; // Fence callbacks before the native await.
    cancelling.current = true;
    cancellationRequired.current = true;
    busy.current = true;
    if (mounted.current) {
      purge();
      setNeedsCancellation(true);
      setPending('Interruption…');
    }
    try {
      parseAppleCancellation(await bridge!.cancelApplePlaces!());
      if (!mounted.current || epoch.current !== ticket) return;
      cancellationRequired.current = false;
      if (mounted.current) {
        setNeedsCancellation(false);
        setNotice(
          'Cartes et Météo interrompus. Fais un nouveau choix pour continuer.',
        );
      }
    } catch {
      if (mounted.current && epoch.current === ticket)
        setError(
          'Annulation non confirmée. Interromps Cartes et Météo à nouveau avant de continuer.',
        );
    } finally {
      if (mounted.current && epoch.current === ticket) {
        cancelling.current = false;
        busy.current = false;
        setPending(null);
      }
    }
  }
  async function run(
    label: string,
    action: (isCurrent: () => boolean) => Promise<void>,
  ) {
    if (
      !available ||
      busy.current ||
      cancellationRequired.current ||
      blockedRef.current ||
      !foreground.current
    )
      return;
    busy.current = true;
    const ticket = ++epoch.current;
    setPending(label);
    setError(null);
    setNotice(null);
    try {
      await action(() => current(ticket));
    } catch (cause) {
      if (current(ticket)) {
        setSearch(null);
        setDirections(null);
        setForecast(null);
        setError(
          applePlacesFailureMessage(cause) ??
          'Cartes ou Météo indisponible, non autorisé ou réponse incompatible. Aucun ancien résultat réutilisé.',
        );
      }
    } finally {
      if (mounted.current && epoch.current === ticket) {
        busy.current = false;
        setPending(null);
      }
    }
  }
  async function status(isCurrent: () => boolean) {
    metadataNeeded.current = false;
    setReady(false);
    const json = await bridge!.getApplePlacesStatus!();
    if (!isCurrent()) return;
    parseApplePlacesStatus(json);
    setReady(true);
  }
  useEffect(() => {
    mounted.current = true;
    // React Strict Mode may replay this effect on the same ref instances. The
    // cleanup already revoked/cancelled the prior owner; old callbacks retain
    // their old epoch and cannot release a newly mounted owner's lock.
    busy.current = false;
    cancelling.current = false;
    cancellationRequired.current = false;
    metadataNeeded.current = true;
    setPending(null);
    setNeedsCancellation(false);
    setReady(false);
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      setActive(foreground.current);
      if (!foreground.current) {
        metadataNeeded.current = true;
        setReady(false);
        cancel();
      }
    });
    return () => {
      mounted.current = false;
      invalidate();
      listener.remove();
      // Cancel only this child's native owner, never Ubuntu, Gemma or documents.
      if (available) bridge!.cancelApplePlaces!().catch(() => undefined);
    };
    // A return to foreground never repeats a search, route or weather query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);
  useEffect(() => {
    if (blocked && available) {
      metadataNeeded.current = true;
      setReady(false);
      cancel();
    }
    // blockedRef is checked synchronously by callbacks and action handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, available]);
  useEffect(() => {
    // Parent startup/research may temporarily block this child. Once its own
    // cancellation is acknowledged, perform one metadata-only handshake, not
    // an automatic retry of a failed handshake or a replay of a user query.
    if (
      available &&
      !blocked &&
      active &&
      !pending &&
      !needsCancellation &&
      metadataNeeded.current
    )
      run('Statut Apple…', status);
    // run/status intentionally read current refs, not captured permission data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, blocked, active, pending, needsCancellation]);

  const disabled =
    !available ||
    !ready ||
    blocked ||
    !active ||
    !!pending ||
    needsCancellation;
  const copy = [styles.copy, { color: colors.text }];
  const muted = [styles.caption, { color: colors.muted }];
  function searchPlaces() {
    if (!validAppleQuery(query)) return;
    const request = {
      schemaVersion: 1,
      requestId: newRequestId(),
      query: query.trim(),
      limit: 5,
    };
    run('Recherche dans Plans…', async isCurrent => {
      setSearch(null);
      setForecast(null);
      setDirections(null);
      const json = await bridge!.searchApplePlaces!(JSON.stringify(request));
      if (isCurrent()) setSearch(parseAppleSearch(json, request.requestId));
    });
  }
  function weather(place: ApplePlace) {
    const request: AppleForecastRequest = {
      schemaVersion: 1,
      requestId: newRequestId(),
      coordinate: place.coordinate,
      unit: 'celsius',
      hourlyCount: 12,
      dailyCount: 5,
    };
    run('Prévisions WeatherKit…', async isCurrent => {
      setSearch(null);
      setDirections(null);
      setForecast(null);
      setLogo(null);
      const json = await bridge!.getAppleForecast!(JSON.stringify(request));
      if (isCurrent()) setForecast(parseAppleForecast(json, request));
    });
  }
  function calculateDirections() {
    if (!origin || !destination) return;
    const request: AppleDirectionsRequest = {
      schemaVersion: 1,
      requestId: newRequestId(),
      origin: origin.coordinate,
      destination: destination.coordinate,
      transport,
    };
    run('Calcul du trajet…', async isCurrent => {
      setSearch(null);
      setForecast(null);
      setDirections(null);
      const json = await bridge!.getAppleDirections!(JSON.stringify(request));
      if (isCurrent()) setDirections(parseAppleDirections(json, request));
    });
  }
  const markKey = forecast ? `${forecast.requestId}-${isDark}` : '';
  const markState = logo?.key === markKey ? logo.state : 'loading';
  return (
    <SurfaceGroup title="Cartes et météo Apple">
      <View style={styles.body}>
        <Text style={copy}>
          Cherche un lieu avec sa ville. Aucun GPS automatique, aucune donnée
          envoyée à Gemma.
        </Text>
        <Text style={muted}>
          WeatherKit exige une build signée et autorisée. La météo sur cet
          appareil et le rendu de la marque Apple ne sont pas encore qualifiés.
        </Text>
        {!available && (
          <Text style={muted}>
            Ces fonctions nécessitent le nouveau binaire natif; une OTA seule ne
            les ajoute pas.
          </Text>
        )}
        {blocked && (
          <Text style={muted}>
            Termine l’opération Assist avant d’utiliser Cartes et Météo.
          </Text>
        )}
        {!active && (
          <Text style={muted}>
            Reviens dans Assist puis fais un nouveau choix.
          </Text>
        )}
        <ActionButton
          label="Vérifier Cartes et Météo"
          disabled={
            !available || blocked || !active || !!pending || needsCancellation
          }
          onPress={() => run('Statut Apple…', status)}
        />
        <TextInput
          accessibilityLabel="Lieu et ville à rechercher"
          value={query}
          onChangeText={setQuery}
          placeholder="Ex. Bibliothèque Gabrielle-Roy, Québec"
          placeholderTextColor={colors.placeholder}
          editable={!disabled}
          maxLength={256}
          style={[
            styles.input,
            { color: colors.text, borderColor: colors.border },
          ]}
        />
        <ActionButton
          label="Rechercher le lieu dans Plans"
          primary
          disabled={disabled || !validAppleQuery(query)}
          onPress={searchPlaces}
        />
        <ActionButton
          label="Interrompre Cartes et Météo"
          disabled={
            !available || cancelling.current || (!pending && !needsCancellation)
          }
          onPress={cancel}
        />
        {pending && (
          <Text role="status" style={copy}>
            {pending}
          </Text>
        )}
        {error && (
          <Text role="alert" style={[styles.copy, { color: colors.danger }]}>
            {error}
          </Text>
        )}
        {notice && (
          <Text role="status" style={copy}>
            {notice}
          </Text>
        )}
        {search && (
          <View style={styles.stack}>
            <Text style={copy}>
              {search.results.length
                ? 'Résultats Apple Maps'
                : 'Aucun lieu trouvé. Précise la ville.'}
            </Text>
            {search.truncated && (
              <Text style={muted}>
                Liste limitée; elle n’est pas exhaustive.
              </Text>
            )}
            {search.results.map((place, index) => {
              const label = place.name || `Lieu ${index + 1}`;
              return (
                <View
                  key={place.id}
                  style={[styles.place, { borderColor: colors.separator }]}
                >
                  <Text
                    style={[styles.copy, styles.strong, { color: colors.text }]}
                  >
                    {label}
                  </Text>
                  <Text style={muted}>{place.address}</Text>
                  <ActionButton
                    label={`Départ : ${label}`}
                    disabled={disabled}
                    onPress={() => {
                      setOrigin(place);
                      setDirections(null);
                    }}
                  />
                  <ActionButton
                    label={`Destination : ${label}`}
                    disabled={disabled}
                    onPress={() => {
                      setDestination(place);
                      setDirections(null);
                    }}
                  />
                  <ActionButton
                    label={`Météo : ${label}`}
                    disabled={disabled}
                    onPress={() => weather(place)}
                  />
                  <ActionButton
                    label={`Ouvrir Plans : ${label}`}
                    disabled={disabled}
                    onPress={() =>
                      run('Ouverture de Plans…', async isCurrent => {
                        const json = await bridge!.openApplePlace!(
                          search.requestId,
                          place.id,
                        );
                        if (isCurrent())
                          setNotice(
                            parseAppleOpenReceipt(json)
                              ? 'Plans a accepté l’ouverture du lieu. Aucun guidage lancé.'
                              : 'Plans n’a pas accepté l’ouverture.',
                          );
                      })
                    }
                  />
                </View>
              );
            })}
          </View>
        )}
        <Text style={copy}>
          Départ : {origin?.name || 'à choisir dans les résultats'}
        </Text>
        <Text style={copy}>
          Destination : {destination?.name || 'à choisir dans les résultats'}
        </Text>
        <ActionButton
          label={`À pied${transport === 'walking' ? ' · choisi' : ''}`}
          disabled={disabled}
          onPress={() => {
            setTransport('walking');
            setDirections(null);
          }}
        />
        <ActionButton
          label={`En auto${transport === 'automobile' ? ' · choisi' : ''}`}
          disabled={disabled}
          onPress={() => {
            setTransport('automobile');
            setDirections(null);
          }}
        />
        <ActionButton
          label="Estimer le trajet entre les lieux choisis"
          disabled={disabled || !origin || !destination}
          onPress={calculateDirections}
        />
        {directions && (
          <View style={styles.stack}>
            <Text style={copy}>
              Trajet estimé : {(directions.distanceMeters / 1000).toFixed(1)} km
              · {Math.ceil(directions.expectedTravelSeconds / 60)} min
            </Text>
            <Text style={muted}>
              Apple Maps ·{' '}
              {new Date(directions.calculatedAt).toLocaleString('fr-CA')} ·
              estimation, sans démarrer de navigation.
            </Text>
          </View>
        )}
        {forecast && (
          <View style={styles.stack}>
            <Text style={muted}>
              Lieu choisi : {forecast.coordinate.latitude.toFixed(4)},{' '}
              {forecast.coordinate.longitude.toFixed(4)}. Heures affichées dans
              le fuseau de l’appareil.
            </Text>
            <WeatherAttribution
              attribution={forecast.attribution}
              blocked={disabled}
              onReady={state => setLogo({ key: markKey, state })}
            />
            {markState === 'ready' && (
              <>
                <Text style={copy}>
                  Maintenant : {forecast.current.temperature.toFixed(1)} °C ·{' '}
                  {forecast.current.condition}
                </Text>
                <Text style={muted}>
                  Ressenti {forecast.current.apparentTemperature.toFixed(1)} °C
                  · vent {forecast.current.windKilometersPerHour.toFixed(0)}{' '}
                  km/h
                </Text>
                <Text style={muted}>
                  Prévisions, pas une garantie. Consultation :{' '}
                  {new Date(forecast.retrievedAt).toLocaleString('fr-CA')}.
                </Text>
                <Text style={muted}>
                  Conditions datées du{' '}
                  {new Date(forecast.current.date).toLocaleString('fr-CA')}.
                </Text>
                {forecast.hourly.map(hour => (
                  <Text key={hour.date} style={muted}>
                    {new Date(hour.date).toLocaleTimeString('fr-CA', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {hour.temperature.toFixed(1)} °C · précip.{' '}
                    {Math.round(hour.precipitationChance * 100)} %
                  </Text>
                ))}
                {forecast.daily.map(day => (
                  <Text key={day.date} style={muted}>
                    {new Date(day.date).toLocaleDateString('fr-CA')} ·{' '}
                    {day.lowTemperature.toFixed(1)} à{' '}
                    {day.highTemperature.toFixed(1)} °C
                  </Text>
                ))}
              </>
            )}
          </View>
        )}
      </View>
    </SurfaceGroup>
  );
}
const styles = StyleSheet.create({
  body: {
    padding: uiGrammar.harmony.space.large,
    gap: uiGrammar.harmony.space.medium,
  },
  stack: { gap: uiGrammar.harmony.space.small },
  copy: { ...uiGrammar.type.body },
  caption: { ...uiGrammar.type.caption },
  strong: { fontWeight: '600' },
  input: {
    ...uiGrammar.type.body,
    borderWidth: 1,
    borderRadius: uiGrammar.radius.control,
    minHeight: uiGrammar.touchTarget,
    padding: uiGrammar.harmony.space.medium,
  },
  place: {
    borderTopWidth: 1,
    paddingTop: uiGrammar.harmony.space.medium,
    gap: uiGrammar.harmony.space.small,
  },
});
