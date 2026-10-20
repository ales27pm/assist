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

async function locateDsym(buildRoot, name = 'Assist', product = 'Assist.app', anchor) {
  const dwarfRelativePath = path.join('Contents', 'Resources', 'DWARF', name);
  const bundleName = `${product}.dSYM`;
  const canonical = path.join(
    anchor ?? path.join(buildRoot, 'Build', 'Products', 'Release-iphoneos'), bundleName,
  );
  if (await isFile(path.join(canonical, dwarfRelativePath))) {
    return canonical;
  }

  let candidates = [];
  try {
    candidates = await listDsymBundles(buildRoot, bundleName);
  } catch {
    fail(`No iOS build output exists at ${buildRoot}.`);
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
    if (info.isSymbolicLink()) fail('Build product paths must not contain symlinks.');
    if (current === candidate ? (directory ? !info.isDirectory() : !info.isFile()) : !info.isDirectory()) {
      fail('Build product path is not a regular file or directory.');
    }
  }
}

async function locateApplication(buildRoot, dSYM, required) {
  const parent = path.dirname(dSYM);
  const candidates = [path.join(parent, 'Assist.app')];
  if (path.basename(parent) === 'dSYMs' && path.dirname(parent).endsWith('.xcarchive')) {
    candidates.push(path.join(path.dirname(parent), 'Products', 'Applications', 'Assist.app'));
  }
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
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
  const application = await locateApplication(buildRoot, dSYM, extensions.length > 0);
  if (application) {
    await readProduct(buildRoot, application, {name: 'Assist', product: 'Assist.app', ...build}, manifest.dSYM);
    const plugins = path.join(application, 'PlugIns');
    let embedded = [];
    try {
      await requireRegularPath(buildRoot, plugins, true);
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
      const executableSHA256 = await readProduct(buildRoot, path.join(plugins, extension.product), extension, symbols);
      extensionEntries.push({
        product: extension.product,
        executable: extension.name,
        bundleIdentifier: extension.bundleIdentifier,
        version: extension.version,
        buildNumber: extension.buildNumber,
        executableSHA256,
        dSYM: symbols,
      });
      bundles.push({directory: bundle, bundle: symbols.bundle});
    }
    if (extensionEntries.length) manifest.extensions = extensionEntries;
  }

  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'assist-ios-symbols-'));
  try {
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
