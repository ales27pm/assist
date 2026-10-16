// EAS metadata only. The bare React Native app still registers from app.json.
// No Expo runtime, OTA updates or remote inference is added.
module.exports = {
  name: 'Assist',
  slug: 'assist',
  owner: '27pm',
  version: '1.0.0',
  ios: {bundleIdentifier: 'org.27pm.assist'},
  extra: {eas: {projectId: 'c1a5f806-ff7a-4f65-addd-c5063d9bd31b'}},
};
