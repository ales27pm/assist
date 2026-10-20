#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdtemp, open, readdir, realpath, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// The manifest is portable, unlike a repository-local abbreviated SHA.
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_SYMBOL_BYTES = 1024 * 1024 * 1024;
const MAX_SYMBOL_FILES = 4096;
const EXTENSIONS = [
  {name: 'AssistShare', product: 'AssistShare.appex', suffix: '.share'},
  {name: 'AssistWidget', product: 'AssistWidget.appex', suffix: '.widget'},
];

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

function validateSymbols(symbols, product, executable) {
  if (
    !symbols ||
    symbols.bundle !== `${product}.dSYM` ||
    symbols.dwarfPath !== path.posix.join(`${product}.dSYM`, 'Contents', 'Resources', 'DWARF', executable) ||
    !SHA256_PATTERN.test(symbols.sha256 ?? '') ||
    !Array.isArray(symbols.uuids) ||
    symbols.uuids.length === 0 || symbols.uuids.length > 8 ||
    !symbols.uuids.every(symbol => typeof symbol?.architecture === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(symbol.architecture) && UUID_PATTERN.test(symbol?.uuid ?? '')) ||
    !symbols.uuids.some(symbol => symbol.architecture === 'arm64') ||
    new Set(symbols.uuids.map(symbol => symbol.architecture)).size !== symbols.uuids.length
  ) {
    fail(`symbol-identity.json is missing a valid arm64 dSYM identity for ${product}.`);
  }
  return symbols;
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) {
    fail('symbol-identity.json has an unsupported schema version.');
  }
  const build = manifest.build;
  if (
    !build ||
    ![build.bundleIdentifier, build.version, build.buildNumber, build.runtimeVersion].every(
      value => typeof value === 'string' && value.length > 0 && value.length <= 200,
    ) ||
    !GIT_REVISION_PATTERN.test(build.sourceRevision ?? '')
  ) {
    fail('symbol-identity.json is missing a complete build identity.');
  }
  const symbols = validateSymbols(manifest.dSYM, 'Assist.app', 'Assist');
  const extensions = manifest.extensions;
  if (extensions !== undefined) {
    if (!Array.isArray(extensions) || extensions.length !== EXTENSIONS.length) fail('The extension symbol identity must include both known extensions.');
    for (const expected of EXTENSIONS) {
      const matches = extensions.filter(extension => extension?.product === expected.product);
      const extension = matches[0];
      if (matches.length !== 1 || extension.executable !== expected.name || extension.bundleIdentifier !== `${build.bundleIdentifier}${expected.suffix}` || extension.version !== build.version || extension.buildNumber !== build.buildNumber || !SHA256_PATTERN.test(extension.executableSHA256 ?? '')) {
        fail('The extension symbol identity is unknown, duplicated, or does not match the application.');
      }
      validateSymbols(extension.dSYM, expected.product, expected.name);
    }
  }
  return {build, symbols, symbolBundles: [symbols, ...(extensions ?? []).map(extension => extension.dSYM)]};
}

function validateZipEntries(entries, symbolBundles) {
  if (!entries.includes('symbol-identity.json') || symbolBundles.some(symbol => !entries.includes(symbol.dwarfPath))) {
    fail('The artifact must include symbol-identity.json and Assist.app.dSYM DWARF data.');
  }
  for (const entry of entries) {
    if (
      entry.length === 0 ||
      entry.startsWith('/') ||
      entry.includes('\\') ||
      entry.split('/').some(part => ['.', '..'].includes(part)) ||
      !/^[A-Za-z0-9_./-]+$/.test(entry) ||
      (entry !== 'symbol-identity.json' && !symbolBundles.some(symbol => entry.startsWith(`${symbol.bundle}/`)))
    ) {
      fail(`Refusing unexpected ZIP entry: ${entry}`);
    }
  }
}

