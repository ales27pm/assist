/** @jest-environment node */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const mobileRoot = resolve(__dirname, '..');
const hook = JSON.parse(readFileSync(join(mobileRoot, 'package.json'), 'utf8'))
  .scripts['eas-build-pre-install'];
let fixtureRoot;
let logPath;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'assist-eas-hook-'));
  logPath = join(fixtureRoot, 'calls');
  for (const command of ['python3', 'node', 'bash']) {
    writeFileSync(
      join(fixtureRoot, command),
      `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$ASSIST_HOOK_TEST_LOG"\n[ "$ASSIST_HOOK_TEST_FAIL" != '${command}' ]\n`,
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

test('iOS preinstall still verifies launch, bundle and host prerequisites in order', () => {
  runHook('ios');
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\nbash\n');
});

test('iOS preinstall propagates a failed prerequisite and stops subsequent checks', () => {
  expect(() => runHook('ios', 'node')).toThrow();
  expect(readFileSync(logPath, 'utf8')).toBe('python3\nnode\n');
});
