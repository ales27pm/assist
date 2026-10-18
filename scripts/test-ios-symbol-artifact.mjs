import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDirectory);
const packageSymbols = path.join(scriptsDirectory, 'package-ios-symbols.mjs');
const verifySymbols = path.join(scriptsDirectory, 'verify-ios-symbol-artifact.mjs');
const UUID = '4A12E79E-80DB-3AEF-85A4-0CF10D0705EF';
const REVISION = '1129342d1c7bd95ba20d4f9a45da7587010a5467';

function runNode(script, args, environment) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
  });
}

async function makeFixture({includeDsym = true} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assist-symbol-fixture-'));
  const bin = path.join(root, 'bin');
  const iosRoot = path.join(root, 'ios');
  await mkdir(path.join(iosRoot, 'Assist', 'Supporting'), {recursive: true});
  await mkdir(path.join(iosRoot, 'Assist.xcodeproj'), {recursive: true});
  await mkdir(bin, {recursive: true});
  await writeFile(
    path.join(iosRoot, 'Assist', 'Supporting', 'Expo.plist'),
    '<plist><dict><key>EXUpdatesRuntimeVersion</key><string>1.0.0-native27</string></dict></plist>\n',
  );
  await writeFile(
    path.join(iosRoot, 'Assist.xcodeproj', 'project.pbxproj'),
    [
      'PRODUCT_BUNDLE_IDENTIFIER = org.27pm.assist;',
      'MARKETING_VERSION = 1.0.0;',
      'CURRENT_PROJECT_VERSION = 27;',
    ].join('\n'),
  );
  await writeFile(
    path.join(bin, 'dwarfdump'),
    `#!/bin/sh\nprintf 'UUID: ${UUID} (arm64) %s\\n' "$2"\n`,
  );
  await chmod(path.join(bin, 'dwarfdump'), 0o755);
  if (includeDsym) {
    const dwarf = path.join(
      iosRoot,
      'build',
      'Build',
      'Products',
      'Release-iphoneos',
      'Assist.app.dSYM',
      'Contents',
      'Resources',
      'DWARF',
      'Assist',
    );
    await mkdir(path.dirname(dwarf), {recursive: true});
    await writeFile(dwarf, 'synthetic Assist DWARF data\n');
  }
  return {
    artifact: path.join(root, 'artifacts', 'ios', 'assist-symbols.zip'),
    environment: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`},
    root,
  };
}

test('release profiles retain the generated symbol archive', async () => {
  const eas = JSON.parse(await readFile(path.join(repositoryRoot, 'mobile', 'eas.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'mobile', 'package.json'), 'utf8'));
  assert.deepEqual(eas.build.preview.buildArtifactPaths, ['artifacts/ios/assist-symbols.zip']);
  assert.equal(eas.build.testflight.extends, 'preview');
  assert.match(packageJson.scripts['eas-build-on-success'], /package-ios-symbols\.mjs/);
});

test('packages and verifies an arm64 dSYM with its build identity', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = runNode(
    packageSymbols,
    ['--project-root', fixture.root, '--output', 'artifacts/ios/assist-symbols.zip', '--source-revision', REVISION],
    fixture.environment,
  );
  assert.equal(packaged.status, 0, packaged.stderr);

  const manifest = JSON.parse(
    spawnSync('unzip', ['-p', fixture.artifact, 'symbol-identity.json'], {encoding: 'utf8'}).stdout,
  );
  assert.deepEqual(manifest.build, {
    bundleIdentifier: 'org.27pm.assist',
    version: '1.0.0',
    buildNumber: '27',
    runtimeVersion: '1.0.0-native27',
    sourceRevision: REVISION,
  });
  assert.deepEqual(manifest.dSYM.uuids, [{architecture: 'arm64', uuid: UUID}]);

  const verified = runNode(verifySymbols, [fixture.artifact], fixture.environment);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Verified iOS symbols/);
});

test('fails closed when an iOS build did not create Assist.app.dSYM', async t => {
  const fixture = await makeFixture({includeDsym: false});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = runNode(
    packageSymbols,
    ['--project-root', fixture.root, '--output', 'artifacts/ios/assist-symbols.zip', '--source-revision', REVISION],
    fixture.environment,
  );
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /No iOS build output exists|No Assist\.app\.dSYM/);
});

test('finds the nested ArchiveIntermediates location observed in the real build 26 log', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const build = path.join(fixture.root, 'ios', 'build', 'Build');
  const canonical = path.join(build, 'Products', 'Release-iphoneos', 'Assist.app.dSYM');
  const archived = path.join(build, 'Intermediates.noindex', 'ArchiveIntermediates', 'Assist',
    'BuildProductsPath', 'Release-iphoneos', 'Assist.app.dSYM');
  await mkdir(path.dirname(archived), {recursive: true});
  await rename(canonical, archived);
  const packaged = runNode(packageSymbols,
    ['--project-root', fixture.root, '--source-revision', REVISION], fixture.environment);
  assert.equal(packaged.status, 0, packaged.stderr);
  const verified = runNode(verifySymbols, [fixture.artifact], fixture.environment);
  assert.equal(verified.status, 0, verified.stderr);
});

test('rejects ambiguous nested symbol bundles instead of choosing one', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const build = path.join(fixture.root, 'ios', 'build', 'Build');
  const canonical = path.join(build, 'Products', 'Release-iphoneos', 'Assist.app.dSYM');
  const first = path.join(build, 'archive-a', 'Assist.app.dSYM');
  const second = path.join(build, 'archive-b', 'Assist.app.dSYM');
  await mkdir(path.dirname(first), {recursive: true});
  await mkdir(path.dirname(second), {recursive: true});
  await rename(canonical, first);
  await cp(first, second, {recursive: true});
  const packaged = runNode(packageSymbols,
    ['--project-root', fixture.root, '--source-revision', REVISION], fixture.environment);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /More than one Assist\.app\.dSYM/);
});

test('refuses an abbreviated source revision even when EAS supplies a valid fallback', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = runNode(
    packageSymbols,
    ['--project-root', fixture.root, '--output', 'artifacts/ios/assist-symbols.zip', '--source-revision', REVISION.slice(0, 7)],
    {...fixture.environment, EAS_BUILD_GIT_COMMIT_HASH: REVISION},
  );
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /--source-revision must be a full 40- or 64-character Git revision/);
});

test('refuses an invalid EAS source revision rather than falling back to Git', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = runNode(
    packageSymbols,
    ['--project-root', fixture.root, '--output', 'artifacts/ios/assist-symbols.zip'],
    {...fixture.environment, EAS_BUILD_GIT_COMMIT_HASH: REVISION.slice(0, 7)},
  );
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /EAS_BUILD_GIT_COMMIT_HASH must be a full 40- or 64-character Git revision/);
});

test('refuses a dSYM whose payload no longer matches the identity manifest', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = runNode(
    packageSymbols,
    ['--project-root', fixture.root, '--output', 'artifacts/ios/assist-symbols.zip', '--source-revision', REVISION],
    fixture.environment,
  );
  assert.equal(packaged.status, 0, packaged.stderr);

  const expanded = path.join(fixture.root, 'expanded');
  assert.equal(spawnSync('unzip', ['-qq', fixture.artifact, '-d', expanded]).status, 0);
  const manifestPath = path.join(expanded, 'symbol-identity.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dSYM.sha256 = '0'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const tampered = path.join(fixture.root, 'tampered-symbols.zip');
  assert.equal(
    spawnSync('zip', ['-q', '-r', tampered, 'Assist.app.dSYM', 'symbol-identity.json'], {
      cwd: expanded,
    }).status,
    0,
  );

  const verified = runNode(verifySymbols, [tampered], fixture.environment);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /SHA-256 does not match/);
});

test('refuses a manifest with an abbreviated source revision', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = runNode(
    packageSymbols,
    ['--project-root', fixture.root, '--output', 'artifacts/ios/assist-symbols.zip', '--source-revision', REVISION],
    fixture.environment,
  );
  assert.equal(packaged.status, 0, packaged.stderr);

  const expanded = path.join(fixture.root, 'expanded-short-revision');
  assert.equal(spawnSync('unzip', ['-qq', fixture.artifact, '-d', expanded]).status, 0);
  const manifestPath = path.join(expanded, 'symbol-identity.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.build.sourceRevision = REVISION.slice(0, 7);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const tampered = path.join(fixture.root, 'short-revision-symbols.zip');
  assert.equal(
    spawnSync('zip', ['-q', '-r', tampered, 'Assist.app.dSYM', 'symbol-identity.json'], {
      cwd: expanded,
    }).status,
    0,
  );

  const verified = runNode(verifySymbols, [tampered], fixture.environment);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /complete build identity/);
});
