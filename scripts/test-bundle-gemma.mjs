import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {copyBundle, verifyBundle, SOURCE_MODEL, EXPORTER} from './bundle-gemma.mjs';

// Tiny synthetic fixtures exercise packaging, never inference or export quality.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assist-bundle-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'mobile/ios/Assist/BundledModels/Gemma');
  const lockPath = path.join(root, 'mobile/gemma-bundle.lock.json');
  const metadata = {
    metadata_version: '0.2', kind: 'llm', name: 'test-only-gemma', assets: {main: 'gemma.aimodel'},
    auxiliary_assets: {per_layer_embeddings: 'gemma.ple'},
    language: {tokenizer: SOURCE_MODEL.repository, max_context_length: 8192, embedded_tokenizer: true,
      vocab_size: 256, eos_token_ids: [1, 2]},
  };
  const contents = {
    'metadata.json': JSON.stringify(metadata),
    'gemma.aimodel/weights.bin': 'tiny-test-weights',
    'gemma.ple': 'tiny-test-ple',
    'tokenizer/tokenizer.json': '{"test":true}',
    'tokenizer/tokenizer_config.json': '{"test":true}',
  };
  const lock = {schemaVersion: 1, model: {...SOURCE_MODEL}, export: {...EXPORTER, contextLength: 8192}, files: []};
  for (const [name, content] of Object.entries(contents)) {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, content);
    lock.files.push({path: name, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex')});
  }
  const saveLock = () => fs.writeFile(lockPath, JSON.stringify(lock));
  await saveLock();
  const buildRoot = path.join(root, 'build');
  await fs.mkdir(buildRoot);
  const env = {SRCROOT: path.join(root, 'mobile/ios'), TARGET_BUILD_DIR: buildRoot,
    UNLOCALIZED_RESOURCES_FOLDER_PATH: 'Assist.app', ASSIST_REQUIRE_BUNDLED_GEMMA: '1'};
  const target = path.join(buildRoot, 'Assist.app/BundledModels/Gemma');
  async function changeMetadata(change) {
    change(metadata);
    const content = JSON.stringify(metadata);
    await fs.writeFile(path.join(source, 'metadata.json'), content);
    Object.assign(lock.files.find(record => record.path === 'metadata.json'), {
      bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
    });
    await saveLock();
  }
  return {root, source, lockPath, lock, saveLock, metadata, changeMetadata, buildRoot, env, target};
}

test('valid pinned exact inventory verifies', async t => {
  const f = await fixture(t);
  const result = await verifyBundle(f.root);
  assert.equal(result.records.size, 5);
  assert.equal(result.lock.export.contextLength, 8192);
});

test('32K metadata must match its pinned export context', async t => {
  const f = await fixture(t);
  f.lock.export.contextLength = 32768;
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /metadata/);
  await f.changeMetadata(metadata => { metadata.language.max_context_length = 32768; });
  assert.equal((await verifyBundle(f.root)).lock.export.contextLength, 32768);
});

for (const [label, mutation, pattern] of [
  ['empty inventory', lock => { lock.files = []; }, /must not be empty/],
  ['invalid digest', lock => { lock.files[0].sha256 = '0'.repeat(63); }, /Invalid/],
  ['negative bytes', lock => { lock.files[0].bytes = -1; }, /Invalid/],
  ['duplicate record', lock => { lock.files.push({...lock.files[0]}); }, /duplicate/],
  ['wrong source pin', lock => { lock.model.revision = '0'.repeat(40); }, /provenance/],
  ['wrong exporter pin', lock => { lock.export.revision = '0'.repeat(40); }, /provenance/],
  ['unsupported context', lock => { lock.export.contextLength = 131072; }, /context/],
  ['boolean schema', lock => { lock.schemaVersion = true; }, /schema/],
]) {
  test(`rejects ${label}`, async t => {
    const f = await fixture(t);
    mutation(f.lock);
    await f.saveLock();
    await assert.rejects(verifyBundle(f.root), pattern);
  });
}

