import React from 'react';
import { renderAsync, screen } from '@testing-library/react-native';
import { AssistantScreen } from '../App';
jest.mock('../specs/NativeAssist', () => ({ __esModule: true, default: null }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
test('missing native backend is explicit, with no fake or remote response', async () => {
  await renderAsync(<AssistantScreen />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    /Moteur iOS indisponible/,
  );
  expect(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
});
