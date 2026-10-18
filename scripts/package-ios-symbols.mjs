#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DWARF_RELATIVE_PATH = path.join(
  'Contents',
  'Resources',
  'DWARF',
  'Assist',
);
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
// A shortened SHA is only unique relative to a particular repository snapshot.
// The artifact is meant to identify its source independently, so retain a full
// SHA-1 or SHA-256 object name instead.
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

async function listDsymBundles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const bundles = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'Assist.app.dSYM') {
        bundles.push(entryPath);
      } else {
        bundles.push(...(await listDsymBundles(entryPath)));
      }
    }
  }
  return bundles;
}

async function locateDsym(buildRoot) {
  const canonical = path.join(
    buildRoot,
    'Build',
    'Products',
    'Release-iphoneos',
    'Assist.app.dSYM',
  );
  if (await isFile(path.join(canonical, DWARF_RELATIVE_PATH))) {
    return canonical;
  }

  let candidates = [];
  try {
    candidates = await listDsymBundles(buildRoot);
  } catch {
    fail(`No iOS build output exists at ${buildRoot}.`);
  }
  candidates = (
    await Promise.all(
      candidates.map(async candidate => ({
        candidate,
        hasDwarf: await isFile(path.join(candidate, DWARF_RELATIVE_PATH)),
      })),
    )
  )
    .filter(({hasDwarf}) => hasDwarf)
    .map(({candidate}) => candidate);

  if (candidates.length === 0) {
    fail(`No Assist.app.dSYM with ${DWARF_RELATIVE_PATH} was produced by the iOS build.`);
  }
  if (candidates.length !== 1) {
    fail('More than one Assist.app.dSYM was found; refusing to package an ambiguous symbol bundle.');
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
    fail('dwarfdump did not report an arm64 UUID for Assist.app.dSYM.');
  }
  return uuids.sort((left, right) => `${left.architecture}:${left.uuid}`.localeCompare(`${right.architecture}:${right.uuid}`));
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function readBuildSetting(project, name) {
  const expression = new RegExp(`\\b${name}\\s*=\\s*([^;]+);`, 'g');
  const values = [...project.matchAll(expression)]
    .map(match => match[1].trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length !== 1 || uniqueValues[0].includes('$')) {
    fail(`Expected exactly one concrete ${name} in Assist.xcodeproj.`);
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
  const xcodeProject = await readFile(
    path.join(projectRoot, 'ios', 'Assist.xcodeproj', 'project.pbxproj'),
    'utf8',
  );
  const expoPlist = await readFile(
    path.join(projectRoot, 'ios', 'Assist', 'Supporting', 'Expo.plist'),
    'utf8',
  );
  return {
    bundleIdentifier: readBuildSetting(xcodeProject, 'PRODUCT_BUNDLE_IDENTIFIER'),
    version: readBuildSetting(xcodeProject, 'MARKETING_VERSION'),
    buildNumber: readBuildSetting(xcodeProject, 'CURRENT_PROJECT_VERSION'),
    runtimeVersion: readExpoRuntime(expoPlist),
    sourceRevision,
    ...(process.env.EAS_BUILD_ID ? {easBuildId: process.env.EAS_BUILD_ID} : {}),
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
  const identity = await readIdentity(projectRoot, sourceRevision);
  const dSYM = await locateDsym(path.join(projectRoot, 'ios', 'build'));
  const dwarfPath = path.join(dSYM, DWARF_RELATIVE_PATH);
  const manifest = {
    schemaVersion: 1,
    build: identity,
    dSYM: {
      bundle: 'Assist.app.dSYM',
      dwarfPath: path.posix.join('Assist.app.dSYM', 'Contents', 'Resources', 'DWARF', 'Assist'),
      sha256: await sha256(dwarfPath),
      uuids: readDwarfUuids(dwarfPath),
    },
  };

  const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), 'assist-ios-symbols-'));
  try {
    await cp(dSYM, path.join(stagingDirectory, 'Assist.app.dSYM'), {
      force: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    await writeFile(
      path.join(stagingDirectory, 'symbol-identity.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await mkdir(path.dirname(output), {recursive: true});
    await rm(output, {force: true});
    run('zip', ['-q', '-r', output, 'Assist.app.dSYM', 'symbol-identity.json'], {
      cwd: stagingDirectory,
    });
    if (!(await isFile(output))) {
      fail('zip completed without producing the requested symbol artifact.');
    }
  } finally {
    await rm(stagingDirectory, {force: true, recursive: true});
  }

  console.log(`Created verified iOS symbol artifact: ${path.relative(projectRoot, output)}`);
  console.log(`dSYM SHA-256: ${manifest.dSYM.sha256}`);
  for (const {architecture, uuid} of manifest.dSYM.uuids) {
    console.log(`dSYM UUID (${architecture}): ${uuid}`);
  }
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
