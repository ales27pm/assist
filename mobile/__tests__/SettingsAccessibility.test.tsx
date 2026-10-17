import React from 'react';
import {
  AccessibilityInfo,
  InputAccessoryView,
  Keyboard,
  Platform,
  View,
} from 'react-native';
import {
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AppearanceProvider, useAppearance } from '../src/appearance';
import { SettingsScreen } from '../src/SettingsScreen';
import { SettingsRow } from '../src/uiPrimitives';

function settings(
  extra: Partial<React.ComponentProps<typeof SettingsScreen>> = {},
) {
  return (
    <SettingsScreen
      modelStatus="À configurer"
      budget=""
      budgetError=""
      busy={false}
      responseOpen={false}
      onToggleResponse={jest.fn()}
      onBudgetChange={jest.fn()}
      onModel={jest.fn()}
      onAppearance={jest.fn()}
      appearanceRef={React.createRef<React.ComponentRef<typeof View>>()}
      {...extra}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('setting actions keep their names and expose updated native values', async () => {
  const user = userEvent.setup();
  const onModel = jest.fn();
  const onToggleResponse = jest.fn();
  function ChangingAppearance() {
    const { setAppearance } = useAppearance();
    return settings({
      budget: '2048',
      onModel,
      onToggleResponse,
      onAppearance: () => setAppearance('graphite'),
    });
  }
  await renderAsync(
    <AppearanceProvider>
      <ChangingAppearance />
    </AppearanceProvider>,
  );

  expect(screen.getByRole('button', { name: 'Modèle' })).toHaveAccessibilityValue({
    text: 'À configurer',
  });
  expect(screen.getByRole('button', { name: 'Réponse' })).toHaveAccessibilityValue({
    text: '2048 jetons',
  });
  expect(
    screen.getByRole('button', { name: 'Apparence' }),
  ).toHaveAccessibilityValue({ text: 'Natif clair' });
  await user.press(screen.getByRole('button', { name: 'Apparence' }));
  expect(
    screen.getByRole('button', { name: 'Apparence' }),
  ).toHaveAccessibilityValue({ text: 'Graphite' });
  await user.press(screen.getByRole('button', { name: 'Modèle' }));
  await user.press(screen.getByRole('button', { name: 'Réponse' }));
  expect(onModel).toHaveBeenCalledTimes(1);
  expect(onToggleResponse).toHaveBeenCalledTimes(1);
});

test('web setting descriptions point to each current visible value and detail', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const onPress = jest.fn();
  const { rerenderAsync } = await renderAsync(
    <SettingsRow
      label="Modèle"
      value="À configurer"
      detail="Choisis un modèle local."
      onPress={onPress}
      stacked
    />,
  );
  expect(screen.getByRole('button', { name: 'Modèle' })).toHaveProp(
    'aria-describedby',
    expect.any(String),
  );
  const descriptionIds = screen
    .getByRole('button', { name: 'Modèle' })
    .props['aria-describedby'].split(' ');
  expect(descriptionIds).toEqual([
    screen.getByText('À configurer').props.nativeID,
    screen.getByText('Choisis un modèle local.').props.nativeID,
  ]);
  expect(descriptionIds.every(Boolean)).toBe(true);

  await rerenderAsync(
    <SettingsRow label="Modèle" value="Prêt" onPress={onPress} />,
  );
  expect(screen.getByRole('button', { name: 'Modèle' })).toHaveProp(
    'aria-describedby',
    screen.getByText('Prêt').props.nativeID,
  );
  expect(screen.getByText('Prêt').props.nativeID).toBe(descriptionIds[0]);
  expect(screen.queryByText('Choisis un modèle local.')).not.toBeOnTheScreen();
});

test('web budget descriptions include the active error and remove the association after correction', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const message = 'Entre une limite entière supérieure à zéro.';
  const { rerenderAsync } = await renderAsync(
    settings({ budget: '0', budgetError: message, responseOpen: true }),
  );
  const input = screen.getByLabelText('Limite de réponse · facultatif');
  const hintId = screen.getByText(
    'En jetons (fragments de mots). Vide : contexte restant.',
  ).props.nativeID;
  const errorId = screen.getByRole('alert').props.nativeID;
  expect(hintId).toBeTruthy();
  expect(errorId).toBeTruthy();
  expect(input).toHaveProp('aria-describedby', `${hintId} ${errorId}`);
  expect(input).toHaveProp('aria-invalid', true);
  expect(screen.getByRole('button', { name: 'Réponse' })).toHaveProp(
    'aria-describedby',
    `${screen.getByText('À corriger').props.nativeID} ${errorId}`,
  );

  await rerenderAsync(settings({ budget: '1024', responseOpen: true }));
  expect(screen.getByLabelText('Limite de réponse · facultatif')).toHaveProp(
    'aria-describedby',
    hintId,
  );
  expect(screen.queryByRole('alert')).not.toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Réponse' })).toHaveProp(
    'aria-describedby',
    screen.getByText('1024 jetons').props.nativeID,
  );
});

