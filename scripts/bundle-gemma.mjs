#!/usr/bin/env node
// Build-time integrity checks only: this does not qualify an export for inference.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_MODEL = Object.freeze({
  repository: 'google/gemma-4-E2B-it',
  revision: '3e22461f65e89153144f8adb70e3b8c2cc9845a7',
});
export const EXPORTER = Object.freeze({
  repository: 'apple/coreai-models',
  revision: '9db747612f972001279f02adb04d3ef982310d0e',
});
const SOURCE = 'mobile/ios/Assist/BundledModels/Gemma';
const LOCK = 'mobile/gemma-bundle.lock.json';
const JSON_LIMIT = 16 * 1024 * 1024;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function relativePath(value) {
  requireCondition(typeof value === 'string' && value.length > 0 &&
    !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) &&
    value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'),
  'Unsafe bundle-relative path');
  return value;
}

async function statOrMissing(file) {
  try { return await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Inspect every component beneath a trusted root; neither source nor destination
// may escape through a symlink, including a symlinked parent directory.
async function confined(root, relative, {createDirectories = false} = {}) {
  let current = root;
  for (const component of relativePath(relative).split('/')) {
    current = path.join(current, component);
    let info = await statOrMissing(current);
    if (!info && createDirectories) {
      await fs.mkdir(current);
      info = await fs.lstat(current);
    }
    requireCondition(!info?.isSymbolicLink(), 'Symlinks are not allowed in the bundle path');
    if (createDirectories) requireCondition(info?.isDirectory(), 'Expected a resource directory');
  }
  return current;
}

async function inventory(root) {
  const files = [];
  async function walk(directory, prefix) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const relative = relativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const file = path.join(directory, entry.name);
      const info = await fs.lstat(file);
      requireCondition(!info.isSymbolicLink(), 'Symlinks are not allowed in the bundle');
      if (info.isDirectory()) await walk(file, relative);
      else {
        requireCondition(info.isFile(), 'Bundle contains a non-regular file');
        files.push(relative);
      }
    }
  }
  const info = await fs.lstat(root);
  requireCondition(info.isDirectory() && !info.isSymbolicLink(), 'Bundle root must be a directory');
  await walk(root, '');
  return files.sort();
}

async function hashFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({bigint: true});
    requireCondition(before.isFile(), 'Expected a regular file');
    const digest = createHash('sha256');
    let bytes = 0;
    // Bounded stream chunks; never retain a model-sized Buffer.
    for await (const chunk of handle.createReadStream({autoClose: false, highWaterMark: 1024 * 1024})) {
      bytes += chunk.length;
      digest.update(chunk);
    }
    const after = await handle.stat({bigint: true});
    requireCondition(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]) &&
      BigInt(bytes) === after.size, 'File changed while hashing');
    return {bytes, sha256: digest.digest('hex')};
  } finally { await handle.close(); }
}

async function readJSON(file, expected) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    requireCondition(info.isFile() && info.size <= JSON_LIMIT, 'JSON file is missing, non-regular, or too large');
    const chunks = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({autoClose: false, highWaterMark: 64 * 1024})) {
      length += chunk.length;
      requireCondition(length <= JSON_LIMIT, 'JSON file is too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    if (expected) requireCondition(bytes.length === expected.bytes &&
      createHash('sha256').update(bytes).digest('hex') === expected.sha256, 'Metadata changed after verification');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}

function validateLock(lock) {
  requireCondition(lock?.schemaVersion === 1, 'Unsupported Gemma lock schema');
  for (const [field, expected] of [['model', SOURCE_MODEL], ['export', EXPORTER]]) {
    requireCondition(Object.entries(expected).every(([key, value]) => lock[field]?.[key] === value),
      `Unapproved ${field} provenance in Gemma lock`);
  }
  requireCondition([8192, 32768].includes(lock.export.contextLength), 'Unsupported Gemma context length');
  requireCondition(Array.isArray(lock.files) && lock.files.length > 0, 'Gemma inventory must not be empty');
  const records = new Map();
  for (const record of lock.files) {
    const name = relativePath(record?.path);
    requireCondition(!records.has(name) && Number.isSafeInteger(record.bytes) && record.bytes >= 0 &&
      typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256), 'Invalid or duplicate file record');
    records.set(name, record);
  }
  return records;
}

async function verifyInventory(root, records) {
  const actual = await inventory(root);
  const expected = [...records.keys()].sort();
  requireCondition(actual.length === expected.length && actual.every((file, index) => file === expected[index]),
    'Gemma inventory differs: missing or unlisted files');
  for (const relative of expected) {
    const actualHash = await hashFile(await confined(root, relative));
    const record = records.get(relative);
    requireCondition(actualHash.bytes === record.bytes && actualHash.sha256 === record.sha256,
      `Gemma file integrity failed: ${relative}`);
  }
}

