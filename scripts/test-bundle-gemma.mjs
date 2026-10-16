import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fstatSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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
    'tokenizer/chat_template.jinja': '{{ bos_token }}test-only-template',
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
  assert.equal(result.records.size, 6);
  assert.equal(result.lock.export.contextLength, 8192);
});

const abliteratedSource = {
  repository: 'huihui-ai/Huihui-gemma-4-E2B-it-abliterated',
  revision: '3d1e3d50d7a04585ce4ded197b2fd7a90c04647c',
};

async function abliteratedFixture(t) {
  const f = await fixture(t);
  f.lock.model = {...abliteratedSource};
  f.lock.tokenizer = {...SOURCE_MODEL};
  await f.changeMetadata(metadata => {
    metadata.source = {hf_model_id: abliteratedSource.repository, revision: abliteratedSource.revision,
      export_alias: SOURCE_MODEL.repository};
  });
  return f;
}

test('pinned abliterated source verifies with separate canonical tokenizer provenance', async t => {
  const f = await abliteratedFixture(t);
  const result = await verifyBundle(f.root);
  assert.deepEqual(result.lock.model, abliteratedSource);
  assert.deepEqual(result.lock.tokenizer, SOURCE_MODEL);
  assert.equal(f.metadata.language.tokenizer, SOURCE_MODEL.repository);
  assert.equal(result.records.size, 6);
});

test('rejects an unapproved revision of the abliterated source', async t => {
  const f = await fixture(t);
  f.lock.model = {...abliteratedSource, revision: '0'.repeat(40)};
  f.lock.tokenizer = {...SOURCE_MODEL};
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /Unapproved model provenance/);
});

test('rejects an unapproved derived repository at the approved revision', async t => {
  const f = await fixture(t);
  f.lock.model = {...abliteratedSource, repository: 'other/gemma-4-E2B-it-abliterated'};
  f.lock.tokenizer = {...SOURCE_MODEL};
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /Unapproved model provenance/);
});

for (const tokenizer of [undefined, {...SOURCE_MODEL, revision: '0'.repeat(40)}, {...abliteratedSource}]) {
  test(`rejects abliterated source with unapproved tokenizer provenance ${JSON.stringify(tokenizer)}`, async t => {
    const f = await fixture(t);
    f.lock.model = {...abliteratedSource};
    f.lock.tokenizer = tokenizer;
    await f.saveLock();
    await assert.rejects(verifyBundle(f.root), /Unapproved tokenizer provenance/);
  });
}

test('abliterated source still requires the canonical tokenizer in bundle metadata', async t => {
  const f = await abliteratedFixture(t);
  await f.changeMetadata(metadata => { metadata.language.tokenizer = abliteratedSource.repository; });
  await assert.rejects(verifyBundle(f.root), /metadata/);
});

for (const [label, source] of [
  ['missing source', undefined],
  ['Google source label', {hf_model_id: SOURCE_MODEL.repository, revision: SOURCE_MODEL.revision}],
  ['wrong source revision', {hf_model_id: abliteratedSource.repository, revision: '0'.repeat(40)}],
]) {
  test(`rejects abliterated metadata with ${label} despite a matching digest`, async t => {
    const f = await abliteratedFixture(t);
    await f.changeMetadata(metadata => { metadata.source = source; });
    await assert.rejects(verifyBundle(f.root), /Gemma metadata source differs from model provenance/);
  });
}

test('rejects a nonempty .aimodel file instead of a model directory', async t => {
  const f = await fixture(t);
  const record = f.lock.files.find(entry => entry.path === 'gemma.aimodel/weights.bin');
  const contents = await fs.readFile(path.join(f.source, record.path));
  await fs.rm(path.join(f.source, 'gemma.aimodel'), {recursive: true});
  await fs.writeFile(path.join(f.source, 'gemma.aimodel'), contents);
  record.path = 'gemma.aimodel';
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /nonempty Core AI/);
});

test('rejects a model directory whose inventory contains only empty files', async t => {
  const f = await fixture(t);
  const record = f.lock.files.find(entry => entry.path === 'gemma.aimodel/weights.bin');
  await fs.writeFile(path.join(f.source, record.path), '');
  Object.assign(record, {bytes: 0, sha256: createHash('sha256').update('').digest('hex')});
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /nonempty Core AI/);
});

for (const ple of ['gemma.aimodel', 'gemma.aimodel/weights.bin']) {
  test(`rejects overlapping PLE ${ple} even when main supplies nonempty bytes`, async t => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.source, 'gemma.ple'));
    f.lock.files = f.lock.files.filter(record => record.path !== 'gemma.ple');
    await f.changeMetadata(metadata => { metadata.auxiliary_assets.per_layer_embeddings = ple; });
    await assert.rejects(verifyBundle(f.root), /overlap/);
  });
}

