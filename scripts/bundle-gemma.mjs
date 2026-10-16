#!/usr/bin/env node
// Build-time integrity checks only: this does not qualify an export for inference.
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SOURCE_MODEL = Object.freeze({
  repository: 'google/gemma-4-E2B-it',
  revision: '3e22461f65e89153144f8adb70e3b8c2cc9845a7',
});
export const ABLITERATED_SOURCE_MODEL = Object.freeze({
  repository: 'huihui-ai/Huihui-gemma-4-E2B-it-abliterated',
  revision: '3d1e3d50d7a04585ce4ded197b2fd7a90c04647c',
});
const APPROVED_SOURCE_MODELS = Object.freeze([SOURCE_MODEL, ABLITERATED_SOURCE_MODEL]);
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

async function inventory(root, signatures) {
  const files = [];
  async function walk(directory, prefix) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const relative = relativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const file = path.join(directory, entry.name);
      const info = await fs.lstat(file, {bigint: true});
      requireCondition(!info.isSymbolicLink(), 'Symlinks are not allowed in the bundle');
      if (info.isDirectory()) await walk(file, relative);
      else {
        requireCondition(info.isFile(), 'Bundle contains a non-regular file');
        files.push(relative);
        signatures?.set(relative, fileSignature(info));
      }
    }
  }
  const info = await fs.lstat(root);
  requireCondition(info.isDirectory() && !info.isSymbolicLink(), 'Bundle root must be a directory');
  await walk(root, '');
  return files.sort();
}