function validateMetadata(metadata, lock, records) {
  const language = metadata?.language;
  requireCondition(metadata?.metadata_version === '0.2' && metadata.kind === 'llm' && language?.tokenizer === SOURCE_MODEL.repository &&
    typeof metadata.name === 'string' && metadata.name.length > 0 &&
    language.max_context_length === lock.export.contextLength &&
    Number.isSafeInteger(language.vocab_size) && language.vocab_size > 0 &&
    Array.isArray(language.eos_token_ids) && language.eos_token_ids.length > 0 &&
    language.eos_token_ids.every(id => Number.isSafeInteger(id) && id >= 0 && id < language.vocab_size && id <= 2147483647) &&
    (language.embedded_tokenizer == null || language.embedded_tokenizer === true) &&
    metadata.vision == null && language.vision == null && Object.keys(metadata.assets ?? {}).join() === 'main' &&
    Object.keys(metadata.auxiliary_assets ?? {}).join() === 'per_layer_embeddings', 'Unsupported Gemma bundle metadata');
  const main = relativePath(metadata.assets.main);
  const ple = relativePath(metadata.auxiliary_assets.per_layer_embeddings);
  requireCondition(main.endsWith('.aimodel'), 'Expected an uncompiled .aimodel asset');
  for (const required of ['metadata.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']) {
    requireCondition(records.get(required)?.bytes > 0, `Required nonempty bundle file missing: ${required}`);
  }
  for (const asset of [main, ple]) {
    requireCondition([...records.values()].some(record =>
      (record.path === asset || record.path.startsWith(`${asset}/`)) && record.bytes > 0),
    'Required nonempty Core AI or PLE asset missing');
  }
}

export async function verifyBundle(projectRoot, {ifPresent = false, env = process.env} = {}) {
  const root = await fs.realpath(projectRoot);
  const source = await confined(root, SOURCE);
  const lockPath = await confined(root, LOCK);
  const [sourceInfo, lockInfo] = await Promise.all([statOrMissing(source), statOrMissing(lockPath)]);
  if (!sourceInfo && !lockInfo && ifPresent && env.ASSIST_REQUIRE_BUNDLED_GEMMA !== '1') return null;
  requireCondition(sourceInfo && lockInfo, 'Bundled Gemma and its reviewed lock are required; no model was substituted');
  const lock = await readJSON(lockPath);
  const records = validateLock(lock);
  await verifyInventory(source, records);
  const metadata = await readJSON(path.join(source, 'metadata.json'), records.get('metadata.json'));
  validateMetadata(metadata, lock, records);
  return {source, lock, records};
}

export async function copyBundle(projectRoot, env = process.env) {
  const root = await fs.realpath(projectRoot);
  const verified = await verifyBundle(root, {ifPresent: true, env});
  requireCondition(env.SRCROOT && await fs.realpath(env.SRCROOT) === path.join(root, 'mobile/ios'),
    'SRCROOT does not identify this Assist iOS project');
  requireCondition(typeof env.TARGET_BUILD_DIR === 'string' && path.isAbsolute(env.TARGET_BUILD_DIR) &&
    path.resolve(env.TARGET_BUILD_DIR) !== path.parse(env.TARGET_BUILD_DIR).root, 'Invalid TARGET_BUILD_DIR');
  requireCondition(typeof env.UNLOCALIZED_RESOURCES_FOLDER_PATH === 'string' &&
    /^[A-Za-z0-9_. -]+\.app$/.test(env.UNLOCALIZED_RESOURCES_FOLDER_PATH), 'Expected an iOS .app resource directory');
  const buildRoot = await fs.realpath(env.TARGET_BUILD_DIR);
  requireCondition(buildRoot !== root && !root.startsWith(`${buildRoot}${path.sep}`), 'Build directory must not enclose the source project');
  const targetRelative = `${env.UNLOCALIZED_RESOURCES_FOLDER_PATH}/BundledModels/Gemma`;
  const existingTarget = await confined(buildRoot, targetRelative);
  const source = path.join(root, SOURCE);
  requireCondition(existingTarget !== source && !existingTarget.startsWith(`${source}${path.sep}`) &&
    !source.startsWith(`${existingTarget}${path.sep}`), 'Resource destination overlaps the source bundle');
  if (!verified) {
    requireCondition(!await statOrMissing(existingTarget), 'Stale bundled Gemma remains in the app; use a fresh build directory');
    return null;
  }
  if (await statOrMissing(existingTarget)) {
    const existing = await inventory(existingTarget);
    requireCondition(existing.every(file => verified.records.has(file)),
      'Unlisted files already exist in the app bundle; use a fresh build directory');
  }
  const target = await confined(buildRoot, targetRelative, {createDirectories: true});
  for (const file of verified.records.keys()) {
    const parent = path.posix.dirname(file);
    if (parent !== '.') await confined(target, parent, {createDirectories: true});
    const destination = await confined(target, file);
    // Existing files may be reused only when already correct; never overwrite or
    // delete another build's resource, including an unexpected hard link.
    if (await statOrMissing(destination)) {
      const actual = await hashFile(destination);
      const expected = verified.records.get(file);
      requireCondition(actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
        'Existing resource differs; use a fresh build directory');
    } else {
      await fs.copyFile(await confined(verified.source, file), destination, constants.COPYFILE_EXCL);
    }
  }
  // Rehash copied bytes, not only the source; catches mutations during copy.
  await verifyInventory(target, verified.records);
  return {files: verified.records.size, contextLength: verified.lock.export.contextLength, target};
}

async function main() {
  const args = process.argv.slice(2);
  requireCondition(args.length > 0 && args.every(arg => ['--verify', '--copy', '--if-present'].includes(arg)) &&
    Number(args.includes('--verify')) + Number(args.includes('--copy')) === 1, 'Usage: bundle-gemma.mjs --verify [--if-present] | --copy');
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = args.includes('--copy') ? await copyBundle(projectRoot) :
    await verifyBundle(projectRoot, {ifPresent: args.includes('--if-present')});
  console.log(result ? `Gemma ${args.includes('--copy') ? 'copied and verified' : 'verified'}; inference remains unqualified.` :
    'Gemma absent: unsigned/prototype build only; no model included.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Gemma bundling failed: ${error.message}`); process.exitCode = 1; });
}
