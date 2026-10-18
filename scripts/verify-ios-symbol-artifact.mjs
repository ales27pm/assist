#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp, realpath, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DWARF_PATH = path.posix.join('Assist.app.dSYM', 'Contents', 'Resources', 'DWARF', 'Assist');
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// The manifest is portable, unlike a repository-local abbreviated SHA.
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === 'ENOENT' ? `missing command ${command}` : `${command} exited ${result.status}`;
    fail(`Unable to verify the symbol artifact: ${reason}.`);
  }
  return result.stdout;
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
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

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    fail('symbol-identity.json has an unsupported schema version.');
  }
  const build = manifest.build;
  if (
    !build ||
    ![build.bundleIdentifier, build.version, build.buildNumber, build.runtimeVersion].every(
      value => typeof value === 'string' && value.length > 0,
    ) ||
    !GIT_REVISION_PATTERN.test(build.sourceRevision ?? '')
  ) {
    fail('symbol-identity.json is missing a complete build identity.');
  }
  const symbols = manifest.dSYM;
  if (
    !symbols ||
    symbols.bundle !== 'Assist.app.dSYM' ||
    symbols.dwarfPath !== DWARF_PATH ||
    !SHA256_PATTERN.test(symbols.sha256 ?? '') ||
    !Array.isArray(symbols.uuids) ||
    symbols.uuids.length === 0 ||
    !symbols.uuids.every(
      symbol =>
        typeof symbol?.architecture === 'string' && UUID_PATTERN.test(symbol?.uuid ?? ''),
    ) ||
    !symbols.uuids.some(symbol => symbol.architecture === 'arm64')
  ) {
    fail('symbol-identity.json is missing a valid arm64 dSYM identity.');
  }
  return {build, symbols};
}

function validateZipEntries(entries) {
  if (!entries.includes('symbol-identity.json') || !entries.includes(DWARF_PATH)) {
    fail('The artifact must include symbol-identity.json and Assist.app.dSYM DWARF data.');
  }
  for (const entry of entries) {
    if (
      entry.length === 0 ||
      entry.startsWith('/') ||
      entry.includes('\\') ||
      entry.split('/').includes('..') ||
      (entry !== 'symbol-identity.json' && !entry.startsWith('Assist.app.dSYM/'))
    ) {
      fail(`Refusing unexpected ZIP entry: ${entry}`);
    }
  }
}

async function main() {
  const [artifact, ...extraArguments] = process.argv.slice(2);
  if (!artifact || extraArguments.length > 0 || artifact === '--help') {
    console.log('Usage: node scripts/verify-ios-symbol-artifact.mjs <assist-symbols.zip>');
    process.exit(artifact === '--help' ? 0 : 1);
  }
  const archive = path.resolve(artifact);
  if (!(await stat(archive)).isFile()) {
    fail(`Symbol artifact does not exist: ${archive}`);
  }

  const entries = run('unzip', ['-Z1', archive])
    .split(/\r?\n/)
    .filter(Boolean);
  validateZipEntries(entries);
  let manifest;
  try {
    manifest = JSON.parse(run('unzip', ['-p', archive, 'symbol-identity.json']));
  } catch {
    fail('symbol-identity.json is not valid JSON.');
  }
  const {build, symbols} = validateManifest(manifest);

  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), 'assist-ios-symbol-verify-'));
  try {
    run('unzip', ['-qq', archive, '-d', extractionRoot]);
    const dSYMRoot = path.join(extractionRoot, 'Assist.app.dSYM');
    const dwarfPath = path.join(dSYMRoot, 'Contents', 'Resources', 'DWARF', 'Assist');
    const resolvedDwarf = await realpath(dwarfPath);
    const resolvedDsymRoot = await realpath(dSYMRoot);
    if (!pathInside(resolvedDsymRoot, resolvedDwarf)) {
      fail('The DWARF file resolves outside Assist.app.dSYM.');
    }
    if ((await stat(resolvedDwarf)).isFile() === false) {
      fail('Assist.app.dSYM does not contain a DWARF file.');
    }
    const actualHash = await sha256(resolvedDwarf);
    if (actualHash !== symbols.sha256) {
      fail('The DWARF SHA-256 does not match symbol-identity.json.');
    }
    const actualUuids = readDwarfUuids(resolvedDwarf);
    const expectedUuids = [...symbols.uuids].sort((left, right) =>
      `${left.architecture}:${left.uuid}`.localeCompare(`${right.architecture}:${right.uuid}`),
    );
    if (JSON.stringify(actualUuids) !== JSON.stringify(expectedUuids)) {
      fail('The dSYM UUID list does not match symbol-identity.json.');
    }
  } finally {
    await rm(extractionRoot, {force: true, recursive: true});
  }

  console.log(`Verified iOS symbols for ${build.bundleIdentifier} ${build.version} (${build.buildNumber}).`);
  console.log(`Runtime: ${build.runtimeVersion}`);
  console.log(`Source revision: ${build.sourceRevision}`);
  console.log(`dSYM SHA-256: ${symbols.sha256}`);
  for (const {architecture, uuid} of symbols.uuids) {
    console.log(`dSYM UUID (${architecture}): ${uuid}`);
  }
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
