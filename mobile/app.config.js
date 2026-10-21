module.exports = {
  name: 'Assist',
  slug: 'assist',
  owner: 'ales27',
  version: '1.0.0',
  // Bare native projects require the runtime value to be embedded explicitly.
  runtimeVersion: '1.0.0-native31',
  ios: {infoPlist: {NSAlarmKitUsageDescription: 'Assist programme et gère uniquement les alarmes et minuteurs que tu confirmes.', NSSupportsLiveActivities: true}, entitlements: {'com.apple.developer.weatherkit': true, 'com.apple.security.application-groups': ['group.org.27pm.assist']}},
  updates: {url: 'https://u.expo.dev/0185078d-6c84-4215-8883-4160acf12d22'},
  extra: {eas: {
    projectId: '0185078d-6c84-4215-8883-4160acf12d22',
    build: {experimental: {ios: {appExtensions: [
      {targetName: 'AssistShare', bundleIdentifier: 'org.27pm.assist.share', entitlements: {'com.apple.security.application-groups': ['group.org.27pm.assist']}},
      {targetName: 'AssistWidget', bundleIdentifier: 'org.27pm.assist.widget', entitlements: {'com.apple.security.application-groups': ['group.org.27pm.assist']}},
    ]}}},
  }},
};
