import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ABI, DOMAIN, generateKey, readBounded, signPack, validateManifest } from './voice-pack-signing.mjs';

const names = ['pocket', 'redux', 'ultra', 'silero'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t, version = 'weights A') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assist-pack-sign-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, 'pack'); await mkdir(pack);
  const bytes = Buffer.from(version);
  const manifest = { schemaVersion: 1, sdkRevision: 'a'.repeat(40), groups: {} };
  for (const name of names) {
    manifest.groups[name] = { repository: `fixture/${name}`, revision: 'b'.repeat(40),
      files: [{ path: 'Model.mlmodelc/weight.bin', size: bytes.length, sha256: sha(bytes) }] };
    if (name === 'ultra') continue;
    await mkdir(join(pack, name, 'Model.mlmodelc'), { recursive: true });
    await writeFile(join(pack, name, 'Model.mlmodelc/weight.bin'), bytes);
  }
  const manifestPath = join(root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const privateKeyPath = join(root, 'keys', 'release.pem');
  const publicInfo = await generateKey(privateKeyPath, 'test-key');
  return { root, pack, manifestPath, privateKeyPath, keyId: 'test-key', version: '1.0.0', reference: manifest, publicInfo };
}

test('local key is owner-only, public-only output, never overwritten', async t => {
  const fixture = await setup(t);
  assert.equal((await lstat(fixture.privateKeyPath)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(fixture.publicInfo).sort(), ['keyId', 'publicKeyBase64']);
  assert.equal(Buffer.from(fixture.publicInfo.publicKeyBase64, 'base64').length, 32);
  const before = await readFile(fixture.privateKeyPath);
  await assert.rejects(generateKey(fixture.privateKeyPath, 'test-key'), { code: 'EEXIST' });
  assert.deepEqual(await readFile(fixture.privateKeyPath), before);
});

test('keys cannot be generated in Git, relative paths or linked directories', async t => {
  const fixture = await setup(t);
  await mkdir(join(fixture.root, '.git'));
  await writeFile(join(fixture.root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await assert.rejects(generateKey(join(fixture.root, 'other', 'key.pem'), 'test-key'), /outside every Git/);
  await assert.rejects(generateKey('relative/key.pem', 'test-key'), /absolute/);
  const linked = join(tmpdir(), `assist-linked-key-${Date.now()}`);
  await symlink(join(fixture.root, 'keys'), linked);
  t.after(() => rm(linked, { force: true }));
  await assert.rejects(generateKey(join(linked, 'key.pem'), 'test-key'), /real owner-only|directory links/);
});

test('two distinct compatible weight sets can be signed with one native ABI', async t => {
  for (const version of ['weights A', 'weights B']) {
    const fixture = await setup(t, version);
    const result = await signPack(fixture);
    const envelope = JSON.parse(await readFile(join(fixture.pack, 'assist-voice-pack.json')));
    const payload = Buffer.from(envelope.manifestBase64, 'base64');
    const key = createPublicKey(await readFile(fixture.privateKeyPath));
    assert.equal(verify(null, Buffer.concat([DOMAIN, payload]), key, Buffer.from(envelope.signatureBase64, 'base64')), true);
    assert.equal(JSON.parse(payload).runtimeABI, ABI);
    assert.equal(result.manifestSHA256, sha(payload));
    assert.equal(verify(null, payload, key, Buffer.from(envelope.signatureBase64, 'base64')), false);
  }
});

test('corrupt weights cannot replace a pre-existing pack marker', async t => {
  const fixture = await setup(t);
  const marker = join(fixture.pack, 'assist-voice-pack.json');
  await writeFile(marker, 'previous marker');
  await writeFile(join(fixture.pack, 'pocket/Model.mlmodelc/weight.bin'), 'bad bytes');
  await assert.rejects(signPack(fixture), /mismatch/);
  assert.equal(await readFile(marker, 'utf8'), 'previous marker');
});

test('private key with permissive permissions and linked assets are rejected', async t => {
  const fixture = await setup(t);
  await chmod(fixture.privateKeyPath, 0o644);
  await assert.rejects(signPack(fixture), /owner-only/);
  await chmod(fixture.privateKeyPath, 0o600);
  const path = join(fixture.pack, 'pocket/Model.mlmodelc/weight.bin');
  await rm(path); await symlink(fixture.manifestPath, path);
  await assert.rejects(signPack(fixture), /link/);
});

test('wrong native SDK, new components, traversal and oversized inventories fail closed', async t => {
  const fixture = await setup(t);
  for (const mutate of [
    value => { value.sdkRevision = 'c'.repeat(40); },
    value => { value.schemaVersion = 2; value.runtimeABI = 'other-native-engine'; },
    value => { value.groups.pocket.files[0].path = 'Other.mlmodelc/weight.bin'; },
    value => { value.groups.pocket.files[0].path = '../secret'; },
    value => { value.groups.pocket.files[0].size = Number.MAX_SAFE_INTEGER; },
  ]) {
    const value = structuredClone(fixture.reference); mutate(value);
    assert.throws(() => validateManifest(value, fixture.reference));
  }
  await assert.rejects(readBounded(fixture.manifestPath, 4), /oversized/);
});