test('rejects a PLE directory that contains the main asset', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, 'assets'));
  await fs.rename(path.join(f.source, 'gemma.aimodel'), path.join(f.source, 'assets/gemma.aimodel'));
  f.lock.files.find(record => record.path === 'gemma.aimodel/weights.bin').path = 'assets/gemma.aimodel/weights.bin';
  await fs.unlink(path.join(f.source, 'gemma.ple'));
  f.lock.files = f.lock.files.filter(record => record.path !== 'gemma.ple');
  await f.changeMetadata(metadata => {
    metadata.assets.main = 'assets/gemma.aimodel';
    metadata.auxiliary_assets.per_layer_embeddings = 'assets';
  });
  await assert.rejects(verifyBundle(f.root), /overlap/);
});

test('accepts a distinct PLE directory with a shared filename prefix', async t => {
  const f = await fixture(t);
  const ple = 'gemma.aimodel-ple';
  await fs.mkdir(path.join(f.source, ple));
  const record = f.lock.files.find(entry => entry.path === 'gemma.ple');
  await fs.rename(path.join(f.source, record.path), path.join(f.source, ple, 'embeddings.bin'));
  record.path = `${ple}/embeddings.bin`;
  await f.changeMetadata(metadata => { metadata.auxiliary_assets.per_layer_embeddings = ple; });
  assert.equal((await verifyBundle(f.root)).records.size, 6);
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

test('rejects the omitted standalone Gemma chat template even with a matching inventory', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, 'tokenizer/chat_template.jinja'));
  f.lock.files = f.lock.files.filter(record => record.path !== 'tokenizer/chat_template.jinja');
  await f.saveLock();
  await assert.rejects(verifyBundle(f.root), /Required nonempty bundle file missing: tokenizer\/chat_template\.jinja/);
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
  assert.equal((await copyBundle(f.root, f.env)).files, 6);
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

async function incrementalFixture(t) {
  const f = await fixture(t);
  f.env.DERIVED_FILE_DIR = path.join(f.buildRoot, 'DerivedFiles');
  await fs.mkdir(f.env.DERIVED_FILE_DIR);
  f.copy = () => copyBundle(f.root, f.env, {incremental: true});
  return f;
}

test('unchanged incremental copy does not reread model payloads', async t => {
  const f = await incrementalFixture(t);
  await f.copy();
  const payload = await fs.open(path.join(f.source, 'gemma.aimodel/weights.bin'));
  const identities = [await payload.stat(), await fs.stat(path.join(f.target, 'gemma.aimodel/weights.bin'))];
  const prototype = Object.getPrototypeOf(payload);
  const original = prototype.createReadStream;
  t.mock.method(prototype, 'createReadStream', function(...args) {
    const info = fstatSync(this.fd);
    assert.ok(identities.every(identity => info.dev !== identity.dev || info.ino !== identity.ino),
      'unchanged source and copied weights must not be read');
    return original.apply(this, args);
  });
  await payload.close();
  assert.equal((await f.copy()).cacheHit, true);
});

for (const location of ['source', 'target']) {
  test(`incremental copy rejects a same-size ${location} mutation with restored mtime`, async t => {
    const f = await incrementalFixture(t);
    await f.copy();
    const file = path.join(f[location], 'gemma.ple');
    const info = await fs.stat(file);
    await fs.writeFile(file, 'x'.repeat(info.size));
    await fs.utimes(file, info.atime, info.mtime);
    await assert.rejects(f.copy(), /integrity failed|Existing resource differs/);
  });
}

test('incremental copy detects added resources and missing destination files', async t => {
  const f = await incrementalFixture(t);
  await f.copy();
  const extra = path.join(f.target, 'unexpected');
  await fs.writeFile(extra, 'keep me');
  await assert.rejects(f.copy(), /Unlisted files/);
  assert.equal(await fs.readFile(extra, 'utf8'), 'keep me');
  await fs.unlink(extra);
  await fs.unlink(path.join(f.target, 'gemma.ple'));
  assert.equal((await f.copy()).cacheHit, false);
  assert.equal(await fs.readFile(path.join(f.target, 'gemma.ple'), 'utf8'), 'tiny-test-ple');
});

test('incremental copy invalidates on lock or Node environment changes', async t => {
  const f = await incrementalFixture(t);
  await f.copy();
  const configuration = path.join(f.env.SRCROOT, '.xcode.env');
  await fs.writeFile(configuration, '# updated Node configuration\n');
  assert.equal((await f.copy()).cacheHit, false);
  assert.equal((await f.copy()).cacheHit, true);
  f.lock.files.find(record => record.path === 'gemma.ple').sha256 = '0'.repeat(64);
  await f.saveLock();
  await assert.rejects(f.copy(), /integrity failed/);
});

test('incremental absence cannot bypass required mode or retain stale resources', async t => {
  const f = await incrementalFixture(t);
  await fs.rm(f.source, {recursive: true});
  await fs.unlink(f.lockPath);
  f.env.ASSIST_REQUIRE_BUNDLED_GEMMA = '0';
  assert.equal(await f.copy(), null);
  f.env.ASSIST_REQUIRE_BUNDLED_GEMMA = '1';
  await assert.rejects(f.copy(), /required/);
  f.env.ASSIST_REQUIRE_BUNDLED_GEMMA = '0';
  await fs.mkdir(f.target, {recursive: true});
  await assert.rejects(f.copy(), /Stale bundled Gemma/);
});

test('corrupt incremental state triggers full verification and never caches a failure', async t => {
  const f = await incrementalFixture(t);
  await f.copy();
  const marker = path.join(f.env.DERIVED_FILE_DIR, 'assist-gemma-verified.json');
  await fs.writeFile(marker, '{');
  assert.equal((await f.copy()).cacheHit, false);
  await fs.writeFile(path.join(f.source, 'gemma.ple'), 'changed');
  await assert.rejects(f.copy(), /integrity failed/);
  assert.equal(await fs.stat(marker).catch(error => error.code), 'ENOENT');
});

test('incremental state cannot bless a destination mutation after its final hash', async t => {
  const f = await incrementalFixture(t);
  const payload = await fs.open(path.join(f.source, 'gemma.ple'));
  const prototype = Object.getPrototypeOf(payload);
  const original = prototype.stat;
  await payload.close();
  const destination = path.join(f.target, 'gemma.ple');
  let destinationStats = 0;
  t.mock.method(prototype, 'stat', async function(...args) {
    const verifiedStat = await original.apply(this, args);
    const current = await fs.stat(destination, {bigint: true}).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current && current.dev === verifiedStat.dev && current.ino === verifiedStat.ino && ++destinationStats === 2) {
      await fs.writeFile(destination, 'x'.repeat(Number(current.size)));
    }
    return verifiedStat;
  });
  await assert.rejects(f.copy(), /changed during verification/);
  assert.equal(await fs.stat(path.join(f.env.DERIVED_FILE_DIR, 'assist-gemma-verified.json'))
    .catch(error => error.code), 'ENOENT');
});

