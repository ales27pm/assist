import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
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
const SHARE_UUID = '11111111-2222-3333-4444-555555555555';
const WIDGET_UUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

function fixtureProject({extensions = false, partial = false} = {}) {
  const names = ['Assist', ...(extensions ? ['AssistShare', ...(partial ? [] : ['AssistWidget'])] : [])];
  const objects = {PBXNativeTarget: [], XCConfigurationList: [], XCBuildConfiguration: []};
  const identifier = index => `A${String(index).padStart(23, '0')}`;
  for (const [index, name] of names.entries()) {
    const target = identifier(index * 10 + 1);
    const list = identifier(index * 10 + 2);
    const config = identifier(index * 10 + 3);
    const suffix = name === 'AssistShare' ? '.share' : name === 'AssistWidget' ? '.widget' : '';
    objects.PBXNativeTarget.push(`${target} = {isa = PBXNativeTarget; name = ${name}; productType = "com.apple.product-type.${index === 0 ? 'application' : 'app-extension'}"; buildConfigurationList = ${list}; };`);
    objects.XCConfigurationList.push(`${list} = {isa = XCConfigurationList; buildConfigurations = (${config},); };`);
    objects.XCBuildConfiguration.push(`${config} = {isa = XCBuildConfiguration; name = Release; buildSettings = {PRODUCT_BUNDLE_IDENTIFIER = org.27pm.assist${suffix}; MARKETING_VERSION = 1.0.0; CURRENT_PROJECT_VERSION = ${extensions ? 29 : 27}; }; };`);
  }
  // Deliberately different project/global values must not pollute target identity.
  objects.XCBuildConfiguration.push(`${identifier(99)} = {isa = XCBuildConfiguration; name = Debug; buildSettings = {PRODUCT_BUNDLE_IDENTIFIER = unrelated.global.value; MARKETING_VERSION = 9.9.9; CURRENT_PROJECT_VERSION = 999; }; };`);
  return `// !$*UTF8*$!\n{\narchiveVersion = 1;\nclasses = {};\nobjectVersion = 54;\nobjects = {\n${Object.entries(objects).map(([section, rows]) => `/* Begin ${section} section */\n${rows.join('\n')}\n/* End ${section} section */`).join('\n')}\n};\nrootObject = ${identifier(1)};\n}\n`;
}

function runNode(script, args, environment) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
  });
}

