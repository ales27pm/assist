/** @jest-environment node */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const mobileRoot = resolve(__dirname, '..');
const hook = JSON.parse(readFileSync(join(mobileRoot, 'package.json'), 'utf8'))
  .scripts['eas-build-pre-install'];

test('native update runtimes match the current native build', () => {
  const config = require('../app.config');
  const expoPlist = readFileSync(join(mobileRoot, 'ios/Assist/Supporting/Expo.plist'), 'utf8');
  const strings = readFileSync(join(mobileRoot, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  const xcodeProject = readFileSync(join(mobileRoot, 'ios/Assist.xcodeproj/project.pbxproj'), 'utf8');
  const buildNumbers = [...xcodeProject.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => match[1]);
  expect([...new Set(buildNumbers)]).toEqual(['30']);
  expect(typeof config.runtimeVersion).toBe('string');
  expect(config.runtimeVersion).toBe(`1.0.0-native${buildNumbers[0]}`);
  expect(expoPlist.match(/<key>EXUpdatesRuntimeVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1]).toBe(config.runtimeVersion);
  expect(strings.match(/name="expo_runtime_version">([^<]+)<\/string>/)?.[1]).toBe(config.runtimeVersion);
});

test('Core AI selects the Tokenizers protocol when FluidAudio is also imported', () => {
  const bridge = readFileSync(join(mobileRoot, 'ios/Assist/Inference/AssistCoreAI.swift'), 'utf8');
  // Both SDKs export Tokenizer. The model inference contract is the protocol,
  // not FluidAudio's unrelated speech tokenizer class.
  const tokenizerTypes = [...bridge.matchAll(/\bany\s+([\w.]*Tokenizer)\b/g)]
    .map(match => match[1]);
  expect(tokenizerTypes.length).toBeGreaterThanOrEqual(2);
  expect(tokenizerTypes.every(type => type === 'Tokenizers.Tokenizer')).toBe(true);
});

test('native update patch support is preserved by release configuration normalization', () => {
  const expoPlist = readFileSync(join(mobileRoot, 'ios/Assist/Supporting/Expo.plist'), 'utf8');
  expect(expoPlist).toMatch(/<key>EXUpdatesEnableBsdiffPatchSupport<\/key>\s*<true\s*\/>/);
});

test('iOS resolves Expo CLI through Expo when the CLI is nested', () => {
  const xcodeProject = readFileSync(join(mobileRoot, 'ios/Assist.xcodeproj/project.pbxproj'), 'utf8');
  expect(xcodeProject).toContain(
    "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })",
  );

  const expoDirectory = join(fixtureRoot, 'node_modules', 'expo');
  const cliDirectory = join(expoDirectory, 'node_modules', '@expo', 'cli');
  mkdirSync(cliDirectory, { recursive: true });
  writeFileSync(join(expoDirectory, 'package.json'), '{"name":"expo"}\n');
  writeFileSync(join(cliDirectory, 'package.json'), '{"name":"@expo/cli","main":"index.js"}\n');
  writeFileSync(join(cliDirectory, 'index.js'), 'module.exports = {};\n');

  const resolver = createRequire(join(fixtureRoot, 'ios', 'xcode-resolver.cjs'));
  const expoPackage = resolver.resolve('expo/package.json');
  expect(() => resolver.resolve('@expo/cli')).toThrow();
  expect(resolver.resolve('@expo/cli', { paths: [expoPackage] })).toBe(join(cliDirectory, 'index.js'));
});
let fixtureRoot;
let logPath;
let scriptLogPath;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'assist-eas-hook-'));
  logPath = join(fixtureRoot, 'calls');
  scriptLogPath = join(fixtureRoot, 'script-calls');
  for (const command of ['python3', 'node', 'bash']) {
    writeFileSync(
      join(fixtureRoot, command),
      `#!/bin/sh
printf '%s\\n' '${command}' >> "$ASSIST_HOOK_TEST_LOG"
printf '%s\\n' "$1" >> "$ASSIST_HOOK_TEST_SCRIPT_LOG"
if [ "$1" = '../scripts/test-agent-wiring.py' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'agent-wiring' ]; then exit 1; fi
if [ "$1" = '../scripts/check-voice-callbacks.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'voice' ]; then exit 1; fi
if [ "$1" = '../scripts/check-voice-input.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'input' ]; then exit 1; fi
if [ "$1" = '../scripts/check-voice-speech-queue.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'queue' ]; then exit 1; fi
if [ "$1" = '../scripts/check-voice-duplex.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'duplex' ]; then exit 1; fi
if [ "$1" = '../scripts/check-speech-voices.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'speech-voices' ]; then exit 1; fi
if [ "$1" = '../scripts/check-fluid-voice.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'fluid-voice' ]; then exit 1; fi
if [ "$1" = '../scripts/check-advanced-voice-files.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'advanced-voice-files' ]; then exit 1; fi
if [ "$1" = '../scripts/check-fluid-sdk.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'fluid-sdk' ]; then exit 1; fi
if [ "$1" = '../scripts/check-inference-admission.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'inference-admission' ]; then exit 1; fi
if [ "$1" = '../scripts/check-agent-calendar.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'agent-calendar' ]; then exit 1; fi
if [ "$1" = '../scripts/check-gemma-tools.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'gemma-tools' ]; then exit 1; fi
if [ "$1" = '../scripts/check-agent-loop.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'agent-loop' ]; then exit 1; fi
if [ "$1" = '../scripts/check-device-tools.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'device-tools' ]; then exit 1; fi
if [ "$1" = '../scripts/check-device-tool-host.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'device-tool-host' ]; then exit 1; fi
if [ "$1" = '../scripts/check-thought-tree.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'thought-tree' ]; then exit 1; fi
if [ "$1" = '../scripts/check-device-tool-loop.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'device-tool-loop' ]; then exit 1; fi
if [ "$1" = '../scripts/check-tool-transactions.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'tool-transactions' ]; then exit 1; fi
if [ "$1" = '../scripts/check-private-service.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'private-service' ]; then exit 1; fi
if [ "$1" = '../scripts/check-shared-inbox.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'shared-inbox' ]; then exit 1; fi
if [ "$1" = '../scripts/check-task-checkpoints.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'task-checkpoints' ]; then exit 1; fi
if [ "$1" = '../scripts/check-alarms.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'alarms' ]; then exit 1; fi
if [ "$1" = '../scripts/check-translation.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'translation' ]; then exit 1; fi
if [ "$1" = '../scripts/check-document-actions.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'document-actions' ]; then exit 1; fi
if [ "$1" = '../scripts/check-spotlight-callbacks.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'spotlight-callbacks' ]; then exit 1; fi
if [ "$1" = '../scripts/check-native-workspace.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'native-workspace' ]; then exit 1; fi
if [ "$1" = '../scripts/check-device-bridge-header.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'device-bridge-header' ]; then exit 1; fi
if [ "$1" = '../scripts/check-research-loop.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'research-loop' ]; then exit 1; fi
if [ "$1" = '../scripts/check-apple-places.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'apple-places' ]; then exit 1; fi
if [ "$1" = '../scripts/check-weather-attribution.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'weather-attribution' ]; then exit 1; fi
[ "$ASSIST_HOOK_TEST_FAIL" != '${command}' ]
`,
      { mode: 0o755 },
    );
  }
});

afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function runHook(platform, fail = '') {
  return execFileSync('/bin/sh', ['-c', hook], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      PATH: fixtureRoot,
      EAS_BUILD_PLATFORM: platform,
      ASSIST_HOOK_TEST_LOG: logPath,
      ASSIST_HOOK_TEST_SCRIPT_LOG: scriptLogPath,
      ASSIST_HOOK_TEST_FAIL: fail,
    },
  });
}

test('Android preinstall succeeds without invoking any iOS prerequisites', () => {
  runHook('android');
  expect(() => readFileSync(logPath, 'utf8')).toThrow();
});

test('iOS preinstall verifies launch, voice and closed device-tool agent contracts in order', () => {
  runHook('ios');
  expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['python3', 'python3', 'node', ...Array(30).fill('bash')]);
  expect(readFileSync(scriptLogPath, 'utf8').trim().split('\n').slice(-5)).toEqual([
    '../scripts/check-native-workspace.sh',
    '../scripts/check-device-bridge-header.sh',
    '../scripts/check-research-loop.sh',
    '../scripts/check-apple-places.sh',
    '../scripts/check-weather-attribution.sh',
  ]);
});

test('iOS preinstall stops before native checks when the tokenizer wiring guard fails', () => {
  expect(() => runHook('ios', 'agent-wiring')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\n');
  expect(readFileSync(scriptLogPath, 'utf8').trim().split('\n')).toEqual([
    '../scripts/test-ios-launch.py', '../scripts/test-agent-wiring.py',
  ]);
});

test('iOS preinstall propagates a failed prerequisite and stops subsequent checks', () => {
  expect(() => runHook('ios', 'node')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\n');
});

test('iOS preinstall blocks a release when the native callback regression fails', () => {
  expect(() => runHook('ios', 'voice')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\n');
});

test('iOS preinstall stops before the speech queue when input checks fail', () => {
  expect(() => runHook('ios', 'input')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\nbash\n');
});

test('iOS preinstall propagates speech queue check failures', () => {
  expect(() => runHook('ios', 'queue')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates duplex regression failures', () => {
  expect(() => runHook('ios', 'duplex')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\nbash\nbash\nbash\n');
});

test('iOS preinstall blocks a release when voice comparison contracts fail', () => {
  expect(() => runHook('ios', 'speech-voices')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates fluid-voice failure', () => {
  expect(() => runHook('ios', 'fluid-voice')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates advanced-voice-files failure', () => {
  expect(() => runHook('ios', 'advanced-voice-files')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates fluid-sdk failure', () => {
  expect(() => runHook('ios', 'fluid-sdk')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\npython3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\n');
});

test.each(['inference-admission', 'agent-calendar', 'gemma-tools', 'agent-loop', 'device-tools', 'device-tool-host', 'thought-tree', 'device-tool-loop', 'tool-transactions', 'private-service', 'shared-inbox', 'task-checkpoints', 'alarms', 'translation', 'document-actions', 'spotlight-callbacks', 'native-workspace', 'device-bridge-header', 'research-loop', 'apple-places', 'weather-attribution'])('iOS preinstall blocks on %s failure', failure => {
  expect(() => runHook('ios', failure)).toThrow();
  expect(readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length).toBe(
    13 + ['inference-admission', 'agent-calendar', 'gemma-tools', 'agent-loop', 'device-tools', 'device-tool-host', 'thought-tree', 'device-tool-loop', 'tool-transactions', 'private-service', 'shared-inbox', 'task-checkpoints', 'alarms', 'translation', 'document-actions', 'spotlight-callbacks', 'native-workspace', 'device-bridge-header', 'research-loop', 'apple-places', 'weather-attribution'].indexOf(failure),
  );
});

test('a generated-header failure stops after workspace checks and skips subsequent native checks', () => {
  expect(() => runHook('ios', 'device-bridge-header')).toThrow();
  const scripts = readFileSync(scriptLogPath, 'utf8').trim().split('\n');
  expect(scripts.slice(-2)).toEqual([
    '../scripts/check-native-workspace.sh',
    '../scripts/check-device-bridge-header.sh',
  ]);
  for (const skipped of ['research-loop', 'apple-places', 'weather-attribution']) {
    expect(scripts).not.toContain(`../scripts/check-${skipped}.sh`);
  }
});

test('a Spotlight callback isolation regression blocks subsequent native compilation', () => {
  expect(() => runHook('ios', 'spotlight-callbacks')).toThrow();
  const scripts = readFileSync(scriptLogPath, 'utf8').trim().split('\n');
  expect(scripts.slice(-2)).toEqual([
    '../scripts/check-document-actions.sh',
    '../scripts/check-spotlight-callbacks.sh',
  ]);
  expect(scripts).not.toContain('../scripts/check-native-workspace.sh');
});
