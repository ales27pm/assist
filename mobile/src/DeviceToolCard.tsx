import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppearance } from './appearance';
import { DeviceToolTransaction, deviceToolLabels } from './deviceToolProtocol';
import { ActionButton, Disclosure } from './uiPrimitives';
import { uiGrammar } from './uiGrammar';
import { WeatherForecastCard } from './WeatherForecastCard';
import { WeatherPresentationStatus } from './WeatherPresentationGate';

const labels: Record<DeviceToolTransaction['status'], string> = {
  awaiting_confirmation: 'Ton accord est requis',
  awaiting_permission: 'Accès iOS requis',
  executing: 'Exécution en cours',
  success: 'Résultat confirmé',
  failed_safe: 'Action non aboutie',
  outcome_unknown: 'Vérification requise',
  cancelled: 'Action interrompue',
};
export function DeviceToolCard({
  transaction,
  onReview,
  onWeatherReady,
  weatherBlocked,
}: {
  transaction: DeviceToolTransaction;
  onReview?: () => void;
  onWeatherReady?: (status: WeatherPresentationStatus) => void;
  weatherBlocked?: boolean;
}) {
  const {
    theme: { colors },
  } = useAppearance();
  const uncertain = transaction.status === 'outcome_unknown';
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: uncertain ? colors.dangerSurface : colors.surface,
          borderColor: uncertain ? colors.danger : colors.separator,
        },
      ]}
    >
      <Text style={[styles.caption, { color: colors.muted }]}>
        {transaction.effect === 'write'
          ? 'Modification'
          : transaction.effect === 'interactive'
          ? 'Interaction iOS'
          : 'Lecture'}{' '}
        ·{' '}
        {['maps_search', 'maps_directions', 'weather_forecast'].includes(
          transaction.tool,
        )
          ? 'service Apple en ligne'
          : 'sur cet appareil'}
      </Text>
      <Text role="heading" style={[styles.title, { color: colors.text }]}>
        {deviceToolLabels[transaction.tool]}
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        aria-busy={transaction.status === 'executing'}
        style={[
          styles.status,
          { color: uncertain ? colors.danger : colors.text },
        ]}
      >
        {labels[transaction.status]}
      </Text>
      {uncertain && (
        <Text style={[styles.body, { color: colors.danger }]}>
          L’action a peut-être eu lieu. Vérifie dans l’app concernée avant toute
          nouvelle création. Aucun nouvel essai automatique.
        </Text>
      )}
      {transaction.weather && transaction.status === 'success' && (
        <WeatherForecastCard
          forecast={transaction.weather}
          blocked={weatherBlocked}
          onReady={onWeatherReady}
        />
      )}
      {transaction.receipt?.summary.map((field, index) => (
        <Text key={index} style={[styles.body, { color: colors.text }]}>
          {field.label} : {field.value}
        </Text>
      ))}
      {transaction.tool === 'notification_schedule' &&
        transaction.status === 'success' && (
          <Text style={[styles.body, { color: colors.muted }]}>
            Programmation acceptée, pas une preuve de présentation de l’alerte.
          </Text>
        )}
      {['photo_select', 'camera_capture'].includes(transaction.tool) && (
        <Text style={[styles.body, { color: colors.muted }]}>
          OCR Apple sur cet appareil : seul le texte reconnu est transmis à
          Gemma, pas l’image. La reconnaissance peut contenir des erreurs.
        </Text>
      )}
      {onReview &&
        ['awaiting_confirmation', 'awaiting_permission'].includes(
          transaction.status,
        ) && <ActionButton label="Vérifier l’action" onPress={onReview} />}
      <Disclosure title="Détails de l’action" plain>
        {transaction.preview.map((field, index) => (
          <Text
            key={index}
            selectable
            style={[styles.body, { color: colors.text }]}
          >
            {field.label} : {field.value}
          </Text>
        ))}
      </Disclosure>
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: uiGrammar.radius.surface,
    padding: 16,
    gap: uiGrammar.harmony.space.medium,
  },
  caption: { ...uiGrammar.type.caption },
  title: { ...uiGrammar.type.body, fontWeight: '600' },
  status: { ...uiGrammar.type.label, fontWeight: '600' },
  body: { ...uiGrammar.type.body },
});
