import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateCapabilityEvidence} from './verify-ios-capabilities.mjs';

const now = new Date('2026-10-19T12:00:00Z');
function fixture() {
  return {products: ['Assist', 'AssistShare', 'AssistWidget'].map((name, index) => {
    const bundle = `org.27pm.assist${index === 1 ? '.share' : index === 2 ? '.widget' : ''}`;
    const entitlements = {'application-identifier': `TEAM123456.${bundle}`, 'com.apple.developer.team-identifier': 'TEAM123456', 'get-task-allow': false,
      'com.apple.security.application-groups': ['group.org.27pm.assist'], ...(index === 0 ? {'com.apple.developer.weatherkit': true} : {})};
    return {name, signatureVerified: true, entitlements,
      info: {CFBundleIdentifier: bundle, CFBundleVersion: '29', CFBundleShortVersionString: '1.0.0', ...(index === 0 ? {NSAlarmKitUsageDescription: 'Alarmes explicitement créées dans Assist.', NSSupportsLiveActivities: true} : {NSExtension: {NSExtensionPointIdentifier: index === 1 ? 'com.apple.share-services' : 'com.apple.widgetkit-extension'}})},
      profile: {TeamIdentifier: ['TEAM123456'], ApplicationIdentifierPrefix: ['TEAM123456'], Entitlements: structuredClone(entitlements), ExpirationDate: '2027-10-19T12:00:00Z'},
      ...(index === 0 ? {runtimeVersion: '1.0.0-native29', appIntentsMetadataPresent: true} : {})};
  })};
}
test('exact signed product/profile/capability evidence passes without claiming device or Apple acceptance', () => {
  const result = validateCapabilityEvidence(fixture(), {now});
  assert.equal(result.status, 'signed_capabilities_verified');
  assert.equal(result.products.length, 3);
  assert.ok(result.limits.some(value => value.includes('iPhone')));
});
const cases = {
  'missing signature': f => { f.products[0].signatureVerified = false; },
  'missing extension': f => { f.products.pop(); },
  'unknown extension': f => { f.products[2].name = 'Unknown'; },
  'wrong bundle': f => { f.products[0].info.CFBundleIdentifier += '.other'; },
  'old build': f => { f.products[1].info.CFBundleVersion = '28'; },
  'debug app': f => { f.products[0].entitlements['get-task-allow'] = true; },
  'debug profile': f => { f.products[0].profile.Entitlements['get-task-allow'] = true; },
  'ad-hoc profile': f => { f.products[0].profile.ProvisionedDevices = ['device']; },
  'enterprise profile': f => { f.products[0].profile.ProvisionsAllDevices = true; },
  'expired profile': f => { f.products[0].profile.ExpirationDate = '2026-10-18T00:00:00Z'; },
  'missing profile date': f => { delete f.products[0].profile.ExpirationDate; },
  'different team': f => { f.products[1].entitlements['com.apple.developer.team-identifier'] = 'OTHER12345'; },
  'wildcard profile': f => { f.products[0].profile.Entitlements['application-identifier'] = 'TEAM123456.*'; },
  'missing signed weather capability': f => { delete f.products[0].entitlements['com.apple.developer.weatherkit']; },
  'missing weather profile capability': f => { delete f.products[0].profile.Entitlements['com.apple.developer.weatherkit']; },
  'extension weather leakage': f => { f.products[1].entitlements['com.apple.developer.weatherkit'] = true; },
  'missing group profile': f => { f.products[1].profile.Entitlements['com.apple.security.application-groups'] = []; },
  'extra group': f => { f.products[0].entitlements['com.apple.security.application-groups'].push('group.other'); },
  'wrong runtime': f => { f.products[0].runtimeVersion = '1.0.0-native28'; },
  'missing alarm authorization': f => { f.products[0].info.NSAlarmKitUsageDescription = ''; },
  'missing timer support': f => { f.products[0].info.NSSupportsLiveActivities = false; },
  'missing intents metadata': f => { f.products[0].appIntentsMetadataPresent = false; },
  'unrequested health capability': f => { f.products[0].entitlements['com.apple.developer.healthkit'] = true; },
};
for (const [name, mutate] of Object.entries(cases)) test(`fails closed: ${name}`, () => {
  const input = fixture(); mutate(input);
  assert.throws(() => validateCapabilityEvidence(input, {now}));
});
test('CLI refuses absent product evidence with no credential or account mutation', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-ios-capabilities.mjs', import.meta.url)), '--app', '/nonexistent/Assist.app'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED.*No account change/);
  assert.equal(result.stdout, '');
});
