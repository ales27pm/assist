#!/usr/bin/env node
// Read-only signed-product gate. Never creates/repairs certificates or profiles.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {lstatSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'mobile/package.json'));
const plist = require('plist');
const group = 'group.org.27pm.assist';
const products = [
  {name: 'Assist', bundle: 'org.27pm.assist'},
  {name: 'AssistShare', bundle: 'org.27pm.assist.share'},
  {name: 'AssistWidget', bundle: 'org.27pm.assist.widget'},
];
function exactGroups(value) { assert.deepEqual(value, [group], 'App Group differs from the compiled closed contract'); }

export function validateCapabilityEvidence(evidence, {buildNumber = '29', now = new Date()} = {}) {
  assert.ok(evidence && Array.isArray(evidence.products), 'Missing signed product evidence');
  assert.equal(evidence.products.length, products.length, 'Both signed extensions are required');
  assert.ok(Number.isFinite(now.getTime()), 'Invalid verification clock');
  let commonTeam;
  const summaries = products.map(expected => {
    const rows = evidence.products.filter(row => row?.name === expected.name);
    assert.equal(rows.length, 1, 'Unknown or duplicate signed product');
    const {info, entitlements: signed, profile, signatureVerified} = rows[0];
    assert.equal(signatureVerified, true, 'codesign verification required for each product');
    assert.equal(info?.CFBundleIdentifier, expected.bundle, 'Signed bundle identity mismatch');
    assert.equal(String(info.CFBundleVersion), String(buildNumber), 'Signed build number mismatch');
    assert.equal(info.CFBundleShortVersionString, '1.0.0', 'Signed marketing version mismatch');
    const team = signed?.['com.apple.developer.team-identifier'];
    assert.match(team ?? '', /^[A-Z0-9]{10}$/, 'Missing signed team identity');
    commonTeam ??= team;
    assert.equal(team, commonTeam, 'Products are signed by different teams');
    assert.deepEqual(profile?.TeamIdentifier, [team], 'Profile team does not bind signed product');
    assert.ok(Array.isArray(profile.ApplicationIdentifierPrefix) && profile.ApplicationIdentifierPrefix.length === 1, 'Missing unambiguous profile App ID prefix');
    const prefix = profile.ApplicationIdentifierPrefix[0];
    assert.match(prefix, /^[A-Z0-9]{10}$/, 'Invalid App ID prefix');
    const applicationID = `${prefix}.${expected.bundle}`;
    assert.equal(signed['application-identifier'], applicationID, 'Signed App ID mismatch');
    assert.equal(profile.Entitlements?.['application-identifier'], applicationID, 'Profile must explicitly bind bundle; wildcard not accepted');
    assert.equal(profile.Entitlements?.['com.apple.developer.team-identifier'], team, 'Profile entitlement team mismatch');
    assert.equal(signed['get-task-allow'], false, 'Debug signing is not a TestFlight candidate');
    assert.equal(profile.Entitlements['get-task-allow'], false, 'Debug provisioning is not a TestFlight candidate');
    assert.equal(profile.ProvisionedDevices, undefined, 'Development/ad-hoc profile is not an App Store profile');
    assert.equal(profile.ProvisionsAllDevices, undefined, 'Enterprise profile is not an App Store profile');
    const expiry = new Date(profile.ExpirationDate);
    assert.ok(Number.isFinite(expiry.getTime()) && expiry > now, 'Profile missing or expired');
    exactGroups(signed['com.apple.security.application-groups']);
    exactGroups(profile.Entitlements['com.apple.security.application-groups']);
    for (const key of ['com.apple.developer.healthkit', 'com.apple.developer.homekit', 'com.apple.developer.networking.networkextension']) {
      assert.equal(signed[key], undefined, 'Unexpected sensitive capability in candidate');
    }
    if (expected.name === 'Assist') {
      assert.equal(signed['com.apple.developer.weatherkit'], true, 'WeatherKit absent from signed app');
      assert.equal(profile.Entitlements['com.apple.developer.weatherkit'], true, 'WeatherKit absent from provisioning profile');
      assert.equal(rows[0].runtimeVersion, `1.0.0-native${buildNumber}`, 'Signed embedded OTA runtime mismatch');
      assert.ok(typeof info.NSAlarmKitUsageDescription === 'string' && info.NSAlarmKitUsageDescription.trim(), 'Missing alarm authorization purpose');
      assert.equal(info.NSSupportsLiveActivities, true, 'Timer Live Activity support absent');
      assert.equal(rows[0].appIntentsMetadataPresent, true, 'Compiled App Intents metadata missing');
    } else {
      assert.equal(signed['com.apple.developer.weatherkit'], undefined, 'Weather access must not leak into extensions');
      assert.equal(info.NSExtension?.NSExtensionPointIdentifier, expected.name === 'AssistShare' ? 'com.apple.share-services' : 'com.apple.widgetkit-extension', 'Wrong extension type');
    }
    return {product: expected.name, profileExpiresAt: expiry.toISOString(), weatherKit: expected.name === 'Assist', appGroup: true};
  });
  return {schemaVersion: 1, status: 'signed_capabilities_verified', buildNumber: String(buildNumber), products: summaries,
    limits: ['Not Apple/TestFlight acceptance', 'Not iPhone permission or API execution proof', 'Not alarm delivery or weather availability proof']};
}

