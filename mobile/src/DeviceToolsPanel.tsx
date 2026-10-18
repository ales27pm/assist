import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import * as tools from './deviceCapabilities';
import { useAppearance } from './appearance';
import { scheduleAccessibilityFocus } from './focusAccessibility';
import { ActionButton, Disclosure, ScreenHeading } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';

const capabilityLabels: Record<tools.DeviceCapability, string> = {
  contacts: 'Contacts',
  calendar: 'Calendrier',
  reminders: 'Rappels',
  location: 'Position',
  camera: 'Caméra',
  notifications: 'Notifications',
  biometrics: 'Biométrie',
};
const permissionLabels: Record<tools.PermissionStatus, string> = {
  authorized: 'Autorisé',
  authorizedAlways: 'Toujours autorisé',
  authorizedWhenInUse: 'Autorisé pendant l’utilisation',
  limited: 'Accès limité',
  provisional: 'Provisoire',
  ephemeral: 'Temporaire',
  writeOnly: 'Ajout seulement',
  notDetermined: 'Non demandé',
  denied: 'Refusé',
  restricted: 'Restreint',
  unavailable: 'Indisponible',
};
const methods = [
  'getDeviceCapabilityStatus',
  'requestDeviceCapability',
  'searchContacts',
  'listCalendarEvents',
  'createCalendarEvent',
  'listReminders',
  'createReminder',
  'getCurrentLocation',
  'selectPhoto',
  'capturePhoto',
  'scheduleLocalNotification',
  'getBiometricStatus',
  'authenticateWithBiometrics',
] as const;

function permissionLabel(value: tools.PermissionStatus) {
  return Object.prototype.hasOwnProperty.call(permissionLabels, value)
    ? permissionLabels[value]
    : 'État inconnu';
}

function resultCount(value: unknown) {
  if (!Array.isArray(value) || value.length > 5)
    throw new Error('Invalid result list');
  return value.length;
}

function imageSize(
  value: tools.ImageAttachment,
  source: tools.ImageAttachment['source'],
) {
  if (
    !Number.isSafeInteger(value.byteCount) ||
    value.byteCount <= 0 ||
    value.byteCount > 10 * 1024 * 1024 ||
    value.mediaType !== 'image/jpeg' ||
    value.source !== source ||
    typeof value.uri !== 'string' ||
    !value.uri.startsWith('file://')
  )
    throw new Error('Invalid image receipt');
  return value.byteCount;
}

function validSnapshot(value: tools.CapabilitySnapshot) {
  if (
    !value.capabilities ||
    typeof value.capabilities !== 'object' ||
    Array.isArray(value.capabilities) ||
    !value.boundaries ||
    typeof value.boundaries !== 'object' ||
    Array.isArray(value.boundaries)
  )
    throw new Error('Invalid capability snapshot');
  for (const key of Object.keys(capabilityLabels) as tools.DeviceCapability[]) {
    const item = value.capabilities[key];
    if (key === 'biometrics') {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.available !== 'boolean' ||
        typeof item.type !== 'string'
      )
        throw new Error('Invalid biometric status');
    } else if (
      typeof item !== 'string' ||
      !Object.prototype.hasOwnProperty.call(permissionLabels, item)
    ) {
      throw new Error('Invalid permission status');
    }
  }
  return value;
}