async function makeFixture({includeDsym = true, extensions = false, partial = false} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assist-symbol-fixture-'));
  const bin = path.join(root, 'bin');
  const iosRoot = path.join(root, 'ios');
  await mkdir(path.join(iosRoot, 'Assist', 'Supporting'), {recursive: true});
  await mkdir(path.join(iosRoot, 'Assist.xcodeproj'), {recursive: true});
  await mkdir(bin, {recursive: true});
  await writeFile(
    path.join(iosRoot, 'Assist', 'Supporting', 'Expo.plist'),
    `<plist><dict><key>EXUpdatesRuntimeVersion</key><string>1.0.0-native${extensions ? 29 : 27}</string></dict></plist>\n`,
  );
  await writeFile(
    path.join(iosRoot, 'Assist.xcodeproj', 'project.pbxproj'),
    fixtureProject({extensions, partial}),
  );
  await writeFile(
    path.join(bin, 'dwarfdump'),
    `#!${process.execPath}\nconst fs = require('node:fs'); const file = process.argv[3]; const data = fs.readFileSync(file, 'utf8'); const uuid = data.match(/[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}/)?.[0] ?? '${UUID}'; console.log('UUID: ' + uuid + ' (arm64) ' + file);\n`,
  );
  await chmod(path.join(bin, 'dwarfdump'), 0o755);
  await writeFile(path.join(bin, 'plutil'), `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(process.argv.at(-1), 'utf8'));\n`);
  await chmod(path.join(bin, 'plutil'), 0o755);
  const products = path.join(iosRoot, 'build', 'Build', 'Products', 'Release-iphoneos');
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
  if (extensions) {
    const application = path.join(products, 'Assist.app');
    for (const [name, suffix, uuid] of [['Assist', '', UUID], ['AssistShare', '.share', SHARE_UUID], ['AssistWidget', '.widget', WIDGET_UUID]]) {
      const product = name === 'Assist' ? application : path.join(application, 'PlugIns', `${name}.appex`);
      await mkdir(product, {recursive: true});
      await writeFile(path.join(product, 'Info.plist'), JSON.stringify({CFBundleIdentifier: `org.27pm.assist${suffix}`, CFBundleShortVersionString: '1.0.0', CFBundleVersion: '29', CFBundleExecutable: name}));
      await writeFile(path.join(product, name), `synthetic executable UUID ${uuid}\n`);
      if (name !== 'Assist' && includeDsym) {
        const dwarf = path.join(products, `${name}.appex.dSYM`, 'Contents', 'Resources', 'DWARF', name);
        await mkdir(path.dirname(dwarf), {recursive: true});
        await writeFile(dwarf, `synthetic symbols UUID ${uuid}\n`);
      }
    }
  }
  return {
    artifact: path.join(root, 'artifacts', 'ios', 'assist-symbols.zip'),
    environment: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`},
    products,
    root,
  };
}

async function makeEasArchiveFixture({canonicalAlias} = {}) {
  const fixture = await makeFixture({extensions: true});
  // Actual native29 xcode-build.log:5481, 8391 and 8396: archive products are
  // links, the installed app is real, and all three dSYMs share this directory.
  const archive = path.join(fixture.root, 'ios', 'build', 'Build', 'Intermediates.noindex', 'ArchiveIntermediates', 'Assist');
  const products = path.join(archive, 'BuildProductsPath', 'Release-iphoneos');
  const application = path.join(archive, 'InstallationBuildProductsLocation', 'Applications', 'Assist.app');
  await mkdir(products, {recursive: true});
  await mkdir(path.dirname(application), {recursive: true});
  for (const product of ['Assist.app.dSYM', 'AssistShare.appex.dSYM', 'AssistWidget.appex.dSYM']) {
    await rename(path.join(fixture.products, product), path.join(products, product));
  }
  await rename(path.join(fixture.products, 'Assist.app'), application);
  await symlink(path.relative(products, application), path.join(products, 'Assist.app'));
  for (const name of ['AssistShare', 'AssistWidget']) {
    const uninstalled = path.join(archive, 'IntermediateBuildFilesPath', 'UninstalledProducts', 'iphoneos', `${name}.appex`);
    await cp(path.join(application, 'PlugIns', `${name}.appex`), uninstalled, {recursive: true});
    await symlink(path.relative(products, uninstalled), path.join(products, `${name}.appex`));
  }
  const canonical = fixture.products;
  if (canonicalAlias === 'products') {
    await rm(path.dirname(canonical), {recursive: true});
    await symlink(path.relative(path.dirname(path.dirname(canonical)), path.dirname(products)), path.dirname(canonical));
  } else if (canonicalAlias === 'release') {
    await rm(canonical, {recursive: true});
    await symlink(path.relative(path.dirname(canonical), products), canonical);
  } else if (canonicalAlias === 'dsym') {
    for (const product of ['Assist.app.dSYM', 'AssistShare.appex.dSYM', 'AssistWidget.appex.dSYM']) {
      await symlink(path.relative(canonical, path.join(products, product)), path.join(canonical, product));
    }
  }
  return {...fixture, products, application};
}

async function makeExportedIpaFixture() {
  const fixture = await makeEasArchiveFixture({canonicalAlias: 'products'});
  const exported = path.join(fixture.root, 'exported');
  const app = path.join(exported, 'Payload', 'Assist.app');
  await mkdir(path.dirname(app), {recursive: true});
  await rename(fixture.application, app);
  const ipa = path.join(fixture.root, 'ios', 'build', 'Assist.ipa');
  assert.equal(spawnSync('zip', ['-q', '-r', ipa, 'Payload'], {cwd: exported}).status, 0);
  return {...fixture, exported, app, ipa};
}

function ipaDirectory(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  assert.ok(end >= 0);
  const offset = bytes.readUInt32LE(end + 16);
  const records = [];
  let next = offset;
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const length = 46 + bytes.readUInt16LE(next + 28) + bytes.readUInt16LE(next + 30) + bytes.readUInt16LE(next + 32);
    records.push({offset: next, length, name: bytes.subarray(next + 46, next + 46 + bytes.readUInt16LE(next + 28)).toString('utf8'), local: bytes.readUInt32LE(next + 42)});
    next += length;
  }
  return {end, offset, records};
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
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'build', 'dSYM']);

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

function packageFixture(fixture) {
  return runNode(packageSymbols, ['--project-root', fixture.root, '--source-revision', REVISION], fixture.environment);
}

function readManifest(fixture) {
  return JSON.parse(spawnSync('unzip', ['-p', fixture.artifact, 'symbol-identity.json'], {encoding: 'utf8'}).stdout);
}

async function tamperArtifact(fixture, transform) {
  const expanded = path.join(fixture.root, 'tamper-expanded');
  assert.equal(spawnSync('unzip', ['-qq', fixture.artifact, '-d', expanded]).status, 0);
  const manifestPath = path.join(expanded, 'symbol-identity.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await transform(manifest, expanded);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const artifact = path.join(fixture.root, 'tampered.zip');
  assert.equal(spawnSync('zip', ['-q', '-y', '-r', artifact, ...await readdir(expanded)], {cwd: expanded}).status, 0);
  return runNode(verifySymbols, [artifact], fixture.environment);
}

test('packages and verifies exactly three matching product symbol identities for native29', async t => {
  const fixture = await makeFixture({extensions: true});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = packageFixture(fixture);
  assert.equal(packaged.status, 0, packaged.stderr);
  const manifest = readManifest(fixture);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.build.buildNumber, '29');
  assert.equal(manifest.build.runtimeVersion, '1.0.0-native29');
  assert.equal(manifest.executableHashStage, 'archive_build_product');
  assert.match(manifest.executableSHA256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.exportedIPA, undefined);
  assert.deepEqual(manifest.extensions.map(extension => [extension.product, extension.bundleIdentifier, extension.dSYM.uuids]), [
    ['AssistShare.appex', 'org.27pm.assist.share', [{architecture: 'arm64', uuid: SHARE_UUID}]],
    ['AssistWidget.appex', 'org.27pm.assist.widget', [{architecture: 'arm64', uuid: WIDGET_UUID}]],
  ]);
  assert.ok(manifest.extensions.every(extension => /^[0-9a-f]{64}$/.test(extension.executableSHA256)));
  assert.ok(manifest.extensions.every(extension => extension.executableHashStage === 'archive_build_product'));
  const entries = spawnSync('unzip', ['-Z1', fixture.artifact], {encoding: 'utf8'}).stdout.trim().split('\n');
  assert.deepEqual([...new Set(entries.map(entry => entry.split('/')[0]))].sort(), [
    'Assist.app.dSYM', 'AssistShare.appex.dSYM', 'AssistWidget.appex.dSYM', 'symbol-identity.json',
  ]);
  assert.ok(entries.length < 32, 'the compressed artifact contains symbol bundles, not application/model payloads');
  const verified = runNode(verifySymbols, [fixture.artifact], fixture.environment);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Verified extension dSYM: AssistShare.appex.dSYM/);
  assert.match(verified.stdout, /Verified extension dSYM: AssistWidget.appex.dSYM/);
});

test('packages matching products and symbols from an xcarchive layout', async t => {
  const fixture = await makeFixture({extensions: true});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const archive = path.join(fixture.root, 'ios', 'build', 'Assist.xcarchive');
  await mkdir(path.join(archive, 'dSYMs'), {recursive: true});
  await mkdir(path.join(archive, 'Products', 'Applications'), {recursive: true});
  for (const product of ['Assist.app.dSYM', 'AssistShare.appex.dSYM', 'AssistWidget.appex.dSYM']) {
    await rename(path.join(fixture.products, product), path.join(archive, 'dSYMs', product));
  }
  await rename(path.join(fixture.products, 'Assist.app'), path.join(archive, 'Products', 'Applications', 'Assist.app'));
  const packaged = packageFixture(fixture);
  assert.equal(packaged.status, 0, packaged.stderr);
  assert.equal(runNode(verifySymbols, [fixture.artifact], fixture.environment).status, 0);
});

test('packages the real EAS ArchiveIntermediates layout without following product links', async t => {
  const fixture = await makeEasArchiveFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = packageFixture(fixture);
  assert.equal(packaged.status, 0, packaged.stderr);
  const manifest = readManifest(fixture);
  assert.equal(manifest.dSYM.bundle, 'Assist.app.dSYM');
  assert.deepEqual(manifest.extensions.map(extension => [extension.product, extension.dSYM.uuids]), [
    ['AssistShare.appex', [{architecture: 'arm64', uuid: SHARE_UUID}]],
    ['AssistWidget.appex', [{architecture: 'arm64', uuid: WIDGET_UUID}]],
  ]);
  assert.equal(runNode(verifySymbols, [fixture.artifact], fixture.environment).status, 0);
});

for (const canonicalAlias of ['products', 'release', 'dsym']) {
  test(`packages physical archive products when canonical ${canonicalAlias} is an alias`, async t => {
    const fixture = await makeEasArchiveFixture({canonicalAlias});
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    const packaged = packageFixture(fixture);
    assert.equal(packaged.status, 0, packaged.stderr);
    const manifest = readManifest(fixture);
    assert.deepEqual(manifest.extensions.map(row => row.product), ['AssistShare.appex', 'AssistWidget.appex']);
    assert.equal(runNode(verifySymbols, [fixture.artifact], fixture.environment).status, 0);
  });
}

test('uses the exact exported IPA after Xcode moves the archived app outside the build root', async t => {
  const fixture = await makeExportedIpaFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = packageFixture(fixture);
  assert.equal(packaged.status, 0, packaged.stderr);
  const manifest = readManifest(fixture);
  assert.equal(manifest.executableHashStage, 'exported_ipa');
  assert.deepEqual(manifest.exportedIPA, {
    sha256: createHash('sha256').update(await readFile(fixture.ipa)).digest('hex'),
    bytes: (await readFile(fixture.ipa)).length,
    executableHashStage: 'exported_ipa',
  });
  assert.equal(manifest.executableSHA256, createHash('sha256').update(await readFile(path.join(fixture.app, 'Assist'))).digest('hex'));
  for (const row of manifest.extensions) {
    assert.equal(row.executableHashStage, 'exported_ipa');
    assert.equal(row.executableSHA256, createHash('sha256').update(await readFile(path.join(fixture.app, 'PlugIns', row.product, row.executable))).digest('hex'));
  }
  assert.equal(runNode(verifySymbols, [fixture.artifact], fixture.environment).status, 0);
});

for (const [label, mutate, expected] of [
  ['duplicate entries', (bytes, directory) => {
    const duplicate = bytes.subarray(directory.records[0].offset, directory.records[0].offset + directory.records[0].length);
    const end = Buffer.from(bytes.subarray(directory.end));
    end.writeUInt16LE(directory.records.length + 1, 8);
    end.writeUInt16LE(directory.records.length + 1, 10);
    end.writeUInt32LE(bytes.readUInt32LE(directory.end + 12) + duplicate.length, 12);
    return Buffer.concat([bytes.subarray(0, directory.end), duplicate, end]);
  }, /Invalid or duplicate exported IPA entry path/],
  ['absolute entry paths', (bytes, directory) => {
    const row = directory.records[0];
    bytes[row.offset + 46] = 47;
    bytes[row.local + 30] = 47;
    return bytes;
  }, /Invalid or duplicate exported IPA entry path/],
  ['parent traversal paths', (bytes, directory) => {
    const row = directory.records[0];
    assert.equal(row.name, 'Payload/');
    Buffer.from('../load/').copy(bytes, row.offset + 46);
    Buffer.from('../load/').copy(bytes, row.local + 30);
    return bytes;
  }, /Invalid or duplicate exported IPA entry path/],
  ['symlink entries', (bytes, directory) => {
    bytes.writeUInt32LE((0o120777 << 16) >>> 0, directory.records[0].offset + 38);
    return bytes;
  }, /Unsupported exported IPA entry, encryption, or symlink/],
  ['uncompressed quota overflow', (bytes, directory) => {
    bytes.writeUInt32LE(0xffffffff, directory.records[0].offset + 24);
    return bytes;
  }, /exported IPA exceeds its uncompressed size limit/],
  ['oversized selected metadata', (bytes, directory) => {
    const row = directory.records.find(row => row.name === 'Payload/Assist.app/Info.plist');
    bytes.writeUInt32LE(128 * 1024 + 1, row.offset + 24);
    return bytes;
  }, /required exported IPA product file is missing or exceeds its size limit/],
  ['missing required product metadata', (bytes, directory) => {
    const row = directory.records.find(row => row.name === 'Payload/Assist.app/Info.plist');
    const replacement = Buffer.from(row.name.replace('Info.plist', 'Lost.plist'));
    replacement.copy(bytes, row.offset + 46);
    replacement.copy(bytes, row.local + 30);
    return bytes;
  }, /required exported IPA product file is missing or exceeds its size limit/],
  ['inconsistent local filenames', (bytes, directory) => {
    bytes[directory.records[0].local + 30] = 88;
    return bytes;
  }, /Invalid or inconsistent exported IPA local entry/],
]) {
  test(`rejects exported IPA ${label} before extracting product files`, async t => {
    const fixture = await makeExportedIpaFixture();
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    const bytes = await readFile(fixture.ipa);
    await writeFile(fixture.ipa, mutate(bytes, ipaDirectory(bytes)));
    const packaged = packageFixture(fixture);
    assert.notEqual(packaged.status, 0);
    assert.match(packaged.stderr, expected);
  });
}

test('bounds the compressed exported IPA before reading its directory', async t => {
  const fixture = await makeExportedIpaFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  await truncate(fixture.ipa, 512 * 1024 * 1024 + 1);
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /exported IPA exceeds its compressed size limit/);
});

for (const [name, relative] of [['main', 'Assist'], ['share', 'PlugIns/AssistShare.appex/AssistShare'], ['widget', 'PlugIns/AssistWidget.appex/AssistWidget']]) {
  test(`refuses an exported ${name} executable whose UUID does not match its real dSYM`, async t => {
    const fixture = await makeExportedIpaFixture();
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    await writeFile(path.join(fixture.app, relative), 'unexpected UUID 99999999-9999-9999-9999-999999999999\n');
    assert.equal(spawnSync('zip', ['-q', '-r', fixture.ipa, 'Payload'], {cwd: fixture.exported}).status, 0);
    const packaged = packageFixture(fixture);
    assert.notEqual(packaged.status, 0);
    assert.match(packaged.stderr, /executable and dSYM UUIDs do not match/);
  });
}

test('does not fall back to available legacy products when the exact exported IPA is invalid', async t => {
  const fixture = await makeFixture({extensions: true});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  await writeFile(path.join(fixture.root, 'ios', 'build', 'Assist.ipa'), 'invalid IPA');
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /exported IPA exceeds its compressed size limit or is invalid/);
});

test('does not follow a linked exported IPA', async t => {
  const fixture = await makeExportedIpaFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const moved = path.join(fixture.root, 'outside.ipa');
  await rename(fixture.ipa, moved);
  await symlink(moved, fixture.ipa);
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /Build product paths must not contain symlinks \(Assist\.ipa\)/);
});

test('refuses a symlink used as the entire build output root', async t => {
  const fixture = await makeFixture({extensions: true});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const build = path.join(fixture.root, 'ios', 'build');
  const moved = path.join(fixture.root, 'outside-build');
  await rename(build, moved);
  await symlink(moved, build);
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /Build product paths must not contain symlinks \(\.\)/);
});

for (const destination of ['inside', 'outside']) {
  test(`refuses a dSYM link without any physical bundle even when its target is ${destination} the build root`, async t => {
    const fixture = await makeFixture();
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    const dwarf = path.join(fixture.products, 'Assist.app.dSYM');
    const moved = path.join(fixture.root, ...(destination === 'inside' ? ['ios', 'build'] : []), 'unselected-symbols');
    await rename(dwarf, moved);
    await symlink(moved, dwarf);
    const packaged = packageFixture(fixture);
    assert.notEqual(packaged.status, 0);
    assert.match(packaged.stderr, /No Assist\.app\.dSYM/);
  });
}

for (const destination of ['inside', 'outside']) {
  test(`rejects a linked installed EAS application even when its target is ${destination} the build root`, async t => {
    const fixture = await makeEasArchiveFixture();
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    const moved = path.join(fixture.root, ...(destination === 'inside' ? ['ios', 'build'] : []), 'linked-application.app');
    await rename(fixture.application, moved);
    await symlink(moved, fixture.application);
    const packaged = packageFixture(fixture);
    assert.notEqual(packaged.status, 0);
    assert.match(packaged.stderr, /Build product paths must not contain symlinks \(Build\/Intermediates\.noindex\/ArchiveIntermediates\/Assist\/InstallationBuildProductsLocation\/Applications\/Assist\.app\)/);
  });
}

for (const [label, relative, expected] of [
  ['missing extension dSYM', 'AssistShare.appex.dSYM', /ENOENT/],
  ['missing embedded extension', 'Assist.app/PlugIns/AssistWidget.appex', /extension products do not match/],
  ['missing main app', 'Assist.app', /built Assist.app is required/],
]) {
  test(`refuses ${label} rather than silently emitting a partial symbol artifact`, async t => {
    const fixture = await makeFixture({extensions: true});
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    await rm(path.join(fixture.products, relative), {recursive: true});
    const packaged = packageFixture(fixture);
    assert.notEqual(packaged.status, 0);
    assert.match(packaged.stderr, expected);
  });
}

for (const [label, relative] of [
  ['main app', 'Assist.app/Assist'],
  ['share extension', 'Assist.app/PlugIns/AssistShare.appex/AssistShare'],
  ['widget extension', 'Assist.app/PlugIns/AssistWidget.appex/AssistWidget'],
]) {
  test(`rejects ${label} binary/dSYM UUID mismatch`, async t => {
    const fixture = await makeFixture({extensions: true});
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    await writeFile(path.join(fixture.products, relative), 'mismatching UUID 99999999-9999-9999-9999-999999999999\n');
    const packaged = packageFixture(fixture);
    assert.notEqual(packaged.status, 0);
    assert.match(packaged.stderr, /executable and dSYM UUIDs do not match/);
  });
}

test('rejects an unexpected embedded extension product', async t => {
  const fixture = await makeFixture({extensions: true});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  await mkdir(path.join(fixture.products, 'Assist.app', 'PlugIns', 'Unknown.appex'));
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /extension products do not match/);
});

test('rejects a partial pair of source extension targets', async t => {
  const fixture = await makeFixture({extensions: true, partial: true});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /both AssistShare and AssistWidget native extension targets/);
});

for (const [label, field, value] of [
  ['bundle', 'CFBundleIdentifier', 'org.27pm.other'],
  ['version', 'CFBundleShortVersionString', '2.0.0'],
  ['build', 'CFBundleVersion', '28'],
  ['executable', 'CFBundleExecutable', '../Assist'],
]) {
  test(`rejects extension ${label} identity mismatch`, async t => {
    const fixture = await makeFixture({extensions: true});
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    const infoPath = path.join(fixture.products, 'Assist.app', 'PlugIns', 'AssistShare.appex', 'Info.plist');
    const info = JSON.parse(await readFile(infoPath, 'utf8'));
    info[field] = value;
    await writeFile(infoPath, JSON.stringify(info));
    const packaged = packageFixture(fixture);
    assert.notEqual(packaged.status, 0);
    assert.match(packaged.stderr, /built AssistShare.appex identity does not match/);
  });
}

test('rejects symlinks before copying any symbol payload', async t => {
  const fixture = await makeFixture({extensions: true});
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  await symlink(path.join(fixture.root, 'ios', 'Assist', 'Supporting', 'Expo.plist'), path.join(fixture.products, 'AssistShare.appex.dSYM', 'external'));
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /must not contain symlinks/);
});

for (const [label, transform, expected] of [
  ['partial extension manifest', manifest => manifest.extensions.pop(), /both known extensions/],
  ['empty extension manifest', manifest => { manifest.extensions = []; }, /both known extensions/],
  ['unknown extension identity', manifest => { manifest.extensions[0].product = 'Other.appex'; }, /unknown, duplicated/],
  ['duplicate extension identity', manifest => { manifest.extensions[1] = manifest.extensions[0]; }, /unknown, duplicated/],
  ['extension version drift', manifest => { manifest.extensions[0].buildNumber = '28'; }, /does not match/],
  ['noncanonical DWARF path', manifest => { manifest.extensions[0].dSYM.dwarfPath = '../AssistShare'; }, /valid arm64 dSYM identity/],
  ['extension hash corruption', manifest => { manifest.extensions[0].dSYM.sha256 = '0'.repeat(64); }, /SHA-256 does not match/],
  ['extension UUID corruption', manifest => { manifest.extensions[0].dSYM.uuids[0].uuid = UUID; }, /UUID list does not match/],
  ['missing extension declaration', manifest => { delete manifest.extensions; }, /unexpected ZIP entry/],
]) {
  test(`verifier refuses ${label}`, async t => {
    const fixture = await makeFixture({extensions: true});
    t.after(() => rm(fixture.root, {force: true, recursive: true}));
    const packaged = packageFixture(fixture);
    assert.equal(packaged.status, 0, packaged.stderr);
    const verified = await tamperArtifact(fixture, transform);
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, expected);
  });
}

test('verifier rejects an extraneous root outside the declared symbol bundles', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  assert.equal(packageFixture(fixture).status, 0);
  const verified = await tamperArtifact(fixture, async (_, expanded) => writeFile(path.join(expanded, 'private-data.txt'), 'not symbols'));
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /unexpected ZIP entry/);
});

test('verifier rejects symlink entries before extraction', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  assert.equal(packageFixture(fixture).status, 0);
  const verified = await tamperArtifact(fixture, async (_, expanded) => symlink('/tmp/outside-symbols', path.join(expanded, 'Assist.app.dSYM', 'unsafe-link')));
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /symlink/);
});

test('packager bounds compressed output and preserves an existing artifact on failure', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  await mkdir(path.dirname(fixture.artifact), {recursive: true});
  await writeFile(fixture.artifact, 'keep previous verified artifact');
  const zip = path.join(fixture.root, 'bin', 'zip');
  await writeFile(zip, `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(process.argv[4], ''); fs.truncateSync(process.argv[4], 512 * 1024 * 1024 + 1);\n`);
  await chmod(zip, 0o755);
  const packaged = packageFixture(fixture);
  assert.notEqual(packaged.status, 0);
  assert.match(packaged.stderr, /compressed symbol artifact exceeds the size limit/);
  assert.equal(await readFile(fixture.artifact, 'utf8'), 'keep previous verified artifact');
});

test('verifier bounds declared uncompressed ZIP sizes before extraction', async t => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, {force: true, recursive: true}));
  assert.equal(packageFixture(fixture).status, 0);
  const bytes = await readFile(fixture.artifact);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const central = bytes.indexOf(signature);
  assert.ok(central >= 0);
  bytes.writeUInt32LE(2 * 1024 * 1024 * 1024, central + 24);
  await writeFile(fixture.artifact, bytes);
  const verified = runNode(verifySymbols, [fixture.artifact], fixture.environment);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /uncompressed size limit/);
});
