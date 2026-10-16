// EAS metadata only. The bare React Native app still registers from app.json.
// No Expo runtime, OTA updates or remote inference is added.
module.exports = {
  name: 'Assist',
  slug: 'assist',
  owner: 'ales27',
  version: '1.0.0',
  ios: {bundleIdentifier: 'org.27pm.assist'},
  extra: {eas: {projectId: '0185078d-6c84-4215-8883-4160acf12d22'}},
};