/** Manual bridge qualification only: no model, telemetry, or persisted results. */
export function DeviceToolsPanel({
  onClose,
  blocked = false,
}: {
  onClose: () => void;
  blocked?: boolean;
}) {
  const {
    theme: { colors },
  } = useAppearance();
  const native = NativeAssist;
  const supported =
    Platform.OS === 'ios' &&
    !!native &&
    methods.every(method => typeof native[method] === 'function');
  const [snapshot, setSnapshot] = useState<tools.CapabilitySnapshot | null>(
    null,
  );
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const heading = useRef<React.ComponentRef<typeof Text>>(null);
  const mounted = useRef(true);
  const foreground = useRef(
    AppState.currentState == null || AppState.currentState === 'active',
  );
  const working = useRef(false);
  const observationVersion = useRef(0);
  const confirmation = useRef<object | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const disabled = !supported || blocked || busy || confirming;

  useEffect(() => scheduleAccessibilityFocus(() => heading.current), []);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (state !== 'active') {
        confirmation.current = null;
        setConfirming(false);
      }
      if (state === 'background') {
        observationVersion.current += 1;
        setQuery('');
        setNotice('');
        setError('');
        setSnapshot(null);
      }
    });
    return () => {
      mounted.current = false;
      confirmation.current = null;
      listener.remove();
    };
  }, []);

  function available() {
    return (
      supported &&
      mounted.current &&
      foreground.current &&
      !blockedRef.current &&
      !working.current &&
      !confirmation.current
    );
  }

  async function run(
    operation: (visible: () => boolean) => Promise<string>,
    mutation = false,
  ) {
    if (!available()) return;
    working.current = true; // Ref closes the double-tap window before React renders.
    setBusy(true);
    setError('');
    setNotice('');
    const version = observationVersion.current;
    // Reads expire across backgrounding. Keep static mutation receipts so the
    // user can see an accepted write and does not repeat it inadvertently.
    const visible = () =>
      mounted.current && (mutation || version === observationVersion.current);
    try {
      const result = await operation(visible);
      if (visible()) setNotice(result);
    } catch (cause) {
      if (!visible()) return;
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === 'E_CANCELLED' || code === 'E_BIOMETRIC_AUTH') {
        setNotice(
          'Essai annulé ou refusé. Aucune nouvelle tentative automatique.',
        );
      } else if (mutation) {
        setError(
          'Création non confirmée. Vérifie l’app concernée avant de réessayer : un élément peut avoir été créé.',
        );
      } else {
        // Native error messages may contain private paths or service details.
        setError(
          'L’essai n’a pas abouti. Vérifie l’autorisation et la disponibilité dans les réglages iOS, puis réessaie si tu le souhaites.',
        );
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function confirm(
    title: string,
    details: string,
    operation: () => Promise<string>,
  ) {
    if (!available()) return;
    const ticket = {};
    confirmation.current = ticket;
    setConfirming(true);
    const cancel = () => {
      if (confirmation.current !== ticket) return;
      confirmation.current = null;
      if (mounted.current) setConfirming(false);
    };
    Alert.alert(
      title,
      details,
      [
        { text: 'Annuler', style: 'cancel', onPress: cancel },
        {
          text: 'Créer',
          onPress: () => {
            if (confirmation.current !== ticket) return;
            cancel(); // Consume the exact preview once, even if the callback repeats.
            return run(operation, true);
          },
        },
      ],
      { cancelable: true, onDismiss: cancel },
    );
  }

  function permission(capability: tools.DeviceCapability, label: string) {
    return (
      <ActionButton
        label={label}
        disabled={disabled}
        onPress={() =>
          run(async visible => {
            const result = await tools.requestDeviceCapability(capability);
            if (result.capability !== capability)
              throw new Error('Unexpected capability');
            if (visible()) setSnapshot(null); // Do not present a stale status table.
            return `${capabilityLabels[capability]} : ${permissionLabel(
              result.status,
            )}. Actualise les autorisations pour relire leur état.`;
          })
        }
      />
    );
  }

  function prepareEvent() {
    const startISO = new Date(Date.now() + 5 * 60_000).toISOString();
    const endISO = new Date(Date.parse(startISO) + 30 * 60_000).toISOString();
    const input = { title: 'Test Assist', startISO, endISO };
    confirm(
      'Créer cet événement ?',
      `« Test Assist » dans le calendrier par défaut.\nDébut : ${new Date(
        startISO,
      ).toLocaleString('fr-CA')}\nFin : ${new Date(endISO).toLocaleString(
        'fr-CA',
      )}\nÉvénement réel, sans invitation ni alarme. Supprime-le ensuite dans Calendrier.`,
      async () => {
        const result = await tools.createCalendarEvent(input);
        if (typeof result.id !== 'string' || !result.id)
          throw new Error('Missing creation receipt');
        return 'Événement de test créé. Vérifie « Test Assist » dans Calendrier et supprime-le manuellement après l’essai.';
      },
    );
  }

  function prepareReminder() {
    const dueISO = new Date(Date.now() + 10 * 60_000).toISOString();
    const input = { title: 'Test Assist', dueISO };
    confirm(
      'Créer ce rappel ?',
      `« Test Assist » dans la liste par défaut.\nÉchéance : ${new Date(
        dueISO,
      ).toLocaleString(
        'fr-CA',
      )}\nRappel réel. Supprime-le ensuite dans Rappels.`,
      async () => {
        const result = await tools.createReminder(input);
        if (typeof result.id !== 'string' || !result.id)
          throw new Error('Missing creation receipt');
        return 'Rappel de test créé. Vérifie « Test Assist » dans Rappels et supprime-le manuellement après l’essai.';
      },
    );
  }

  function prepareNotification() {
    // Reuse one test identifier, replacing a pending test rather than accumulating it.
    const input = {
      id: 'assist-device-tools-test',
      title: 'Test Assist',
      body: 'Notification locale de test.',
      timeIntervalSeconds: 60,
    };
    confirm(
      'Programmer cette notification ?',
      '« Test Assist » : « Notification locale de test. »\nUne notification sonore dans 60 secondes après confirmation et autorisation iOS. Un nouvel essai remplace celui encore en attente. La programmation ne garantit pas sa présentation.',
      async () => {
        const result = await tools.scheduleLocalNotification(input);
        if (result.scheduled !== true || result.id !== input.id)
          throw new Error('Missing scheduling receipt');
        return 'Notification de test programmée pour dans 60 secondes. Sa réception et son affichage restent à vérifier sur l’iPhone.';
      },
    );
  }

  return (
    <View style={styles.panel}>
      <ScreenHeading
        title="Outils de l’appareil"
        headingRef={heading}
        description="Tests manuels du PR 2 · panneau v1. Aucun outil n’est encore appelé par Gemma."
      />
      <Text style={[styles.body, { color: colors.muted }]}>
        Chaque bouton déclenche uniquement l’essai indiqué. Les résultats de ce
        panneau ne sont ni enregistrés dans un rapport ni envoyés au modèle. Les
        créations restent dans les apps concernées ; les photos sélectionnées
        sont copiées temporairement par iOS.
      </Text>
      <ActionButton
        label="Fermer les outils"
        disabled={busy || confirming}
        onPress={() => onClose()}
      />
      {!supported && (
        <Text role="alert" style={[styles.body, { color: colors.muted }]}>
          Ces outils nécessitent la version iOS d’Assist avec le pont du PR 2.
          Ils ne sont pas simulés dans l’aperçu navigateur.
        </Text>
      )}
      {blocked && (
        <Text role="status" style={[styles.body, { color: colors.muted }]}>
          Attends la fin de l’opération du modèle avant de tester les outils.
        </Text>
      )}
      {busy && (
        <Text role="status" style={[styles.body, { color: colors.muted }]}>
          Essai en cours… Termine ou annule la demande iOS. Fermer l’écran
          n’annule pas une action déjà acceptée.
        </Text>
      )}
      {!!notice && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.body, { color: colors.text }]}
        >
          {notice}
        </Text>
      )}
      {!!error && (
        <Text role="alert" style={[styles.body, { color: colors.danger }]}>
          {error}
        </Text>
      )}
      <ActionButton
        label="Vérifier les autorisations"
        disabled={disabled}
        onPress={() =>
          run(async visible => {
            setSnapshot(null);
            const result = validSnapshot(
              await tools.getDeviceCapabilityStatus(),
            );
            if (visible()) setSnapshot(result);
            return 'État des autorisations relu sans nouvelle demande d’accès.';
          })
        }
      />
      {snapshot && (
        <View style={styles.results}>
          {Object.entries(capabilityLabels).map(([key, label]) => {
            const value = snapshot.capabilities[key as tools.DeviceCapability];
            const status =
              typeof value === 'string'
                ? permissionLabel(value)
                : value?.available
                ? 'Disponible'
                : 'Indisponible';
            return (
              <Text key={key} style={[styles.body, { color: colors.text }]}>
                {label} : {status}
              </Text>
            );
          })}
          <Text style={[styles.body, { color: colors.muted }]}>
            Un accès refusé se modifie dans les réglages iOS. « Disponible » ne
            prouve pas qu’un essai a réussi.
          </Text>
        </View>
      )}
      <Disclosure
        title="Contacts"
        description="Recherche par nom, cinq résultats maximum."
      >
        {permission('contacts', 'Demander l’accès aux contacts')}
        <TextInput
          accessibilityLabel="Nom à rechercher"
          placeholder="Nom à rechercher"
          placeholderTextColor={colors.placeholder}
          value={query}
          onChangeText={setQuery}
          editable={!disabled}
          maxLength={64}
          autoCorrect={false}
          style={[
            styles.input,
            {
              color: colors.text,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            },
          ]}
        />
        <ActionButton
          label="Rechercher ces contacts"
          disabled={disabled || !query.trim()}
          onPress={() =>
            run(async () => {
              const result = await tools.searchContacts(query.trim(), 5);
              const count = resultCount(result.contacts);
              return `${count} contact${count === 1 ? '' : 's'} trouvé${
                count === 1 ? '' : 's'
              }. Les coordonnées ne sont pas affichées.`;
            })
          }
        />
      </Disclosure>
      <Disclosure
        title="Calendrier"
        description="Lecture limitée et création d’un événement réel après confirmation."
      >
        {permission('calendar', 'Demander l’accès au calendrier')}
        <ActionButton
          label="Lire les événements des prochaines 24 h"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const start = Date.now();
              const result = await tools.listCalendarEvents(
                new Date(start).toISOString(),
                new Date(start + 86_400_000).toISOString(),
                { limit: 5 },
              );
              return `${resultCount(
                result.events,
              )} événement(s) reçu(s), cinq maximum sur les prochaines 24 h. Les titres ne sont pas affichés.`;
            })
          }
        />
        <ActionButton
          label="Préparer un événement de test"
          disabled={disabled}
          onPress={prepareEvent}
        />
      </Disclosure>
      <Disclosure
        title="Rappels"
        description="Rappels non terminés avec échéance dans les prochaines 24 h."
      >
        {permission('reminders', 'Demander l’accès aux rappels')}
        <ActionButton
          label="Lire les rappels des prochaines 24 h"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const start = Date.now();
              const result = await tools.listReminders({
                startISO: new Date(start).toISOString(),
                endISO: new Date(start + 86_400_000).toISOString(),
                includeCompleted: false,
                limit: 5,
              });
              return `${resultCount(
                result.reminders,
              )} rappel(s) reçu(s), cinq maximum sur les prochaines 24 h. Les titres ne sont pas affichés.`;
            })
          }
        />
        <ActionButton
          label="Préparer un rappel de test"
          disabled={disabled}
          onPress={prepareReminder}
        />
      </Disclosure>
      <Disclosure
        title="Position"
        description="Une seule position au premier plan. iOS peut demander l’accès."
      >
        {permission('location', 'Demander l’accès à la position')}
        <ActionButton
          label="Obtenir une position"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const result = await tools.getCurrentLocation();
              if (
                !Number.isFinite(result.latitude) ||
                !Number.isFinite(result.longitude) ||
                Math.abs(result.latitude) > 90 ||
                Math.abs(result.longitude) > 180 ||
                !Number.isFinite(result.horizontalAccuracy) ||
                result.horizontalAccuracy < 0 ||
                typeof result.timestampISO !== 'string' ||
                !Number.isFinite(Date.parse(result.timestampISO))
              )
                throw new Error('Invalid location');
              return `Position reçue. Précision annoncée : environ ${Math.round(
                result.horizontalAccuracy,
              )} m. Mesure : ${new Date(result.timestampISO).toLocaleString(
                'fr-CA',
              )}. Les coordonnées ne sont ni affichées ni conservées par ce panneau.`;
            })
          }
        />
      </Disclosure>
      <Disclosure
        title="Photos et caméra"
        description="Une seule image choisie ou prise par toi, sans envoi au modèle."
      >
        {permission('camera', 'Demander l’accès à la caméra')}
        <ActionButton
          label="Choisir une photo de test"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const result = await tools.selectPhoto();
              return `Photo sélectionnée (${imageSize(
                result,
                'photoLibrary',
              )} octets). Aucun envoi au modèle.`;
            })
          }
        />
        <ActionButton
          label="Prendre une photo de test"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const result = await tools.capturePhoto();
              return `Photo capturée (${imageSize(
                result,
                'camera',
              )} octets). Aucun envoi au modèle.`;
            })
          }
        />
      </Disclosure>
      <Disclosure
        title="Notifications"
        description="Une notification locale réelle, programmée après confirmation."
      >
        {permission('notifications', 'Demander l’accès aux notifications')}
        <ActionButton
          label="Préparer une notification de test"
          disabled={disabled}
          onPress={prepareNotification}
        />
      </Disclosure>
      <Disclosure
        title="Biométrie"
        description="Vérifier la disponibilité, puis essayer Face ID ou Touch ID explicitement."
      >
        <ActionButton
          label="Vérifier la biométrie"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const result = await tools.getBiometricStatus();
              if (typeof result.available !== 'boolean')
                throw new Error('Invalid biometric status');
              return result.available
                ? 'Biométrie disponible. L’authentification n’a pas encore été testée.'
                : 'Biométrie indisponible.';
            })
          }
        />
        <ActionButton
          label="Tester l’authentification biométrique"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const result = await tools.authenticateWithBiometrics(
                'Tester la confirmation biométrique dans Assist.',
              );
              if (result.authenticated !== true)
                throw new Error('Not authenticated');
              return 'Authentification biométrique réussie. Aucun code de l’appareil n’a été demandé en remplacement.';
            })
          }
        />
      </Disclosure>
      <ActionButton
        label="Effacer le résultat affiché"
        disabled={busy || confirming}
        onPress={() => {
          setNotice('');
          setError('');
          setQuery('');
          setSnapshot(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: uiGrammar.harmony.space.large },
  body: { ...uiGrammar.type.body },
  results: { gap: uiGrammar.harmony.space.small },
  input: {
    ...uiGrammar.type.body,
    borderWidth: 1,
    borderRadius: uiGrammar.radius.control,
    paddingHorizontal: uiGrammar.harmony.space.medium,
    paddingVertical: uiGrammar.harmony.space.medium,
    minHeight: uiGrammar.action.height,
  },
});