for (const unsafe of ['../secret', '/tmp/secret', 'x/../secret', 'x//secret', './secret', 'x\\secret', '']) {
  test(`rejects unsafe inventory path ${JSON.stringify(unsafe)}`, async t => {
    const f = await fixture(t);
    f.lock.files[0].path = unsafe;
    await f.saveLock();
    await assert.rejects(verifyBundle(f.root), /Unsafe/);
  });
}

test('same-size weight mutation fails SHA-256, not just size', async t => {
  const f = await fixture(t);
  const file = path.join(f.source, 'gemma.aimodel/weights.bin');
  const original = await fs.readFile(file);
  const mutated = Buffer.from(original);
  mutated[0] ^= 1;
  await fs.writeFile(file, mutated);
  assert.equal((await fs.stat(file)).size, original.length);
  await assert.rejects(verifyBundle(f.root), /integrity failed/);
});

test('rejects both unlisted and missing files', async t => {
  const f = await fixture(t);
  const extra = path.join(f.source, 'unlisted');
  await fs.writeFile(extra, 'extra');
  await assert.rejects(verifyBundle(f.root), /inventory differs/);
  await fs.unlink(extra);
  await fs.unlink(path.join(f.source, 'gemma.ple'));
  await assert.rejects(verifyBundle(f.root), /inventory differs/);
});

test('rejects a symlink even when it resolves inside the bundle', async t => {
  const f = await fixture(t);
  await fs.symlink('gemma.ple', path.join(f.source, 'link'));
  await assert.rejects(verifyBundle(f.root), /Symlinks/);
});

test('rejects a symlinked source parent', async t => {
  const f = await fixture(t);
  const parent = path.dirname(f.source);
  const renamed = `${parent}-saved`;
  await fs.rename(parent, renamed);
  await fs.symlink(renamed, parent);
  await assert.rejects(verifyBundle(f.root), /Symlinks/);
});

test('rejects metadata asset traversal even when its hash is approved', async t => {
  const f = await fixture(t);
  await f.changeMetadata(metadata => { metadata.assets.main = '../escaped.aimodel'; });
  await assert.rejects(verifyBundle(f.root), /Unsafe/);
});

test('rejects a nonembedded tokenizer', async t => {
  const f = await fixture(t);
  await f.changeMetadata(metadata => { metadata.language.embedded_tokenizer = false; });
  await assert.rejects(verifyBundle(f.root), /metadata/);
});

test('rejects a root vision configuration', async t => {
  const f = await fixture(t);
  await f.changeMetadata(metadata => { metadata.vision = {test: true}; });
  await assert.rejects(verifyBundle(f.root), /metadata/);
});

test('embedded tokenizer may use Apple default but never a nonboolean value', async t => {
  const f = await fixture(t);
  await f.changeMetadata(metadata => { delete metadata.language.embedded_tokenizer; });
  await verifyBundle(f.root);
  await f.changeMetadata(metadata => { metadata.language.embedded_tokenizer = 'true'; });
  await assert.rejects(verifyBundle(f.root), /metadata/);
});

for (const [label, mutation] of [
  ['unsupported metadata version', metadata => { metadata.metadata_version = '0.1'; }],
  ['empty name', metadata => { metadata.name = ''; }],
  ['noninteger vocabulary', metadata => { metadata.language.vocab_size = 256.5; }],
  ['empty EOS union', metadata => { metadata.language.eos_token_ids = []; }],
  ['out-of-range EOS', metadata => { metadata.language.eos_token_ids = [256]; }],
  ['boolean EOS', metadata => { metadata.language.eos_token_ids = [true]; }],
  ['float EOS', metadata => { metadata.language.eos_token_ids = [1.5]; }],
]) {
  test(`rejects ${label} despite a matching metadata digest`, async t => {
    const f = await fixture(t);
    await f.changeMetadata(mutation);
    await assert.rejects(verifyBundle(f.root), /metadata/);
  });
}

