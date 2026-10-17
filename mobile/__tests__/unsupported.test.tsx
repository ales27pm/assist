import React from 'react';
import { renderAsync, screen, userEvent } from '@testing-library/react-native';
import { AssistantScreen } from '../App';
jest.mock('../specs/NativeAssist', () => ({ __esModule: true, default: null }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
test('missing native backend is explicit, with no fake or remote response', async () => {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    /Moteur iOS indisponible/,
  );
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  await user.press(
    screen.getByRole('button', { name: 'Préparer mon assistant' }),
  );
  await user.press(screen.getByRole('button', { name: 'Importer un modèle' }));
  expect(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeDisabled();
  await user.press(
    screen.getByRole('button', { name: 'Retour à la conversation' }),
  );
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
});