// Inspect the bounded ZIP central directory before extraction. This deliberately
// rejects ZIP64/multidisk/encrypted archives: our small symbol artifacts need none
// of them. Checking Unix file modes here prevents symlink traversal by unzip.
async function inspectZip(archive) {
  const handle = await open(archive, 'r');
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_ZIP_BYTES || details.size < 22) fail('The compressed symbol artifact is missing or exceeds the size limit.');
    async function readAt(length, offset) {
      const bytes = Buffer.alloc(length);
      const result = await handle.read(bytes, 0, length, offset);
      if (result.bytesRead !== length) fail('The symbol ZIP is truncated.');
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
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) fail('Unsupported or invalid symbol ZIP directory.');
    const count = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (!count || count > MAX_SYMBOL_FILES || count !== tail.readUInt16LE(end + 8) || centralSize > 1024 * 1024 || centralOffset + centralSize !== tailOffset + end) fail('The symbol ZIP exceeds its entry limits or has an invalid directory.');
    const central = await readAt(centralSize, centralOffset);
    const entries = [];
    let position = 0;
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (position + 46 > central.length || central.readUInt32LE(position) !== 0x02014b50) fail('Invalid ZIP central entry.');
      const flags = central.readUInt16LE(position + 8);
      const method = central.readUInt16LE(position + 10);
      const compressedSize = central.readUInt32LE(position + 20);
      const size = central.readUInt32LE(position + 24);
      const nameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const mode = (central.readUInt32LE(position + 38) >>> 16) & 0o170000;
      const localOffset = central.readUInt32LE(position + 42);
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (next > central.length || (flags & 1) || ![0, 8].includes(method) || ![0, 0o040000, 0o100000].includes(mode) || central.readUInt16LE(position + 34)) fail('Unsupported ZIP entry, encryption, or symlink.');
      const name = central.subarray(position + 46, position + 46 + nameLength).toString('utf8');
      if (!/^[A-Za-z0-9_./-]{1,512}$/.test(name) || name.startsWith('/') || name.includes('//') || name.split('/').some(part => part === '.' || part === '..') || entries.includes(name)) fail('Invalid or duplicate symbol ZIP entry path.');
      total += size;
      if (total > MAX_SYMBOL_BYTES || (name === 'symbol-identity.json' && size > 64 * 1024)) fail('The symbol ZIP exceeds its uncompressed size limit.');
      if (localOffset + 30 > centralOffset) fail('Invalid ZIP local entry offset.');
      const local = await readAt(30, localOffset);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || localOffset + 30 + localNameLength + localExtraLength + compressedSize > centralOffset) fail('Invalid ZIP local entry.');
      if ((await readAt(localNameLength, localOffset + 30)).toString('utf8') !== name) fail('ZIP local and central entry paths do not match.');
      entries.push(name);
      position = next;
    }
    if (position !== central.length) fail('Unexpected data in the symbol ZIP directory.');
    return entries;
  } finally {
    await handle.close();
  }
}

async function validateExtractedTree(directory, budget = {files: 0, bytes: 0}, depth = 0) {
  if (depth > 14) fail('Extracted symbol tree exceeds the depth limit.');
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    const details = await lstat(entry);
    if (++budget.files > MAX_SYMBOL_FILES || details.isSymbolicLink()) fail('Extracted symbols contain too many files or a symlink.');
    if (details.isDirectory()) await validateExtractedTree(entry, budget, depth + 1);
    else if (details.isFile()) {
      budget.bytes += details.size;
      if (budget.bytes > MAX_SYMBOL_BYTES) fail('Extracted symbols exceed the size limit.');
    } else fail('Extracted symbols contain a special file.');
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

  const entries = await inspectZip(archive);
  if (!entries.includes('symbol-identity.json')) fail('The artifact must include symbol-identity.json.');
  let manifest;
  try {
    manifest = JSON.parse(run('unzip', ['-p', archive, 'symbol-identity.json']));
  } catch {
    fail('symbol-identity.json is not valid JSON.');
  }
  const {build, symbols, symbolBundles} = validateManifest(manifest);
  validateZipEntries(entries, symbolBundles);

  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), 'assist-ios-symbol-verify-'));
  try {
    run('unzip', ['-qq', archive, '-d', extractionRoot]);
    await validateExtractedTree(extractionRoot);
    for (const bundle of symbolBundles) {
      const dSYMRoot = path.join(extractionRoot, bundle.bundle);
      const dwarfPath = path.join(extractionRoot, bundle.dwarfPath);
      const resolvedDwarf = await realpath(dwarfPath);
      const resolvedDsymRoot = await realpath(dSYMRoot);
      if (!pathInside(resolvedDsymRoot, resolvedDwarf)) {
        fail(`The DWARF file resolves outside ${bundle.bundle}.`);
      }
      if ((await stat(resolvedDwarf)).isFile() === false) {
        fail(`${bundle.bundle} does not contain a DWARF file.`);
      }
      const actualHash = await sha256(resolvedDwarf);
      if (actualHash !== bundle.sha256) {
        fail('The DWARF SHA-256 does not match symbol-identity.json.');
      }
      const actualUuids = readDwarfUuids(resolvedDwarf);
      const expectedUuids = [...bundle.uuids].sort((left, right) =>
        `${left.architecture}:${left.uuid}`.localeCompare(`${right.architecture}:${right.uuid}`),
      );
      if (JSON.stringify(actualUuids) !== JSON.stringify(expectedUuids)) {
        fail('The dSYM UUID list does not match symbol-identity.json.');
      }
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
  for (const bundle of symbolBundles.slice(1)) console.log(`Verified extension dSYM: ${bundle.bundle}`);
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
