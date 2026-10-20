#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createRequire} from 'node:module';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
// A shortened SHA is only unique relative to a particular repository snapshot.
// The artifact is meant to identify its source independently, so retain a full
// SHA-1 or SHA-256 object name instead.
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const EXTENSIONS = [
  {name: 'AssistShare', product: 'AssistShare.appex', suffix: '.share'},
  {name: 'AssistWidget', product: 'AssistWidget.appex', suffix: '.widget'},
];
const MAX_SYMBOL_BYTES = 1024 * 1024 * 1024;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_SYMBOL_FILES = 4096;
const MAX_IPA_FILES = 16384;
const MAX_IPA_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IPA_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_IPA_INFO_BYTES = 128 * 1024;

function fail(message) {
  throw new Error(message);
}

function nextArgument(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${flag} requires a value.`);
  }
  return value;
}

function parseArguments(args) {
  const options = {
    output: 'artifacts/ios/assist-symbols.zip',
    projectRoot: '.',
    sourceRevision: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      options.output = nextArgument(args, index, argument);
      index += 1;
    } else if (argument === '--project-root') {
      options.projectRoot = nextArgument(args, index, argument);
      index += 1;
    } else if (argument === '--source-revision') {
      options.sourceRevision = nextArgument(args, index, argument);
      index += 1;
    } else if (argument === '--help') {
      console.log(
        'Usage: node scripts/package-ios-symbols.mjs [--project-root <mobile-dir>] [--output <zip>] [--source-revision <git-sha>]',
      );
      process.exit(0);
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function listDsymBundles(directory, bundleName = 'Assist.app.dSYM', depth = 0, budget = {entries: 0}) {
  if (depth > 14) fail('iOS build output is too deeply nested to identify its symbols.');
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const bundles = [];
  for (const entry of entries) {
    if (++budget.entries > 50000) fail('iOS build output is too large to identify its symbols safely.');
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === bundleName) {
        bundles.push(entryPath);
      } else if (!/\.(?:app|appex|framework|dSYM)$/.test(entry.name) && !['ModuleCache.noindex', 'Index.noindex'].includes(entry.name)) {
        bundles.push(...(await listDsymBundles(entryPath, bundleName, depth + 1, budget)));
      }
    }
  }
  return bundles;
}

async function locateDsym(buildRoot, name = 'Assist', product = 'Assist.app') {
  const dwarfRelativePath = path.join('Contents', 'Resources', 'DWARF', name);
  const bundleName = `${product}.dSYM`;
  // A canonical Products path can be an Xcode alias into ArchiveIntermediates.
  // Discover physical bundles only; stat() on that alias would follow links
  // before requireRegularPath can reject them and hide the real bundle.
  let candidates = [];
  try {
    const root = await lstat(buildRoot);
    if (root.isSymbolicLink()) fail('Build product paths must not contain symlinks (.).');
    candidates = await listDsymBundles(buildRoot, bundleName);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`No iOS build output exists at ${buildRoot}.`);
    throw error;
  }
  candidates = (
    await Promise.all(
      candidates.map(async candidate => ({
        candidate,
        hasDwarf: await isFile(path.join(candidate, dwarfRelativePath)),
      })),
    )
  )
    .filter(({hasDwarf}) => hasDwarf)
    .map(({candidate}) => candidate);

  if (candidates.length === 0) {
    fail(`No ${bundleName} with ${dwarfRelativePath} was produced by the iOS build.`);
  }
  if (candidates.length !== 1) {
    fail(`More than one ${bundleName} was found; refusing to package an ambiguous symbol bundle.`);
  }
  return candidates[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === 'ENOENT' ? `missing command ${command}` : `${command} exited ${result.status}`;
    fail(`Unable to create a verified symbol artifact: ${reason}.`);
  }
  return result.stdout;
}

function readDwarfUuids(dwarfPath) {
  const output = run('dwarfdump', ['--uuid', dwarfPath]);
  const uuids = [];
  for (const match of output.matchAll(/UUID:\s*([0-9a-f-]{36})\s+\(([^)]+)\)/gi)) {
    const uuid = match[1].toUpperCase();
    const architecture = match[2].trim();
    if (UUID_PATTERN.test(uuid)) {
      uuids.push({architecture, uuid});
    }
  }
  if (uuids.length === 0 || !uuids.some(({architecture}) => architecture === 'arm64')) {
    fail(`dwarfdump did not report an arm64 UUID for ${path.basename(dwarfPath)}.`);
  }
  if (new Set(uuids.map(row => row.architecture)).size !== uuids.length) fail('Duplicate architecture in the symbol UUID list.');
  return uuids.sort((left, right) => `${left.architecture}:${left.uuid}`.localeCompare(`${right.architecture}:${right.uuid}`));
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function readBuildSetting(configurations, name) {
  const values = configurations
    .map(configuration => String(configuration.buildSettings?.[name] ?? '').replace(/^"|"$/g, ''))
    .filter(Boolean);
  const uniqueValues = [...new Set(values)];
  if (values.length !== configurations.length || uniqueValues.length !== 1 || uniqueValues[0].includes('$')) {
    fail(`Expected exactly one concrete ${name} across the selected target configurations.`);
  }
  return uniqueValues[0];
}

function readExpoRuntime(expoPlist) {
  const match = expoPlist.match(/<key>EXUpdatesRuntimeVersion<\/key>\s*<string>([^<]+)<\/string>/);
  if (!match?.[1]?.trim()) {
    fail('EXUpdatesRuntimeVersion is missing from ios/Assist/Supporting/Expo.plist.');
  }
  return match[1].trim();
}

function normalizeRevision(revision) {
  const normalized = revision?.trim().toLowerCase();
  return normalized && GIT_REVISION_PATTERN.test(normalized) ? normalized : undefined;
}

function requireValidRevision(revision, source) {
  if (revision === undefined) {
    return undefined;
  }
  const normalized = normalizeRevision(revision);
  if (!normalized) {
    fail(`${source} must be a full 40- or 64-character Git revision.`);
  }
  return normalized;
}

function resolveSourceRevision(projectRoot, suppliedRevision) {
  const fromArgument = requireValidRevision(suppliedRevision, '--source-revision');
  if (fromArgument) {
    return fromArgument;
  }
  const fromEas = requireValidRevision(
    process.env.EAS_BUILD_GIT_COMMIT_HASH,
    'EAS_BUILD_GIT_COMMIT_HASH',
  );
  if (fromEas) {
    return fromEas;
  }
  const gitResult = spawnSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'});
  const fromGit = gitResult.status === 0 ? normalizeRevision(gitResult.stdout) : undefined;
  if (fromGit) {
    return fromGit;
  }
  fail('A Git source revision is required (EAS_BUILD_GIT_COMMIT_HASH or --source-revision).');
}

async function readIdentity(projectRoot, sourceRevision) {
  const project = require('xcode').project(path.join(projectRoot, 'ios', 'Assist.xcodeproj', 'project.pbxproj'));
  project.parseSync();
  const objects = project.hash.project.objects;
  const unquote = value => String(value ?? '').replace(/^"|"$/g, '');
  const reference = value => typeof value === 'object' ? value.value : value;
  const targets = Object.values(objects.PBXNativeTarget ?? {}).filter(value => value?.isa === 'PBXNativeTarget');
  const mainTargets = targets.filter(target => unquote(target.name) === 'Assist' && unquote(target.productType) === 'com.apple.product-type.application');
  if (mainTargets.length !== 1) fail('Expected exactly one Assist application native target.');
  function configurations(target) {
    const list = objects.XCConfigurationList?.[reference(target.buildConfigurationList)];
    const configs = list?.buildConfigurations?.map(ref => objects.XCBuildConfiguration?.[reference(ref)]);
    if (!configs?.length || configs.some(config => !config?.buildSettings) || !configs.some(config => unquote(config.name) === 'Release')) {
      fail(`Missing native target configurations for ${unquote(target.name)}.`);
    }
    return configs;
  }
  const mainConfigurations = configurations(mainTargets[0]);
  const extensionTargets = targets.filter(target => unquote(target.productType) === 'com.apple.product-type.app-extension');
  if (extensionTargets.length && (extensionTargets.length !== EXTENSIONS.length || EXTENSIONS.some(extension => extensionTargets.filter(target => unquote(target.name) === extension.name).length !== 1))) {
    fail('Expected both AssistShare and AssistWidget native extension targets, or neither for a legacy build.');
  }
  const expoPlist = await readFile(
    path.join(projectRoot, 'ios', 'Assist', 'Supporting', 'Expo.plist'),
    'utf8',
  );
  const build = {
    bundleIdentifier: readBuildSetting(mainConfigurations, 'PRODUCT_BUNDLE_IDENTIFIER'),
    version: readBuildSetting(mainConfigurations, 'MARKETING_VERSION'),
    buildNumber: readBuildSetting(mainConfigurations, 'CURRENT_PROJECT_VERSION'),
    runtimeVersion: readExpoRuntime(expoPlist),
    sourceRevision,
    ...(process.env.EAS_BUILD_ID ? {easBuildId: process.env.EAS_BUILD_ID} : {}),
  };
  if (!/^[A-Za-z0-9.-]{1,200}$/.test(build.bundleIdentifier) || !/^\d+(?:\.\d+){0,2}$/.test(build.version) || !/^\d+(?:\.\d+){0,2}$/.test(build.buildNumber)) {
    fail('The Assist target build identity is not concrete or valid.');
  }
  const extensions = extensionTargets.length ? EXTENSIONS.map(extension => {
    const configs = configurations(extensionTargets.find(target => unquote(target.name) === extension.name));
    const identity = {
      bundleIdentifier: readBuildSetting(configs, 'PRODUCT_BUNDLE_IDENTIFIER'),
      version: readBuildSetting(configs, 'MARKETING_VERSION'),
      buildNumber: readBuildSetting(configs, 'CURRENT_PROJECT_VERSION'),
    };
    if (identity.bundleIdentifier !== `${build.bundleIdentifier}${extension.suffix}` || identity.version !== build.version || identity.buildNumber !== build.buildNumber) {
      fail(`The ${extension.name} target identity does not match the Assist application.`);
    }
    return {...extension, ...identity};
  }) : [];
  return {build, extensions};
}

// Only regular files and directories are copied. A dSYM must never smuggle an
// external symlink or an unbounded tree into the portable release artifact.
async function validateSymbolTree(directory, budget = {files: 0, bytes: 0}, depth = 0, root = directory) {
  if (depth > 12) fail('Symbol bundle exceeds the directory depth limit.');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Symbol bundles must be regular directories without symlinks.');
  for (const entry of await readdir(directory)) {
    const candidate = path.join(directory, entry);
    const relative = path.relative(root, candidate).split(path.sep).join('/');
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.length > 480) fail('Symbol bundles contain a noncanonical file path.');
    const details = await lstat(candidate);
    if (++budget.files > MAX_SYMBOL_FILES) fail('Symbol bundles exceed the file count limit.');
    if (details.isDirectory()) {
      await validateSymbolTree(candidate, budget, depth + 1, root);
    } else if (details.isFile() && !details.isSymbolicLink()) {
      budget.bytes += details.size;
      if (budget.bytes > MAX_SYMBOL_BYTES) fail('Symbol bundles exceed the uncompressed size limit.');
    } else {
      fail('Symbol bundles must not contain symlinks or special files.');
    }
  }
}

async function requireRegularPath(buildRoot, candidate, directory = false) {
  if (!pathInside(buildRoot, candidate)) fail('Build product resolves outside the iOS build output.');
  let current = buildRoot;
  for (const part of path.relative(buildRoot, candidate).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`Build product paths must not contain symlinks (${path.relative(buildRoot, current).split(path.sep).join('/')}).`);
    if (current === candidate ? (directory ? !info.isDirectory() : !info.isFile()) : !info.isDirectory()) {
      fail('Build product path is not a regular file or directory.');
    }
  }
}

// Read the bounded directory before asking unzip for six fixed product files.
// No archive-supplied path is ever used as an extraction destination.
async function inspectExportedIpa(archive) {
  const handle = await open(archive, 'r');
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size < 22 || details.size > MAX_ZIP_BYTES) fail('The exported IPA exceeds its compressed size limit or is invalid.');
    async function readAt(length, offset) {
      const bytes = Buffer.alloc(length);
      if ((await handle.read(bytes, 0, length, offset)).bytesRead !== length) fail('The exported IPA is truncated.');
      return bytes;
    }
    const tailOffset = Math.max(0, details.size - 65557);
    const tail = await readAt(details.size - tailOffset, tailOffset);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
        end = offset;
        break;
      }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) fail('Invalid or unsupported exported IPA directory.');
    const count = tail.readUInt16LE(end + 10);
    const size = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (!count || count > MAX_IPA_FILES || count !== tail.readUInt16LE(end + 8) || size > 16 * 1024 * 1024 || offset + size !== tailOffset + end) fail('The exported IPA directory exceeds its limits or is invalid.');
    const central = await readAt(size, offset);
    const entries = new Map();
    let position = 0;
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (position + 46 > central.length || central.readUInt32LE(position) !== 0x02014b50) fail('Invalid exported IPA central entry.');
      const flags = central.readUInt16LE(position + 8);
      const method = central.readUInt16LE(position + 10);
      const compressedSize = central.readUInt32LE(position + 20);
      const bytes = central.readUInt32LE(position + 24);
      const nameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const mode = (central.readUInt32LE(position + 38) >>> 16) & 0o170000;
      const localOffset = central.readUInt32LE(position + 42);
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || (flags & 1) || ![0, 8].includes(method) || ![0, 0o040000, 0o100000].includes(mode) || central.readUInt16LE(position + 34)) fail('Unsupported exported IPA entry, encryption, or symlink.');
      const name = central.subarray(position + 46, position + 46 + nameLength).toString('utf8');
      const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
      const directory = name.endsWith('/');
      if (!normalized || name.length > 1024 || /[\\\x00-\x1f\x7f\ufffd]/.test(name) || name.startsWith('/') || normalized.split('/').some(part => ['', '.', '..'].includes(part)) || entries.has(normalized) || (mode === 0o040000 && !directory) || (mode === 0o100000 && directory)) fail('Invalid or duplicate exported IPA entry path.');
      total += bytes;
      if (total > MAX_IPA_UNCOMPRESSED_BYTES) fail('The exported IPA exceeds its uncompressed size limit.');
      if (localOffset + 30 > offset) fail('Invalid exported IPA local offset.');
      const local = await readAt(30, localOffset);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || localOffset + 30 + localNameLength + localExtraLength + compressedSize > offset || (await readAt(localNameLength, localOffset + 30)).toString('utf8') !== name) fail('Invalid or inconsistent exported IPA local entry.');
      entries.set(normalized, {name, bytes, directory});
      position = next;
    }
    if (position !== central.length) fail('Unexpected data in the exported IPA directory.');
    for (const name of entries.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (entries.get(parts.slice(0, i).join('/'))?.directory === false) fail('The exported IPA contains conflicting file and directory paths.');
      }
    }
    return {entries, bytes: details.size};
  } finally {
    await handle.close();
  }
}

async function extractExportedProducts(buildRoot, staging, extensions) {
  const archive = path.join(buildRoot, 'Assist.ipa');
  try {
    await lstat(archive);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  await requireRegularPath(buildRoot, archive);
  const {entries, bytes} = await inspectExportedIpa(archive);
  const digest = await sha256(archive);
  const payload = new Set();
  const plugins = new Set();
  for (const name of entries.keys()) {
    const parts = name.split('/');
    if (parts[0] === 'Payload' && parts.length > 1) payload.add(parts[1]);
    if (parts.slice(0, 3).join('/') === 'Payload/Assist.app/PlugIns' && parts.length > 3) plugins.add(parts[3]);
  }
  if (JSON.stringify([...payload].sort()) !== JSON.stringify(['Assist.app']) || JSON.stringify([...plugins].sort()) !== JSON.stringify(extensions.map(extension => extension.product).sort())) fail('The exported IPA products do not match the declared native targets.');
  const application = path.join(staging, 'Payload', 'Assist.app');
  for (const product of [{name: 'Assist', relative: 'Payload/Assist.app'}, ...extensions.map(extension => ({name: extension.name, relative: `Payload/Assist.app/PlugIns/${extension.product}`}))]) {
    for (const file of ['Info.plist', product.name]) {
      const name = `${product.relative}/${file}`;
      const entry = entries.get(name);
      const maximum = file === 'Info.plist' ? MAX_IPA_INFO_BYTES : MAX_IPA_EXECUTABLE_BYTES;
      if (!entry || entry.directory || !entry.bytes || entry.bytes > maximum) fail('A required exported IPA product file is missing or exceeds its size limit.');
      const result = spawnSync('unzip', ['-p', archive, name], {encoding: null, maxBuffer: entry.bytes + 1, timeout: 60000});
      if (result.error || result.status !== 0 || result.stdout.length !== entry.bytes) fail('Unable to extract a bounded exported IPA product file with valid ZIP integrity.');
      const destination = path.join(staging, ...product.relative.split('/'), file);
      await mkdir(path.dirname(destination), {recursive: true});
      await writeFile(destination, result.stdout, {flag: 'wx', mode: 0o600});
    }
  }
  if (await sha256(archive) !== digest) fail('The exported IPA changed during inspection.');
  return {application, identity: {sha256: digest, bytes, executableHashStage: 'exported_ipa'}};
}

async function locateApplication(buildRoot, dSYM, required) {
  const parent = path.dirname(dSYM);
  const candidates = [];
  const archiveIntermediates = path.join(buildRoot, 'Build', 'Intermediates.noindex', 'ArchiveIntermediates', 'Assist');
  if (parent === path.join(archiveIntermediates, 'BuildProductsPath', 'Release-iphoneos')) {
    // Xcode archive creates a sibling Assist.app symlink here. Select its
    // documented installed product directly; never resolve an arbitrary link.
    candidates.push(path.join(archiveIntermediates, 'InstallationBuildProductsLocation', 'Applications', 'Assist.app'));
  }
  candidates.push(path.join(parent, 'Assist.app'));
  if (path.basename(parent) === 'dSYMs' && path.dirname(parent).endsWith('.xcarchive')) {
    candidates.push(path.join(path.dirname(parent), 'Products', 'Applications', 'Assist.app'));
  }
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        fail(`Build product paths must not contain symlinks (${path.relative(buildRoot, candidate).split(path.sep).join('/')}). The exact ios/build/Assist.ipa is required after Xcode moves archived products.`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    await requireRegularPath(buildRoot, candidate, true);
    return candidate;
  }
  if (required) fail('The built Assist.app is required to verify extension products and their matching dSYM UUIDs.');
  return undefined;
}

async function readProduct(buildRoot, productRoot, expected, symbols) {
  await requireRegularPath(buildRoot, productRoot, true);
  const plistPath = path.join(productRoot, 'Info.plist');
  await requireRegularPath(buildRoot, plistPath);
  let info;
  try {
    info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plistPath]));
  } catch {
    fail(`Unable to read the built ${expected.product} Info.plist.`);
  }
  if (info.CFBundleIdentifier !== expected.bundleIdentifier || info.CFBundleShortVersionString !== expected.version || info.CFBundleVersion !== expected.buildNumber || info.CFBundleExecutable !== expected.name) {
    fail(`The built ${expected.product} identity does not match its native target.`);
  }
  const executable = path.join(productRoot, expected.name);
  await requireRegularPath(buildRoot, executable);
  if (JSON.stringify(readDwarfUuids(executable)) !== JSON.stringify(symbols.uuids)) {
    fail(`The built ${expected.product} executable and dSYM UUIDs do not match.`);
  }
  return sha256(executable);
}

async function symbolIdentity(bundlePath, name, product) {
  const dwarfPath = path.join(bundlePath, 'Contents', 'Resources', 'DWARF', name);
  return {
    bundle: `${product}.dSYM`,
    dwarfPath: path.posix.join(`${product}.dSYM`, 'Contents', 'Resources', 'DWARF', name),
    sha256: await sha256(dwarfPath),
    uuids: readDwarfUuids(dwarfPath),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = path.resolve(options.projectRoot);
  const output = path.resolve(projectRoot, options.output);
  if (!pathInside(projectRoot, output)) {
    fail('The symbol artifact output must be inside the mobile project directory.');
  }

  const sourceRevision = resolveSourceRevision(projectRoot, options.sourceRevision);
  const {build, extensions} = await readIdentity(projectRoot, sourceRevision);
  const buildRoot = path.join(projectRoot, 'ios', 'build');
  const dSYM = await locateDsym(buildRoot);
  await requireRegularPath(buildRoot, dSYM, true);
  // Reserve root entries and the bounded manifest in the archive's shared quota.
  const budget = {files: extensions.length + 2, bytes: 64 * 1024};
  await validateSymbolTree(dSYM, budget);
  const manifest = {
    schemaVersion: 1,
    build,
    dSYM: await symbolIdentity(dSYM, 'Assist', 'Assist.app'),
  };
  const bundles = [{directory: dSYM, bundle: manifest.dSYM.bundle}];
  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'assist-ios-symbols-'));
  try {
    const exported = await extractExportedProducts(buildRoot, stagingDirectory, extensions);
    const productRoot = exported ? stagingDirectory : buildRoot;
    const application = exported?.application ?? await locateApplication(buildRoot, dSYM, extensions.length > 0);
    if (application) {
      manifest.executableHashStage = exported ? 'exported_ipa' : 'archive_build_product';
      manifest.executableSHA256 = await readProduct(productRoot, application, {name: 'Assist', product: 'Assist.app', ...build}, manifest.dSYM);
      if (exported) manifest.exportedIPA = exported.identity;
      const plugins = path.join(application, 'PlugIns');
      let embedded = [];
      try {
        await requireRegularPath(productRoot, plugins, true);
        embedded = await readdir(plugins);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (embedded.length !== extensions.length || embedded.some(product => !extensions.some(extension => extension.product === product))) {
        fail('The built Assist.app extension products do not match the declared native targets.');
      }
      const extensionEntries = [];
      for (const extension of extensions) {
        const bundle = path.join(path.dirname(dSYM), `${extension.product}.dSYM`);
        await requireRegularPath(buildRoot, bundle, true);
        await validateSymbolTree(bundle, budget);
        const symbols = await symbolIdentity(bundle, extension.name, extension.product);
        const executableSHA256 = await readProduct(productRoot, path.join(plugins, extension.product), extension, symbols);
        extensionEntries.push({
          product: extension.product,
          executable: extension.name,
          bundleIdentifier: extension.bundleIdentifier,
          version: extension.version,
          buildNumber: extension.buildNumber,
          executableSHA256,
          executableHashStage: manifest.executableHashStage,
          dSYM: symbols,
        });
        bundles.push({directory: bundle, bundle: symbols.bundle});
      }
      if (extensionEntries.length) manifest.extensions = extensionEntries;
    }
    for (const bundle of bundles) {
      await cp(bundle.directory, path.join(stagingDirectory, bundle.bundle), {
        force: false, preserveTimestamps: true, recursive: true,
      });
    }
    await writeFile(
      path.join(stagingDirectory, 'symbol-identity.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await mkdir(path.dirname(output), {recursive: true});
    const stagedOutput = path.join(stagingDirectory, 'assist-symbols.zip');
    run('zip', ['-q', '-r', stagedOutput, ...bundles.map(bundle => bundle.bundle), 'symbol-identity.json'], {
      cwd: stagingDirectory,
    });
    if (!(await isFile(stagedOutput))) {
      fail('zip completed without producing the requested symbol artifact.');
    }
    if ((await stat(stagedOutput)).size > MAX_ZIP_BYTES) fail('The compressed symbol artifact exceeds the size limit.');
    // Copy to the destination filesystem before the final rename; a failed
    // package never replaces a previously verified artifact.
    const localStaging = await mkdtemp(path.join(path.dirname(output), '.assist-symbols-'));
    try {
      const temporaryOutput = path.join(localStaging, 'assist-symbols.zip');
      await cp(stagedOutput, temporaryOutput, {errorOnExist: true, force: false});
      await rename(temporaryOutput, output);
    } finally {
      await rm(localStaging, {force: true, recursive: true});
    }
  } finally {
    await rm(stagingDirectory, {force: true, recursive: true});
  }

  console.log(`Created verified iOS symbol artifact: ${path.relative(projectRoot, output)}`);
  console.log(`dSYM SHA-256: ${manifest.dSYM.sha256}`);
  for (const {architecture, uuid} of manifest.dSYM.uuids) {
    console.log(`dSYM UUID (${architecture}): ${uuid}`);
  }
  for (const extension of manifest.extensions ?? []) {
    console.log(`Extension dSYM: ${extension.dSYM.bundle} (${extension.dSYM.uuids.map(row => row.uuid).join(', ')})`);
  }
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
