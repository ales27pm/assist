import React from 'react';
import { renderAsync, screen } from '@testing-library/react-native';
import { DeviceToolCard } from '../src/DeviceToolCard';
import { applePlacesFailureMessage } from '../src/applePlacesProtocol';
import {
  DeviceToolActivity,
  DeviceToolFailure,
  deviceToolFailureMessage,
  parseDeviceToolActivity,
  toolFailureMessage,
} from '../src/deviceToolProtocol';

function failed(failure: DeviceToolFailure = 'weather_authorization'): DeviceToolActivity {
  return parseDeviceToolActivity(JSON.stringify({
    schemaVersion: 1,
    requestId: 'weather-request',
    transaction: {
      id: 'weather-operation', revision: 3, tool: 'weather_forecast', effect: 'read',
      title: 'Consulter la météo', status: 'failed_safe', preview: [], failure,
    },
  }));
}

test.each<DeviceToolFailure>([
  'apple_network', 'weather_authorization', 'weather_attribution',
  'apple_unavailable', 'invalid_native_result',
])('preserves the closed native failure %s without claiming weather success', failure => {
  const activity = failed(failure);
  expect(activity.transaction.failure).toBe(failure);
  expect(deviceToolFailureMessage([activity])).toBe(toolFailureMessage(failure));
  expect(activity.transaction.weather).toBeUndefined();
  expect(activity.transaction.receipt).toBeUndefined();
});

test.each(['token=PRIVATE_VALUE', '__proto__', 'constructor', {}, 1])(
  'rejects untrusted failure payload %#', failure => {
    const activity = failed();
    expect(() => parseDeviceToolActivity(JSON.stringify({ ...activity,
      transaction: { ...activity.transaction, failure },
    }))).toThrow();
  },
);

test.each(['executing', 'cancelled', 'awaiting_permission'])(
  'does not attach a service failure to %s', status => {
    const activity = failed();
    expect(() => parseDeviceToolActivity(JSON.stringify({ ...activity,
      transaction: { ...activity.transaction, status, capability: 'location' },
    }))).toThrow();
  },
);

test('does not accept weather authorization on a different tool', () => {
  const activity = failed();
  expect(() => parseDeviceToolActivity(JSON.stringify({ ...activity,
    transaction: { ...activity.transaction, tool: 'maps_search' },
  }))).toThrow();
});

test('a later safe failure never hides an uncertain submitted operation', () => {
  const activity = failed();
  const unknown = parseDeviceToolActivity(JSON.stringify({ ...activity,
    transaction: {
      id: 'write-operation', revision: 3, tool: 'calendar_create', effect: 'write',
      title: 'Créer un événement', status: 'outcome_unknown', preview: [],
      receipt: { operationId: 'write-operation', tool: 'calendar_create',
        status: 'outcome_unknown', completedAt: '2026-10-20T04:00:00Z', summary: [] },
    },
  }));
  expect(deviceToolFailureMessage([unknown, activity])).toBeUndefined();
});

test('renders the specific safe error in its action card', async () => {
  await renderAsync(<DeviceToolCard transaction={failed().transaction} />);
  expect(screen.getByText('Action non aboutie')).toBeOnTheScreen();
  expect(screen.getByText(toolFailureMessage('weather_authorization'))).toBeOnTheScreen();
  expect(screen.queryByText('Résultat confirmé')).not.toBeOnTheScreen();
});

test('manual panel only recognizes exact fixed native messages', () => {
  expect(applePlacesFailureMessage(new Error('WeatherKit n’est pas autorisé pour cette build ou ce compte Apple.')))
    .toBe(toolFailureMessage('weather_authorization'));
  for (const cause of [null, 'PRIVATE_TOKEN', new Error('PRIVATE_TOKEN'),
    { message: 'constructor' }, { message: 'Le service Apple n’a pas fourni de résultat utilisable. PRIVATE_TOKEN' },
    { message: { token: 'PRIVATE_TOKEN' } }]) {
    expect(applePlacesFailureMessage(cause)).toBeUndefined();
  }
});
