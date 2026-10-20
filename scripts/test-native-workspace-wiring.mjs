import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

// Structural source checks only. No build, credentials, account, host service,
// network or signed-artifact claim is made by this test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobile = path.join(root, 'mobile');
const ios = path.join(mobile, 'ios');
const require = createRequire(path.join(mobile, 'package.json'));
const xcode = require('xcode');
const {IOSConfig} = require('@expo/config-plugins');
const plist = require('plist');
const appConfig = require(path.join(mobile, 'app.config.js'));
const group = 'group.org.27pm.assist';
const identities = {
  Assist: 'org.27pm.assist',
  AssistShare: 'org.27pm.assist.share',
  AssistWidget: 'org.27pm.assist.widget',
};
const project = xcode.project(path.join(ios, 'Assist.xcodeproj/project.pbxproj'));
project.parseSync();
const objects = project.hash.project.objects;
const text = relative => readFileSync(path.join(root, relative), 'utf8');
const unquote = value => typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
const ref = value => typeof value === 'string' ? value : value.value;
const entries = (data, section) => Object.entries(data[section] ?? {}).filter(([id]) => !id.endsWith('_comment'));
const find = (data, id) => {
  for (const section of Object.values(data)) {
    if (section && typeof section === 'object' && typeof section[id] === 'object') return section[id];
  }
  assert.fail(`Missing project object ${id}`);
};
const target = (data, name) => {
  const found = entries(data, 'PBXNativeTarget').find(([, row]) => unquote(row.name) === name);
  assert.ok(found, `Missing target ${name}`);
  return {id: found[0], ...found[1]};
};
const phases = (data, row, isa) => row.buildPhases.map(ref).map(id => find(data, id)).filter(phase => phase.isa === isa);
const files = (data, phase) => phase.files.map(ref).map(id => find(data, find(data, id).fileRef)).map(file => unquote(file.path));
const configurations = (data, row) => find(data, row.buildConfigurationList).buildConfigurations.map(ref).map(id => find(data, id));

const plists = new Map([
  'Assist/Info.plist', 'Assist/Assist.entitlements', 'Assist/PrivacyInfo.xcprivacy',
  'AssistShare/Info.plist', 'AssistShare/AssistShare.entitlements', 'AssistShare/PrivacyInfo.xcprivacy',
  'AssistWidget/Info.plist', 'AssistWidget/AssistWidget.entitlements', 'AssistWidget/PrivacyInfo.xcprivacy',
  'Assist/Supporting/Expo.plist',
].map(relative => [relative, plist.parse(readFileSync(path.join(ios, relative), 'utf8'))]));