function regular(file) {
  const value = lstatSync(file);
  assert.ok(value.isFile() && !value.isSymbolicLink() && value.size <= 2 * 1024 * 1024, 'Missing, linked or oversized capability file');
}
function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024});
  assert.ok(!result.error && result.status === 0, `Read-only ${command} check failed; no repair attempted`);
  return result.stdout;
}
function readPlist(file) { regular(file); return plist.parse(run('plutil', ['-convert', 'xml1', '-o', '-', file])); }

export function inspectSignedApp(app) {
  assert.equal(process.platform, 'darwin', 'Signed app inspection requires macOS tools');
  const directory = path.resolve(app);
  assert.ok(directory.endsWith('.app') && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Expected a real .app directory');
  const plugins = path.join(directory, 'PlugIns');
  assert.deepEqual(readdirSync(plugins).sort(), ['AssistShare.appex', 'AssistWidget.appex'], 'Unknown/missing embedded extension');
  const result = products.map(expected => {
    const location = expected.name === 'Assist' ? directory : path.join(plugins, `${expected.name}.appex`);
    assert.ok(lstatSync(location).isDirectory() && !lstatSync(location).isSymbolicLink(), 'Linked product refused');
    run('codesign', ['--verify', '--strict', location]);
    const entitlements = plist.parse(run('codesign', ['--display', '--entitlements', '-', '--xml', location]));
    const profilePath = path.join(location, 'embedded.mobileprovision'); regular(profilePath);
    const profile = plist.parse(run('security', ['cms', '-D', '-i', profilePath]));
    return {name: expected.name, signatureVerified: true, info: readPlist(path.join(location, 'Info.plist')), entitlements, profile,
      ...(expected.name === 'Assist' ? {runtimeVersion: readPlist(path.join(location, 'Expo.plist')).EXUpdatesRuntimeVersion,
        appIntentsMetadataPresent: lstatSync(path.join(location, 'Metadata.appintents')).isDirectory()} : {})};
  });
  return {products: result};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 2, 'Usage: node scripts/verify-ios-capabilities.mjs --app /path/Assist.app');
    assert.equal(args[0], '--app', 'Only explicit signed product inspection is supported');
    console.log(JSON.stringify(validateCapabilityEvidence(inspectSignedApp(args[1])), null, 2));
  } catch {
    console.error('BLOCKED: signed capabilities/profile/runtime evidence is absent or incompatible. No account change, build, credential repair or retry was performed.');
    process.exitCode = 1;
  }
}
