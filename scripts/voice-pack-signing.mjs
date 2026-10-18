#!/usr/bin/env node
// Local-only Ed25519 signing. This program never downloads or uploads weights.
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOMAIN = Buffer.from('org.27pm.assist.voice-pack/v2\0');
export const ABI = 'assist-fluid-fr24-estelle-v1';
const groups = ['pocket', 'redux', 'ultra', 'silero'];
const maxManifest = 2_000_000;

function check(condition, message) { if (!condition) throw new Error(message); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export async function readBounded(path, maximum = maxManifest) {
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum, 'Invalid or oversized metadata file');
  const chunks = []; let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) {
    size += chunk.length;
    check(size <= maximum, 'Metadata changed or exceeded its bound');
    chunks.push(chunk);
  }
  check(size === info.size, 'Metadata changed during verification');
  return Buffer.concat(chunks);
}

export function validateManifest(manifest, reference) {
  check([1, 2].includes(manifest.schemaVersion), 'Unsupported manifest schema');
  check(manifest.schemaVersion !== 2 || manifest.runtimeABI === ABI, 'Native model ABI is incompatible');
  check(manifest.sdkRevision === reference.sdkRevision, 'Native SDK revision is incompatible');
  check(JSON.stringify(Object.keys(manifest.groups ?? {}).sort()) === JSON.stringify([...groups].sort()), 'Unexpected model groups');
  let total = 0;
  for (const name of groups) {
    const group = manifest.groups[name], baseline = reference.groups[name];
    check(group.repository === baseline.repository && /^[a-f0-9]{40}$/.test(group.revision), 'Model provenance must be pinned');
    check(Array.isArray(group.files) && group.files.length > 0 && group.files.length <= 5000, 'Invalid file inventory');
    const seen = new Set(); const roots = new Set();
    for (const asset of group.files) {
      const parts = typeof asset.path === 'string' ? asset.path.split('/') : [];
      check(parts.length > 0 && parts.every(p => p && p !== '.' && p !== '..') &&
        !asset.path.includes('\\') && !asset.path.includes('\0') && Buffer.byteLength(asset.path) <= 512 && !seen.has(asset.path), 'Unsafe or duplicate asset path');
      check(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 4_000_000_000 && /^[a-f0-9]{64}$/.test(asset.sha256), 'Invalid asset size or digest');
      total += asset.size;
      check(Number.isSafeInteger(total) && total <= 16_000_000_000, 'Inventory exceeds the importer disk limit');
      seen.add(asset.path); roots.add(parts[0]);
    }
    const expectedRoots = [...new Set(baseline.files.map(f => f.path.split('/')[0]))].sort();
    check(JSON.stringify([...roots].sort()) === JSON.stringify(expectedRoots), 'Native model components cannot change');
  }
}

async function checkedAsset(root, relative) {
  let value = root;
  check((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), 'Pack must be a real local directory');
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    value = join(value, parts[index]);
    const info = await lstat(value);
    check(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() : info.isDirectory()), 'Pack contains a link or non-regular asset');
  }
  return value;
}