function validate(data = objects, resources = plists, config = appConfig) {
  const native = /^(.+)-native([1-9][0-9]*)$/.exec(config.runtimeVersion);
  assert.ok(native, 'Explicit native runtime required');
  assert.equal(native[1], config.version, 'Marketing version/runtime differ');
  const main = target(data, 'Assist');
  assert.equal(unquote(main.productType), 'com.apple.product-type.application');
  assert.deepEqual(entries(data, 'PBXNativeTarget').map(([, row]) => unquote(row.name)).sort(), Object.keys(identities).sort());
  const requiredMainSources = [
    'Assist/Services/AssistPrivateServicePolicy.swift', 'Assist/Services/AssistPrivateService.swift',
    'Assist/Services/AssistNativeServices.swift', 'Assist/Services/AssistTaskCheckpoint.swift',
    'Assist/AssistDocuments.swift', 'Assist/Shared/AssistSharedInbox.swift',
    'Assist/Inference/AssistResearchAdapter.swift', 'Assist/Inference/AssistResearchRun.swift',
    'Assist/Services/AssistApplePlacesPolicy.swift', 'Assist/Services/AssistApplePlaces.swift',
    'Assist/Services/AssistWeatherAttributionPolicy.swift', 'Assist/Services/AssistWeatherAttribution.swift',
    'Assist/Inference/AssistExtendedTools.swift', 'Assist/Services/AssistCapabilityActions.swift',
    'Assist/Services/AssistAlarmPolicy.swift', 'Assist/Services/AssistAlarms.swift', 'Assist/Shared/AssistAlarmAttributes.swift',
    'Assist/Services/AssistTranslationPolicy.swift', 'Assist/Services/AssistTranslation.swift',
    'Assist/Services/AssistDocumentActionsPolicy.swift', 'Assist/Services/AssistDocumentActions.swift', 'Assist/Services/AssistDocumentSpotlight.swift',
    'Assist/Services/AssistIntentInbox.swift', 'Assist/Services/AssistAppIntents.swift',
  ];
  const mainSources = phases(data, main, 'PBXSourcesBuildPhase').flatMap(phase => files(data, phase));
  for (const relative of requiredMainSources) {
    assert.equal(mainSources.filter(file => file === relative).length, 1, `Main source not compiled once: ${relative}`);
    assert.ok(existsSync(path.join(ios, relative)), `Missing source: ${relative}`);
  }
  const mainResources = phases(data, main, 'PBXResourcesBuildPhase').flatMap(phase => files(data, phase));
  assert.ok(mainResources.some(file => file === 'PrivacyInfo.xcprivacy' || file === 'Assist/PrivacyInfo.xcprivacy'), 'Main privacy manifest not embedded');
  for (const [name, bundle] of Object.entries(identities)) {
    const row = target(data, name);
    const configs = configurations(data, row);
    assert.deepEqual(configs.map(item => item.name).sort(), ['Debug', 'Release']);
    const info = resources.get(`${name}/Info.plist`);
    assert.ok(info, `Missing Info.plist ${name}`);
    for (const {buildSettings: settings} of configs) {
      assert.equal(unquote(settings.PRODUCT_BUNDLE_IDENTIFIER), bundle, `${name} bundle identity`);
      assert.equal(String(settings.CURRENT_PROJECT_VERSION), native[2], `${name} build version`);
      assert.equal(String(unquote(settings.MARKETING_VERSION)), config.version, `${name} marketing version`);
      assert.equal(unquote(settings.INFOPLIST_FILE), `${name}/Info.plist`);
      const entitlement = unquote(settings.CODE_SIGN_ENTITLEMENTS);
      assert.equal(entitlement, `${name}/${name}.entitlements`);
      assert.deepEqual(resources.get(entitlement)?.['com.apple.security.application-groups'], [group], `${name} App Group`);
      if (name !== 'Assist') {
        assert.equal(settings.APPLICATION_EXTENSION_API_ONLY, 'YES', `${name} extension API safety`);
        assert.equal(settings.SKIP_INSTALL, 'YES', `${name} embedded not standalone install`);
      }
    }
    assert.equal(info.CFBundleIdentifier, '$(PRODUCT_BUNDLE_IDENTIFIER)');
    assert.equal(info.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
    assert.equal(info.CFBundleShortVersionString, '$(MARKETING_VERSION)');
    if (name === 'Assist') continue;
    assert.equal(unquote(row.productType), 'com.apple.product-type.app-extension');
    const sourceFiles = phases(data, row, 'PBXSourcesBuildPhase').flatMap(phase => files(data, phase));
    assert.deepEqual(sourceFiles.sort(), ['Assist/Shared/AssistSharedInbox.swift', `${name}/${name === 'AssistShare' ? 'ShareViewController' : 'AssistWidget'}.swift`, ...(name === 'AssistWidget' ? ['Assist/Shared/AssistAlarmAttributes.swift', 'AssistWidget/AssistAlarmLiveActivity.swift'] : [])].sort(), `${name} closed extension sources`);
    const resourceFiles = phases(data, row, 'PBXResourcesBuildPhase').flatMap(phase => files(data, phase));
    assert.ok(resourceFiles.includes(`${name}/PrivacyInfo.xcprivacy`), `${name} privacy manifest missing`);
    const privacy = resources.get(`${name}/PrivacyInfo.xcprivacy`);
    assert.equal(privacy?.NSPrivacyTracking, false);
    assert.ok(privacy?.NSPrivacyAccessedAPITypes?.some(api => api.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryFileTimestamp' && api.NSPrivacyAccessedAPITypeReasons.includes('C617.1')), `${name} file metadata reason`);
    const dependency = main.dependencies.map(ref).map(id => find(data, id)).find(item => item.target === row.id);
    assert.ok(dependency, `Main target does not depend on ${name}`);
    const proxy = find(data, dependency.targetProxy);
    assert.equal(proxy.remoteGlobalIDString, row.id, `${name} dependency proxy`);
    const embeds = phases(data, main, 'PBXCopyFilesBuildPhase').filter(phase => String(phase.dstSubfolderSpec) === '13');
    const embedded = embeds.flatMap(phase => phase.files.map(ref).map(id => find(data, id).fileRef));
    assert.equal(embedded.filter(id => id === row.productReference).length, 1, `${name} appex must be embedded once`);
    assert.equal(unquote(find(data, row.productReference).path), `${name}.appex`);
    const extension = config.extra?.eas?.build?.experimental?.ios?.appExtensions?.find(item => item.targetName === name);
    assert.equal(extension?.bundleIdentifier, bundle, `${name} EAS extension identity`);
    assert.deepEqual(extension?.entitlements?.['com.apple.security.application-groups'], [group], `${name} EAS App Group`);
  }
  const info = resources.get('Assist/Info.plist');
  assert.equal(resources.get('Assist/Assist.entitlements')['com.apple.developer.weatherkit'], true, 'WeatherKit source entitlement absent');
  assert.equal(config.ios?.entitlements?.['com.apple.developer.weatherkit'], true, 'WeatherKit config entitlement absent');
  const frameworkFiles = phases(data, main, 'PBXFrameworksBuildPhase').flatMap(phase =>
    phase.files.map(ref).map(id => find(data, id)).filter(row => row.fileRef).map(row => unquote(find(data, row.fileRef).path)));
  for (const name of ['MapKit', 'WeatherKit', 'CoreLocation']) assert.ok(frameworkFiles.includes(`System/Library/Frameworks/${name}.framework`), `Missing framework ${name}`);
  assert.ok(typeof info.NSLocalNetworkUsageDescription === 'string' && info.NSLocalNetworkUsageDescription.trim(), 'LAN purpose absent');
  assert.equal(info.NSAppTransportSecurity?.NSAllowsArbitraryLoads, false, 'Broad ATS bypass prohibited');
  assert.ok(info.CFBundleURLTypes?.some(item => item.CFBundleURLSchemes?.includes('assist')), 'Inbox URL scheme absent');
  assert.equal(resources.get('Assist/Supporting/Expo.plist')?.EXUpdatesRuntimeVersion, config.runtimeVersion, 'Embedded runtime mismatch');
  const share = resources.get('AssistShare/Info.plist').NSExtension;
  assert.equal(share.NSExtensionPointIdentifier, 'com.apple.share-services');
  assert.equal(share.NSExtensionPrincipalClass, '$(PRODUCT_MODULE_NAME).ShareViewController');
  const rule = share.NSExtensionAttributes?.NSExtensionActivationRule;
  assert.equal(typeof rule, 'string');
  assert.match(rule, /attachments\.@count\s*==\s*1/);
  for (const type of ['public.plain-text', 'public.url', 'public.image', 'com.adobe.pdf']) assert.ok(rule.includes(`"${type}"`));
  assert.doesNotMatch(rule, /TRUEPREDICATE|public\.data|public\.item/);
  assert.equal(resources.get('AssistWidget/Info.plist').NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension');
}

test('all three native targets, sources, embed dependencies, runtime and EAS metadata are coherent', () => validate());

const brokenProjectCases = {
  'missing extension target': data => { delete data.PBXNativeTarget[target(data, 'AssistWidget').id]; },
  'missing embed phase': data => { const main = target(data, 'Assist'); const real = find(data, main.id); real.buildPhases = real.buildPhases.filter(id => find(data, ref(id)).isa !== 'PBXCopyFilesBuildPhase'); },
  'missing target dependency': data => { find(data, target(data, 'Assist').id).dependencies = []; },
  'missing shared source': data => { const phase = phases(data, target(data, 'AssistShare'), 'PBXSourcesBuildPhase')[0]; phase.files = phase.files.filter(id => !files(data, {files: [id]})[0].endsWith('AssistSharedInbox.swift')); },
  'missing research run source': data => { const phase = phases(data, target(data, 'Assist'), 'PBXSourcesBuildPhase')[0]; phase.files = phase.files.filter(id => !files(data, {files: [id]})[0].endsWith('AssistResearchRun.swift')); },
  'missing Apple places policy source': data => { const phase = phases(data, target(data, 'Assist'), 'PBXSourcesBuildPhase')[0]; phase.files = phase.files.filter(id => !files(data, {files: [id]})[0].endsWith('AssistApplePlacesPolicy.swift')); },
  'missing MapKit framework': data => { const phase = phases(data, target(data, 'Assist'), 'PBXFrameworksBuildPhase')[0]; phase.files = phase.files.filter(id => { const row = find(data, ref(id)); return !row.fileRef || !unquote(find(data, row.fileRef).path).endsWith('/MapKit.framework'); }); },
  'missing widget privacy resource': data => { phases(data, target(data, 'AssistWidget'), 'PBXResourcesBuildPhase')[0].files = []; },
  'mismatched extension version': data => { configurations(data, target(data, 'AssistShare'))[0].buildSettings.CURRENT_PROJECT_VERSION = '28'; },
  'extension unsafe API setting': data => { configurations(data, target(data, 'AssistWidget'))[0].buildSettings.APPLICATION_EXTENSION_API_ONLY = 'NO'; },
};
for (const [name, mutate] of Object.entries(brokenProjectCases)) test(`fails if ${name}`, () => {
  const fixture = structuredClone(objects); mutate(fixture); assert.throws(() => validate(fixture));
});
for (const name of Object.keys(identities)) test(`fails if ${name} App Group entitlement is missing`, () => {
  const resources = structuredClone(plists); resources.get(`${name}/${name}.entitlements`)['com.apple.security.application-groups'] = [];
  assert.throws(() => validate(objects, resources));
});
test('fails if WeatherKit source entitlement is missing', () => {
  const resources = structuredClone(plists); delete resources.get('Assist/Assist.entitlements')['com.apple.developer.weatherkit'];
  assert.throws(() => validate(objects, resources));
});
test('fails if WeatherKit config entitlement is missing', () => {
  const config = structuredClone(appConfig); delete config.ios.entitlements['com.apple.developer.weatherkit'];
  assert.throws(() => validate(objects, plists, config));
});
test('fails if LAN usage or embedded OTA runtime are missing/mismatched', () => {
  const resources = structuredClone(plists); delete resources.get('Assist/Info.plist').NSLocalNetworkUsageDescription;
  assert.throws(() => validate(objects, resources));
  const runtime = structuredClone(plists); runtime.get('Assist/Supporting/Expo.plist').EXUpdatesRuntimeVersion = '1.0.0-native28';
  assert.throws(() => validate(objects, runtime));
});

const bridge = text('mobile/ios/Assist/RCTNativeAssist.mm');
const facade = text('mobile/ios/Assist/Services/AssistNativeServices.swift');
const spec = text('mobile/specs/NativeAssist.ts');
const methods = {
  executeAlarms: 'executeAlarms', cancelAlarms: 'cancelAlarms', executeTranslation: 'executeTranslation', cancelTranslation: 'cancelTranslation',
  executeDocumentAction: 'executeDocumentAction', cancelDocumentActions: 'cancelDocumentActions', getPendingNativeIntent: 'pendingNativeIntent', dismissNativeIntent: 'dismissNativeIntent',
  getPrivateServiceStatus: 'privateServiceStatus', presentPrivateServiceSetup: 'presentPrivateServiceSetup',
  disconnectPrivateService: 'disconnectPrivateService', searchPrivateService: 'searchPrivateService',
  openPrivateSearchResult: 'openPrivateSearchResult', getDocumentStatus: 'documentStatus',
  importDocument: 'importDocument', getDocumentInbox: 'documentInbox', readDocument: 'readDocument',
  removeDocument: 'removeDocument', exportDocumentText: 'exportDocumentText', getTaskCheckpoints: 'taskCheckpoints',
  updateTaskCheckpoint: 'updateTaskCheckpoint', cancelNativeWorkspace: 'cancelWorkspace',
  getApplePlacesStatus: 'applePlacesStatus', searchApplePlaces: 'searchApplePlaces',
  getAppleDirections: 'appleDirections', getAppleForecast: 'appleForecast',
  openApplePlace: 'openApplePlace', cancelApplePlaces: 'cancelApplePlaces',
  renderWeatherAttribution: 'renderWeatherAttribution', cancelWeatherAttribution: 'cancelWeatherAttribution',
};
function validateMethod(name, selector, source = bridge) {
  assert.match(spec, new RegExp(`\\b${name}\\([\\s\\S]*?\\): Promise<string>;`), `${name} missing from typed bridge`);
  const start = source.indexOf(`- (void)${name}:`);
  assert.ok(start >= 0, `${name} missing from Objective-C++`);
  const next = source.indexOf('\n- (void)', start + 1);
  const body = source.slice(start, next < 0 ? source.length : next);
  assert.ok(body.includes('[self performWorkspace:'), `${name} bypasses workspace adapter`);
  assert.ok(body.includes(`[service ${selector}:`), `${name} calls wrong Swift selector`);
  assert.match(facade, new RegExp(`@objc func ${selector}\\(`), `${selector} missing from Swift facade`);
}
for (const [name, selector] of Object.entries(methods)) test(`typed workspace bridge reaches ${selector}`, () => validateMethod(name, selector));
test('workspace check detects a wrong native selector', () => assert.throws(() => validateMethod('readDocument', 'readDocument', bridge.replace('[service readDocument:', '[service wrongDocument:'))));
test('workspace lifecycle and exact inbox routing preserve native control boundaries', () => {
  assert.match(bridge, /\[AssistNativeServices\.shared cancelPending\]/);
  assert.match(facade, /UIApplication\.didEnterBackgroundNotification/);
  for (const call of ['AssistPrivateService.shared.cancel()', 'AssistDocuments.shared.cancel()', 'AssistTaskCheckpoint.shared.pauseActive()', 'AssistApplePlaces.shared.cancel()']) assert.ok(facade.includes(call));
  const app = text('mobile/App.tsx');
  assert.match(app, /url === 'assist:\/\/inbox'/);
  assert.match(app, /Linking\.addEventListener\('url'/);
  assert.match(app, /Linking\.getInitialURL\(\)/);
  assert.match(app, /setWorkspaceRequest\(value => value \+ 1\)/);
  const scheme = text('mobile/ios/Assist.xcodeproj/xcshareddata/xcschemes/Assist.xcscheme');
  assert.match(scheme, /buildImplicitDependencies\s*=\s*"YES"/);
  assert.ok(scheme.includes(`BlueprintIdentifier = "${target(objects, 'Assist').id}"`));
});
test('native transient inactivity revokes only the manual Apple read tickets', () => {
  const observer = facade.slice(facade.indexOf('inactiveObserver = NotificationCenter.default.addObserver('), facade.indexOf('\n    private func snapshot('));
  assert.match(observer, /forName: UIApplication\.willResignActiveNotification/);
  assert.match(observer, /MainActor\.assumeIsolated/);
  assert.match(observer, /AssistApplePlaces\.shared\.cancel\(\)/);
  assert.match(observer, /AssistWeatherAttribution\.shared\.cancelAll\(\)/);
  assert.doesNotMatch(observer, /cancelPending\(|AssistDocuments\.shared|AssistPrivateService\.shared|AssistTaskCheckpoint\.shared/);
});

test('native29 retains real alarm authorization/live activity declarations and compiled shortcuts', () => {
  assert.equal(plists.get('Assist/Info.plist').NSSupportsLiveActivities, true);
  assert.ok(plists.get('Assist/Info.plist').NSAlarmKitUsageDescription.length > 20);
  assert.equal(appConfig.ios.infoPlist.NSSupportsLiveActivities, true);
  const intents = text('mobile/ios/Assist/Services/AssistAppIntents.swift');
  assert.match(intents, /AppShortcutsProvider/);
  assert.equal((intents.match(/requiresLocalDeviceAuthentication/g) ?? []).length, 5);
  assert.ok(!intents.includes('AssistAlarms.shared.execute'), 'shortcuts cannot mint a mutation permit');
  assert.match(text('mobile/ios/Assist/SceneDelegate.swift'), /AssistIntentInbox.handleSpotlight/);
  assert.match(text('mobile/ios/AssistWidget/AssistWidget.swift'), /AssistAlarmLiveActivity\(\)/);
});

function validateAlarmActivityPrivacy(source) {
  assert.doesNotMatch(source, /metadata\??\.title/, 'Live Activity must not render custom alarm metadata titles');
  assert.ok((source.match(/Text\("Minuteur Assist"\)/g) ?? []).length >= 2, 'Lock Screen and expanded Island require generic titles');
  assert.match(source, /privacySensitive\(\)/, 'Countdown privacy annotation absent');
}
test('alarm Live Activity preserves generic Lock Screen and Dynamic Island labels', () => {
  const source = text('mobile/ios/AssistWidget/AssistAlarmLiveActivity.swift');
  validateAlarmActivityPrivacy(source);
  assert.throws(() => validateAlarmActivityPrivacy(source.replace('Text("Minuteur Assist")', 'Text(context.attributes.metadata?.title ?? "Minuteur Assist")')));
});

function validateIntentSignal(specSource, bridgeSource, inboxSource) {
  assert.match(specSource, /readonly onNativeIntentChanged:\s*CodegenTypes\.EventEmitter<ProgressEvent>/, 'Typed intent arrival event absent');
  const start = bridgeSource.indexOf('- (void)getPendingNativeIntent:');
  const end = bridgeSource.indexOf('\n- (void)', start + 1);
  assert.ok(start >= 0 && end > start, 'Intent snapshot bridge method absent');
  const body = bridgeSource.slice(start, end);
  const registration = body.indexOf('addObserverForName:@"AssistIntentDraftChanged"');
  const snapshot = body.indexOf('[service pendingNativeIntent:done]');
  assert.ok(registration >= 0 && snapshot > registration, 'Register change observer before snapshot to close the arrival race');
  assert.match(body, /emitOnNativeIntentChanged:/, 'Generated typed event emitter not used');
  assert.doesNotMatch(body, /@"prompt"|@"text"|@"recipients"/, 'Arrival event cannot copy draft content');
  const prepare = inboxSource.slice(inboxSource.indexOf('static func prepare('), inboxSource.indexOf('private static func pending('));
  const write = prepare.indexOf('try JSONEncoder().encode(draft).write(');
  const protection = prepare.indexOf('try FileManager.default.setAttributes(');
  const signal = prepare.indexOf('NotificationCenter.default.post(name: .init("AssistIntentDraftChanged")');
  assert.ok(write >= 0 && protection > write && signal > protection, 'Signal draft arrival only after protected durable write');
}
test('native intent arrival signal is typed, subscribed before snapshot and emitted after protected publication', () => {
  const inbox = text('mobile/ios/Assist/Services/AssistIntentInbox.swift');
  validateIntentSignal(spec, bridge, inbox);
  assert.throws(() => validateIntentSignal(spec.replace('readonly onNativeIntentChanged:', 'readonly unrelatedEvent:'), bridge, inbox));
  assert.throws(() => validateIntentSignal(spec, bridge.replace('addObserverForName:@"AssistIntentDraftChanged"', 'addObserverForName:@"UnrelatedSignal"'), inbox));
});

// EAS credentials resolution consumes this real Expo target reader. The Xcode
// parser preserves bare dependency IDs as strings, while Expo destructures
// {value}; structural graph inspection alone cannot catch that boundary.
test('installed Expo parser resolves all signable targets and native entitlements before EAS credentials', async () => {
  const application = await IOSConfig.Target.findApplicationTargetWithDependenciesAsync(mobile, 'Assist');
  assert.equal(application.name, 'Assist');
  assert.equal(application.signable, true);
  const signable = [application, ...(application.dependencies ?? [])].filter(item => item.signable);
  assert.deepEqual(signable.map(item => item.name).sort(), Object.keys(identities).sort());
  for (const item of signable) {
    const settings = IOSConfig.Target.getXCBuildConfigurationFromPbxproj(project, {targetName: item.name, buildConfiguration: 'Release'}).buildSettings;
    assert.equal(unquote(settings.PRODUCT_BUNDLE_IDENTIFIER), identities[item.name]);
    const entitlementPath = IOSConfig.Entitlements.getEntitlementsPath(mobile, {targetName: item.name, buildConfiguration: 'Release'});
    assert.ok(entitlementPath, `Expo cannot resolve native entitlements for ${item.name}`);
    const entitlements = plist.parse(readFileSync(entitlementPath, 'utf8'));
    assert.deepEqual(entitlements['com.apple.security.application-groups'], [group]);
    assert.equal(entitlements['com.apple.developer.weatherkit'], item.name === 'Assist' ? true : undefined);
  }
});