function fileSignature(info) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(info[key]));
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
    return {bytes, sha256: digest.digest('hex'), signature: fileSignature(after)};
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
  const matchesProvenance = (actual, expected) =>
    Object.entries(expected).every(([key, value]) => actual?.[key] === value);
  const model = APPROVED_SOURCE_MODELS.find(expected => matchesProvenance(lock.model, expected));
  requireCondition(model, 'Unapproved model provenance in Gemma lock');
  requireCondition(matchesProvenance(lock.export, EXPORTER), 'Unapproved export provenance in Gemma lock');
  // Existing baseline locks remain valid. Derived weights must identify the
  // separately verified canonical tokenizer rather than imply a new tokenizer.
  if (model === ABLITERATED_SOURCE_MODEL || Object.hasOwn(lock, 'tokenizer')) {
    requireCondition(matchesProvenance(lock.tokenizer, SOURCE_MODEL),
      'Unapproved tokenizer provenance in Gemma lock');
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
  const signatures = [];
  for (const relative of expected) {
    const actualHash = await hashFile(await confined(root, relative));
    const record = records.get(relative);
    requireCondition(actualHash.bytes === record.bytes && actualHash.sha256 === record.sha256,
      `Gemma file integrity failed: ${relative}`);
    signatures.push([relative, actualHash.signature]);
  }
  return signatures;
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
  if (lock.model.repository === ABLITERATED_SOURCE_MODEL.repository) {
    requireCondition(metadata.source?.hf_model_id === lock.model.repository &&
      metadata.source.revision === lock.model.revision, 'Gemma metadata source differs from model provenance');
  }
  const main = relativePath(metadata.assets.main);
  const ple = relativePath(metadata.auxiliary_assets.per_layer_embeddings);
  requireCondition(main.endsWith('.aimodel'), 'Expected an uncompiled .aimodel asset');
  requireCondition(main !== ple && !main.startsWith(`${ple}/`) && !ple.startsWith(`${main}/`),
    'Core AI and PLE asset paths must not overlap');
  for (const required of ['metadata.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json', 'tokenizer/chat_template.jinja']) {
    requireCondition(records.get(required)?.bytes > 0, `Required nonempty bundle file missing: ${required}`);
  }
  for (const asset of [main, ple]) {
    // Inventory entries are files: main requires a descendant, PLE may be a file.
    requireCondition([...records.values()].some(record =>
      ((asset === ple && record.path === asset) || record.path.startsWith(`${asset}/`)) && record.bytes > 0),
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
  const signatures = await verifyInventory(source, records);
  const metadata = await readJSON(path.join(source, 'metadata.json'), records.get('metadata.json'));
  validateMetadata(metadata, lock, records);
  return {source, lock, records, signatures};
}

async function metadataInventory(root) {
  if (!await statOrMissing(root)) return null;
  const signatures = new Map();
  return (await inventory(root, signatures)).map(file => [file, signatures.get(file)]);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jsonDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function incrementalState(root, source, target, env) {
  const lockPath = await confined(root, LOCK);
  const lock = await statOrMissing(lockPath) ? await readJSON(lockPath) : null;
  const helpers = [fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./bundle-gemma-xcode.sh', import.meta.url)),
    path.join(env.SRCROOT, '.xcode.env'), path.join(env.SRCROOT, '.xcode.env.local')];
  const helperDigests = [];
  for (const file of helpers) {
    const info = await statOrMissing(file);
    requireCondition(!info || (info.isFile() && info.size <= JSON_LIMIT), 'Invalid build helper');
    helperDigests.push(info ? (await hashFile(file)).sha256 : null);
  }
  return {
    key: {version: 1, root, source, target, lock: jsonDigest(lock), helpers: helperDigests,
      required: env.ASSIST_REQUIRE_BUNDLED_GEMMA === '1', node: [process.execPath, process.version]},
    source: await metadataInventory(source), target: await metadataInventory(target),
  };
}

async function incrementalMarker(root, source, app, env) {
  requireCondition(typeof env.DERIVED_FILE_DIR === 'string' && path.isAbsolute(env.DERIVED_FILE_DIR),
    'Incremental copy requires Xcode DERIVED_FILE_DIR');
  const allowed = directory => directory !== root && directory !== path.parse(directory).root &&
    [source, app].every(resource => directory !== resource &&
      !directory.startsWith(`${resource}${path.sep}`) && !resource.startsWith(`${directory}${path.sep}`));
  // Resolve existing symlinked parents before creating any missing directories.
  let ancestor = path.resolve(env.DERIVED_FILE_DIR);
  const missing = [];
  while (!await statOrMissing(ancestor)) {
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  ancestor = await fs.realpath(ancestor);
  const directory = path.join(ancestor, ...missing);
  requireCondition(allowed(directory), 'Verification state must be outside model resources');
  if (missing.length) await confined(ancestor, missing.join('/'), {createDirectories: true});
  return confined(directory, 'assist-gemma-verified.json');
}

async function readMarker(file) {
  try { return await readJSON(file); } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeMarker(file, state, result) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({state, result}), {flag: 'wx', mode: 0o600});
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, {force: true}); }
}

export async function copyBundle(projectRoot, env = process.env, {incremental = false} = {}) {
  const root = await fs.realpath(projectRoot);
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
  const source = await confined(root, SOURCE);
  requireCondition(existingTarget !== source && !existingTarget.startsWith(`${source}${path.sep}`) &&
    !source.startsWith(`${existingTarget}${path.sep}`), 'Resource destination overlaps the source bundle');
  const app = path.join(buildRoot, env.UNLOCALIZED_RESOURCES_FOLDER_PATH);
  const marker = incremental ? await incrementalMarker(root, source, app, env) : null;
  const before = marker ? await incrementalState(root, source, existingTarget, env) : null;
  if (marker) {
    const cached = await readMarker(marker);
    if (cached?.result && same(cached.state, before) && cached.result.target === existingTarget &&
      Number.isSafeInteger(cached.result.files) && [8192, 32768].includes(cached.result.contextLength)) {
      return {...cached.result, cacheHit: true};
    }
    // Never leave a success stamp after a failed verification.
    await fs.rm(marker, {force: true});
  }
  const verified = await verifyBundle(root, {ifPresent: true, env});
  if (!verified) {
    requireCondition(!await statOrMissing(existingTarget), 'Stale bundled Gemma remains in the app; use a fresh build directory');
    if (marker) await writeMarker(marker, before, null);
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
  const targetSignatures = await verifyInventory(target, verified.records);
  const result = {files: verified.records.size, contextLength: verified.lock.export.contextLength, target};
  if (marker) {
    const after = await incrementalState(root, source, target, env);
    // Bind the stamp to the stats observed by hashing, not to later unverified bytes.
    requireCondition(same(before.key, after.key) && after.key.lock === jsonDigest(verified.lock) &&
      same(after.source, verified.signatures) && same(after.target, targetSignatures),
    'Gemma inputs or copied resources changed during verification');
    await writeMarker(marker, after, result);
  }
  return incremental ? {...result, cacheHit: false} : result;
}

async function main() {
  const args = process.argv.slice(2);
  requireCondition(args.length > 0 && args.every(arg => ['--verify', '--copy', '--if-present', '--incremental'].includes(arg)) &&
    Number(args.includes('--verify')) + Number(args.includes('--copy')) === 1 &&
    (!args.includes('--incremental') || args.includes('--copy')),
  'Usage: bundle-gemma.mjs --verify [--if-present] | --copy [--incremental]');
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = args.includes('--copy') ? await copyBundle(projectRoot, process.env, {incremental: args.includes('--incremental')}) :
    await verifyBundle(projectRoot, {ifPresent: args.includes('--if-present')});
  console.log(result ? `Gemma ${result.cacheHit ? 'unchanged; verified copy reused' : args.includes('--copy') ? 'copied and verified' : 'verified'}; inference remains unqualified.` :
    'Gemma absent: unsigned/prototype build only; no model included.');
}

// macOS temporary paths may reach the same script through /var -> /private/var.
const entryPoint = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null);
if (entryPoint && entryPoint === await fs.realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(`Gemma bundling failed: ${error.message}`); process.exitCode = 1; });
}