for (const linked of [false, true]) {
test(`Xcode shell entry point reuses the verified copy${linked ? ' through a symlinked project path' : ''}`, async t => {
  const f = await incrementalFixture(t);
  await fs.mkdir(path.join(f.root, 'scripts'));
  for (const name of ['bundle-gemma.mjs', 'bundle-gemma-xcode.sh']) {
    await fs.copyFile(new URL(`./${name}`, import.meta.url), path.join(f.root, 'scripts', name));
  }
  const entryRoot = linked ? path.join(f.root, 'project-link') : f.root;
  if (linked) await fs.symlink(f.root, entryRoot);
  const command = path.join(entryRoot, 'scripts/bundle-gemma-xcode.sh');
  const invoke = () => spawnSync('bash', [command], {
    env: {...process.env, ...f.env, SRCROOT: path.join(entryRoot, 'mobile/ios'), NODE_BINARY: process.execPath}, encoding: 'utf8',
  });
  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /copied and verified/);
  const second = invoke();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged; verified copy reused/);
});
}

test('incremental cache path cannot create directories through a symlink into the source', async t => {
  const f = await incrementalFixture(t);
  const alias = path.join(f.root, 'derived-alias');
  await fs.symlink(f.source, alias);
  f.env.DERIVED_FILE_DIR = path.join(alias, 'new-derived-files');
  await assert.rejects(f.copy(), /outside model resources/);
  assert.equal(await fs.stat(path.join(f.source, 'new-derived-files')).catch(error => error.code), 'ENOENT');
});

test('incremental cache stays outside the entire app bundle', async t => {
  const f = await incrementalFixture(t);
  const app = path.join(f.buildRoot, f.env.UNLOCALIZED_RESOURCES_FOLDER_PATH);
  f.env.DERIVED_FILE_DIR = path.join(app, 'DerivedFiles');
  await assert.rejects(f.copy(), /outside model resources/);
  assert.equal(await fs.stat(app).catch(error => error.code), 'ENOENT');
});
