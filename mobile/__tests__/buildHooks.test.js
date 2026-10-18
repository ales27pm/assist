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
  expect([...new Set(buildNumbers)]).toEqual(['27']);
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
  expect(tokenizerTypes).toEqual(['Tokenizers.Tokenizer', 'Tokenizers.Tokenizer']);
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

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'assist-eas-hook-'));
  logPath = join(fixtureRoot, 'calls');
  for (const command of ['python3', 'node', 'bash']) {
    writeFileSync(
      join(fixtureRoot, command),
      `#!/bin/sh
printf '%s\\n' '${command}' >> "$ASSIST_HOOK_TEST_LOG"
if [ "$1" = '../scripts/check-voice-callbacks.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'voice' ]; then exit 1; fi
if [ "$1" = '../scripts/check-voice-input.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'input' ]; then exit 1; fi
if [ "$1" = '../scripts/check-voice-speech-queue.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'queue' ]; then exit 1; fi
if [ "$1" = '../scripts/check-voice-duplex.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'duplex' ]; then exit 1; fi
if [ "$1" = '../scripts/check-speech-voices.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'speech-voices' ]; then exit 1; fi
if [ "$1" = '../scripts/check-fluid-voice.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'fluid-voice' ]; then exit 1; fi
if [ "$1" = '../scripts/check-advanced-voice-files.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'advanced-voice-files' ]; then exit 1; fi
if [ "$1" = '../scripts/check-fluid-sdk.sh' ] && [ "$ASSIST_HOOK_TEST_FAIL" = 'fluid-sdk' ]; then exit 1; fi
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
      ASSIST_HOOK_TEST_FAIL: fail,
    },
  });
}

test('Android preinstall succeeds without invoking any iOS prerequisites', () => {
  runHook('android');
  expect(() => readFileSync(logPath, 'utf8')).toThrow();
});

test('iOS preinstall verifies launch, bundle, host, callbacks, input, speech queue, duplex, comparison and advanced voice in order', () => {
  runHook('ios');
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\n');
});

test('iOS preinstall propagates a failed prerequisite and stops subsequent checks', () => {
  expect(() => runHook('ios', 'node')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\n');
});

test('iOS preinstall blocks a release when the native callback regression fails', () => {
  expect(() => runHook('ios', 'voice')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\n');
});

test('iOS preinstall stops before the speech queue when input checks fail', () => {
  expect(() => runHook('ios', 'input')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\n');
});

test('iOS preinstall propagates speech queue check failures', () => {
  expect(() => runHook('ios', 'queue')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates duplex regression failures', () => {
  expect(() => runHook('ios', 'duplex')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\nbash\nbash\n');
});

test('iOS preinstall blocks a release when voice comparison contracts fail', () => {
  expect(() => runHook('ios', 'speech-voices')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates fluid-voice failure', () => {
  expect(() => runHook('ios', 'fluid-voice')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates advanced-voice-files failure', () => {
  expect(() => runHook('ios', 'advanced-voice-files')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\n');
});


test('iOS preinstall propagates fluid-sdk failure', () => {
  expect(() => runHook('ios', 'fluid-sdk')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\nbash\n');
});