test('budget description IDs belong to their own screen instance', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  await renderAsync(
    <View>
      {settings({ responseOpen: true })}
      {settings({ responseOpen: true })}
    </View>,
  );
  const inputs = screen.getAllByLabelText('Limite de réponse · facultatif');
  expect(inputs).toHaveLength(2);
  expect(inputs[0].props['aria-describedby']).not.toBe(
    inputs[1].props['aria-describedby'],
  );
});

test('native model and validation updates announce once while retaining focus-readable context', async () => {
  const announcement = jest.spyOn(
    AccessibilityInfo,
    'announceForAccessibilityWithOptions',
  );
  const message = 'Entre une limite entière supérieure à zéro.';
  const { rerenderAsync } = await renderAsync(settings({ responseOpen: true }));
  expect(announcement).not.toHaveBeenCalled();

  await rerenderAsync(
    settings({
      modelStatus: 'Prêt',
      budget: '0',
      budgetError: message,
      responseOpen: true,
      voiceAvailable: false,
    }),
  );
  expect(announcement).toHaveBeenCalledTimes(1);
  expect(announcement).toHaveBeenCalledWith(
    `Modèle. Prêt. Limite de réponse. ${message}`,
    { priority: 'low' },
  );
  expect(screen.getByRole('button', { name: 'Réponse' })).toHaveProp(
    'accessibilityHint',
    message,
  );
  expect(screen.getByLabelText('Limite de réponse · facultatif')).toHaveProp(
    'accessibilityHint',
    `En jetons (fragments de mots). Vide : contexte restant. ${message}`,
  );
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).toHaveProp(
    'accessibilityHint',
    'Voix locale indisponible. Tu peux désactiver la lecture automatique.',
  );
  await rerenderAsync(
    settings({
      modelStatus: 'Prêt',
      budget: '00',
      budgetError: message,
      responseOpen: true,
    }),
  );
  expect(announcement).toHaveBeenCalledTimes(1);
});

test('the iOS numeric budget has an associated Done action that dismisses without changing the value', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  const onBudgetChange = jest.fn();
  const user = userEvent.setup();
  await renderAsync(
    settings({ responseOpen: true, budget: '2048', onBudgetChange }),
  );
  const input = screen.getByLabelText('Limite de réponse · facultatif');
  // This native component is the public association boundary for the keyboard.
  const accessory = screen.UNSAFE_getByType(InputAccessoryView);
  expect(accessory.props.nativeID).toBeTruthy();
  expect(input).toHaveProp('inputAccessoryViewID', accessory.props.nativeID);
  const done = screen.getByRole('button', { name: 'Terminé' });
  expect(done).toHaveStyle({ minHeight: 44, minWidth: 44 });
  expect(dismiss).not.toHaveBeenCalled();
  await user.press(done);
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(onBudgetChange).not.toHaveBeenCalled();
  expect(input).toHaveDisplayValue('2048');
});

test.each(['web', 'android'] as const)(
  '%s retains the budget input without an iOS keyboard accessory',
  async platform => {
    jest.replaceProperty(Platform, 'OS', platform);
    await renderAsync(settings({ responseOpen: true }));
    expect(screen.queryByRole('button', { name: 'Terminé' })).not.toBeOnTheScreen();
    expect(screen.getByLabelText('Limite de réponse · facultatif')).not.toHaveProp(
      'inputAccessoryViewID',
      expect.any(String),
    );
  },
);