export async function verifyPack(root, manifest) {
  const present = [];
  for (const name of groups) {
    try { await lstat(join(root, name)); present.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  check(present.includes('pocket') && present.includes('silero') && (present.includes('redux') || present.includes('ultra')), 'Pack needs full PocketTTS, Silero and a Parakeet variant');
  for (const name of present) {
    for (const asset of manifest.groups[name].files) {
      const path = await checkedAsset(root, `${name}/${asset.path}`);
      check((await lstat(path)).size === asset.size, 'Asset size mismatch');
      const digest = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(path, { highWaterMark: 1_048_576 })) {
        size += chunk.length;
        check(size <= asset.size, 'Asset changed during verification');
        digest.update(chunk);
      }
      check(size === asset.size && digest.digest('hex') === asset.sha256, 'Asset SHA-256 mismatch');
    }
  }
  return present;
}

export async function generateKey(path, keyId) {
  check(isAbsolute(path) && /^[a-zA-Z0-9._-]{1,64}$/.test(keyId), 'Use an absolute private-key path and a bounded key ID');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkKeyLocation(path);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const output = await open(path, 'wx', 0o600);
  try { await output.writeFile(privateKey.export({ format: 'pem', type: 'pkcs8' })); await output.sync(); }
  finally { await output.close(); }
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { keyId, publicKeyBase64: publicRaw.toString('base64') };
}

async function checkKeyLocation(path) {
  check(isAbsolute(path), 'Use an absolute private-key path');
  let parent = dirname(path);
  const directory = await lstat(parent);
  check(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0,
    'Private-key directory must be a real owner-only directory');
  while (true) {
    const info = await lstat(parent);
    check(info.isDirectory() && !info.isSymbolicLink(), 'Private-key path must not contain directory links');
    try {
      const marker = await lstat(join(parent, '.git'));
      if (marker.isDirectory()) await lstat(join(parent, '.git', 'HEAD'));
      throw new Error('Private keys must stay outside every Git worktree');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

export async function signPack({ pack, manifestPath, privateKeyPath, keyId, version, reference }) {
  check(/^[a-zA-Z0-9._-]{1,64}$/.test(version) && /^[a-zA-Z0-9._-]{1,64}$/.test(keyId), 'Version and key ID must be bounded identifiers');
  const source = JSON.parse(await readBounded(manifestPath));
  validateManifest(source, reference);
  const manifest = { ...source, schemaVersion: 2, packVersion: version, runtimeABI: ABI };
  await verifyPack(pack, manifest);
  await checkKeyLocation(privateKeyPath);
  const info = await lstat(privateKeyPath);
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'Private key must be a regular owner-only file');
  const privateKey = createPrivateKey(await readBounded(privateKeyPath, 8192));
  check(privateKey.asymmetricKeyType === 'ed25519', 'Use an Ed25519 private key');
  const payload = Buffer.from(JSON.stringify(manifest));
  check(payload.length <= maxManifest, 'Manifest is too large');
  const envelope = Buffer.from(JSON.stringify({ schemaVersion: 2, keyId,
    manifestBase64: payload.toString('base64'), signatureBase64: sign(null, Buffer.concat([DOMAIN, payload]), privateKey).toString('base64') }) + '\n');
  const target = join(pack, 'assist-voice-pack.json');
  // Never follow a user-supplied metadata symlink when replacing a marker.
  try { check(!(await lstat(target)).isSymbolicLink(), 'Pack metadata is a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(pack, `.assist-manifest-${randomUUID()}.tmp`);
  try {
    const output = await open(temporary, 'wx', 0o600);
    try { await output.writeFile(envelope); await output.sync(); } finally { await output.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { packVersion: version, runtimeABI: ABI, keyId, manifestSHA256: hash(payload) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    check(args[index].startsWith('--') && args[index + 1] && !Object.hasOwn(options, args[index]), 'Expected distinct --option value arguments');
    options[args[index]] = args[index + 1];
  }
  if (command === 'keygen') {
    check(options['--private-key'] && options['--key-id'], 'keygen requires --private-key and --key-id');
    check(Object.keys(options).every(k => ['--private-key', '--key-id'].includes(k)), 'Unknown keygen option');
    console.log(JSON.stringify(await generateKey(options['--private-key'], options['--key-id'])));
  } else if (command === 'sign') {
    check(['--pack', '--manifest', '--private-key', '--key-id', '--version'].every(k => options[k]), 'sign requires --pack --manifest --private-key --key-id --version');
    check(Object.keys(options).every(k => ['--pack', '--manifest', '--private-key', '--key-id', '--version'].includes(k)), 'Unknown sign option');
    const referencePath = new URL('../mobile/ios/Assist/AdvancedVoiceAssets.json', import.meta.url);
    const reference = JSON.parse(await readFile(referencePath));
    console.log(JSON.stringify(await signPack({ pack: resolve(options['--pack']), manifestPath: resolve(options['--manifest']),
      privateKeyPath: options['--private-key'], keyId: options['--key-id'], version: options['--version'], reference })));
  } else {
    throw new Error('Usage: voice-pack-signing.mjs keygen|sign (local files only; no network)');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Voice pack signing: ${error.message}`); process.exitCode = 1; });
}