test('copy rejects a destination nested inside the source model', async t => {
  const f = await fixture(t);
  await assert.rejects(copyBundle(f.root, {...f.env, TARGET_BUILD_DIR: f.source}), /overlaps/);
  assert.equal(await fs.stat(path.join(f.source, 'Assist.app')).catch(error => error.code), 'ENOENT');
});

test('rejects a missing required tokenizer even with a matching inventory', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, 'tokenizer/tokenizer_config.json'));
  f.lock.files = f.lock.files.filter(record => record.path !== 'tokenizer/tokenizer_config.json');
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /Required nonempty bundle file/);
});

test('rejects an empty PLE even when its hash and size match', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'gemma.ple'), '');
  Object.assign(f.lock.files.find(record => record.path === 'gemma.ple'), {
    bytes: 0, sha256: createHash('sha256').update('').digest('hex'),
  });
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /nonempty Core AI or PLE/);
});

test('strict verification fails absent resources; optional prototype can skip only both absent', async t => {
  const f = await fixture(t);
  await fs.rm(f.source, {recursive: true});
  await assert.rejects(verifyBundle(f.root, {ifPresent: true, env: {}}), /required/);
  await fs.unlink(f.lockPath);
  await assert.rejects(verifyBundle(f.root), /required/);
  assert.equal(await verifyBundle(f.root, {ifPresent: true, env: {}}), null);
  await assert.rejects(verifyBundle(f.root, {ifPresent: true, env: {ASSIST_REQUIRE_BUNDLED_GEMMA: '1'}}), /required/);
});

test('copy verifies every destination byte and is safely repeatable', async t => {
  const f = await fixture(t);
  assert.equal((await copyBundle(f.root, f.env)).files, 5);
  for (const record of f.lock.files) {
    assert.deepEqual(await fs.readFile(path.join(f.target, record.path)), await fs.readFile(path.join(f.source, record.path)));
  }
  assert.equal((await copyBundle(f.root, f.env)).contextLength, 8192);
});

test('copy rejects stale resources without deleting them', async t => {
  const f = await fixture(t);
  await copyBundle(f.root, f.env);
  const stale = path.join(f.target, 'stale');
  await fs.writeFile(stale, 'keep me');
  await assert.rejects(copyBundle(f.root, f.env), /Unlisted files/);
  assert.equal(await fs.readFile(stale, 'utf8'), 'keep me');
});

test('copy never overwrites a mismatched existing resource', async t => {
  const f = await fixture(t);
  await copyBundle(f.root, f.env);
  const file = path.join(f.target, 'gemma.ple');
  await fs.writeFile(file, 'preserve existing');
  await assert.rejects(copyBundle(f.root, f.env), /Existing resource differs/);
  assert.equal(await fs.readFile(file, 'utf8'), 'preserve existing');
});

test('copy rejects symlinked app resources', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.buildRoot, 'Assist.app'));
  await assert.rejects(copyBundle(f.root, f.env), /Symlinks/);
  assert.deepEqual(await fs.readdir(outside), []);
});

for (const [field, invalid] of [
  ['SRCROOT', '/'],
  ['TARGET_BUILD_DIR', '/'],
  ['UNLOCALIZED_RESOURCES_FOLDER_PATH', '../Escape.app'],
  ['UNLOCALIZED_RESOURCES_FOLDER_PATH', '/Escape.app'],
]) {
  test(`copy rejects unsafe ${field}=${invalid}`, async t => {
    const f = await fixture(t);
    await assert.rejects(copyBundle(f.root, {...f.env, [field]: invalid}));
    assert.deepEqual(await fs.readdir(f.buildRoot), []);
  });
}

test('optional copy cannot accidentally ship an old model when current inputs are absent', async t => {
  const f = await fixture(t);
  await copyBundle(f.root, f.env);
  await fs.rm(f.source, {recursive: true});
  await fs.unlink(f.lockPath);
  await assert.rejects(copyBundle(f.root, {...f.env, ASSIST_REQUIRE_BUNDLED_GEMMA: '0'}), /Stale bundled Gemma/);
});
