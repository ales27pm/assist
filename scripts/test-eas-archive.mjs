import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {prepareArchive} from './prepare-eas-archive.mjs';
import {EXPORTER, SOURCE_MODEL} from './bundle-gemma.mjs';

const require = createRequire(import.meta.url);
const {makeShallowCopyAsync} = require('eas-cli/build/vcs/local.js');
const digest = value => createHash('sha256').update(value).digest('hex');

test('EAS ignore rules include the staged bundle and lock while excluding other weights and secrets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assist-eas-archive-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  await fs.copyFile(new URL('../.easignore', import.meta.url), path.join(root, '.gitignore'));
  const included = [
    'mobile/gemma-bundle.lock.json',
    'mobile/ios/Assist/BundledModels/Gemma/metadata.json',
    'mobile/ios/Assist/BundledModels/Gemma/gemma.aimodel/main.mlirb',
    'mobile/ios/Assist/BundledModels/Gemma/gemma.aimodel/main.hash',
    'mobile/ios/Assist/BundledModels/Gemma/gemma.aimodel/metadata.json',
    'mobile/ios/Assist/BundledModels/Gemma/gemma.ple',
    'mobile/ios/Assist/BundledModels/Gemma/gemma_ple.safetensors',
    'mobile/ios/Assist/BundledModels/Gemma/tokenizer/tokenizer.json',
    'mobile/ios/Assist/BundledModels/Gemma/tokenizer/chat_template.jinja',
    'mobile/ios/Assist/NumericalProbe/RMSNormProbe.aimodel/main.mlirb',
    'mobile/ios/Assist/NumericalProbeFP32/RMSNormProbe.aimodel/main.mlirb',
    'scripts/bundle-gemma.mjs',
  ];
  const excluded = [
    'mobile/other.aimodel/main.mlirb',
    'mobile/ios/Assist/BundledModels/Other/other.aimodel/main.mlirb',
    'models/model.safetensors',
    'mobile/ios/Assist/BundledModels/Gemma/model.safetensors',
    'mobile/ios/Assist/BundledModels/Gemma/.env',
    'mobile/ios/Assist/BundledModels/Gemma/gemma.aimodel/private.key',
    'mobile/credentials.json',
    'mobile/node_modules/example/index.js',
  ];
  for (const file of [...included, ...excluded]) {
    await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
    await fs.writeFile(path.join(root, file), 'synthetic archive fixture');
    const result = spawnSync('git', ['-C', root, '-c', 'core.excludesFile=/dev/null',
      'check-ignore', '--no-index', '-q', '--', file]);
    assert.equal(result.status, excluded.includes(file) ? 0 : 1, `${file}: ${result.stderr}`);
  }
});

test('the installed EAS copier traverses source and probe directory exceptions without trailing slashes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assist-eas-copier-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await fs.mkdir(source);
  await fs.copyFile(new URL('../.easignore', import.meta.url), path.join(source, '.easignore'));
  const included = ['mobile/App.tsx', 'scripts/build.sh', 'mobile/.eas/build/ios.yml',
    'mobile/ios/Assist/NumericalProbe/RMSNormProbe.aimodel/main.mlirb',
    'mobile/ios/Assist/BundledModels/Gemma/gemma.aimodel/main.mlirb'];
  const excluded = ['mobile/.env', 'scripts/private.key', 'mobile/other.aimodel/main.mlirb',
    'mobile/node_modules/example/index.js'];
  for (const file of [...included, ...excluded]) {
    await fs.mkdir(path.dirname(path.join(source, file)), {recursive: true});
    await fs.writeFile(path.join(source, file), 'tiny untracked source/model fixture');
  }
  await makeShallowCopyAsync(source, target);
  for (const file of included) assert.equal(await fs.readFile(path.join(target, file), 'utf8'), 'tiny untracked source/model fixture');
  for (const file of excluded) await assert.rejects(fs.stat(path.join(target, file)), {code: 'ENOENT'});
});

async function fixture(t, {contextLength = 32768, secret = false} = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'assist-eas-preparation-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const root = path.join(temporary, 'source');
  const bundle = path.join(temporary, 'approved-bundle');
  const lock = path.join(temporary, 'approved-lock.json');
  await fs.mkdir(root);
  const git = args => {
    const result = spawnSync('git', ['-C', root, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const eas = {cli: {requireCommit: true}, build: {
    testflight: {extends: 'preview', env: {ASSIST_REQUIRE_BUNDLED_GEMMA: '0'}},
    preview: {env: {ASSIST_REQUIRE_BUNDLED_GEMMA: '1'}},
  }};
  const sources = {'mobile/eas.json': JSON.stringify(eas), 'mobile/package.json': '{}',
    'mobile/ios/Assist.xcodeproj/project.pbxproj': 'synthetic project',
    'scripts/bundle-gemma.mjs': '// synthetic build helper\n',
    '.gitignore': '/mobile/ios/Assist/BundledModels/\n/mobile/gemma-bundle.lock.json\n',
    ...(secret ? {'mobile/disguised.ts': '-----BEGIN ' + 'PRIVATE KEY-----\nsynthetic-test-only\n'} : {})};
  for (const [file, content] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
    await fs.writeFile(path.join(root, file), content);
  }
  await fs.copyFile(new URL('../.easignore', import.meta.url), path.join(root, '.easignore'));
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Archive fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic archive fixture']);
  const metadata = {metadata_version: '0.2', kind: 'llm', name: 'packaging-fixture-only',
    assets: {main: 'gemma.aimodel'}, auxiliary_assets: {per_layer_embeddings: 'gemma.ple'},
    language: {tokenizer: SOURCE_MODEL.repository, max_context_length: contextLength,
      embedded_tokenizer: true, vocab_size: 256, eos_token_ids: [1]}};
  const contents = {'metadata.json': JSON.stringify(metadata), 'gemma.aimodel/main.mlirb': 'tiny fake weights',
    'gemma.ple': 'tiny fake PLE', 'tokenizer/tokenizer.json': '{}', 'tokenizer/tokenizer_config.json': '{}',
    'tokenizer/chat_template.jinja': '{{ test }}'};
  const manifest = {schemaVersion: 1, model: {...SOURCE_MODEL}, export: {...EXPORTER, contextLength}, files: []};
  for (const [file, content] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(bundle, file)), {recursive: true});
    await fs.writeFile(path.join(bundle, file), content);
    manifest.files.push({path: file, bytes: Buffer.byteLength(content), sha256: digest(content)});
  }
  const lockContent = JSON.stringify(manifest);
  await fs.writeFile(lock, lockContent);
  const options = {projectRoot: root, profile: 'preview', output: path.join(temporary, 'prepared'),
    bundleDirectory: bundle, lockPath: lock, lockSHA256: digest(lockContent)};
  return {root, bundle, lock, options, git, sources};
}

test('preview copies the approved untracked 32K bundle with actual EAS and records exact source/resource hashes', async t => {
  const f = await fixture(t);
  const report = await prepareArchive(f.options);
  assert.equal(report.sourceRevision, f.git(['rev-parse', 'HEAD']).trim());
  assert.equal(report.normalRequireCommit, true);
  assert.equal(report.stagingRequireCommit, false);
  assert.equal(report.modelContextLength, 32768);
  assert(report.files.some(record => record.path.endsWith('Gemma/gemma.aimodel/main.mlirb') && record.sha256 === digest('tiny fake weights')));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'mobile/eas.json'), 'utf8')).cli.requireCommit, true);
  assert.equal(f.git(['status', '--porcelain']), '');
  const written = JSON.parse(await fs.readFile(path.join(f.options.output, 'archive-inventory.json'), 'utf8'));
  assert.deepEqual(written, report);
  assert.equal(digest(await fs.readFile(path.join(f.options.output, 'project.tar.gz'))), report.archive.sha256);
});

test('TestFlight retains requireCommit and contains no bundled model', async t => {
  const f = await fixture(t);
  const report = await prepareArchive({projectRoot: f.root, profile: 'testflight', output: f.options.output});
  assert.equal(report.stagingRequireCommit, true);
  assert(!report.files.some(record => record.path.includes('BundledModels') || record.path.endsWith('gemma-bundle.lock.json')));
  const eas = JSON.parse(await fs.readFile(path.join(f.options.output, 'archive-tree/mobile/eas.json'), 'utf8'));
  assert.equal(eas.build.testflight.env.ASSIST_REQUIRE_BUNDLED_GEMMA, '0');
});

test('dirty source is rejected before creating any preparation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'mobile/new-source.ts'), '// not committed');
  await assert.rejects(prepareArchive(f.options), /clean committed source/);
  await assert.rejects(fs.stat(f.options.output), {code: 'ENOENT'});
});

test('a wrong reviewed lock digest is rejected before creating a preparation', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareArchive({...f.options, lockSHA256: '0'.repeat(64)}), /lock SHA-256 mismatch/);
});

test('missing or extra model resources fail closed and remove only the new preparation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.bundle, 'unlisted.bin'), 'unapproved');
  await assert.rejects(prepareArchive(f.options), /missing or unlisted files/);
  await assert.rejects(fs.stat(f.options.output), {code: 'ENOENT'});
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('8K exports cannot silently replace the full 32K candidate', async t => {
  const f = await fixture(t, {contextLength: 8192});
  await assert.rejects(prepareArchive(f.options), /complete 32K context/);
});

test('a private key disguised as source is rejected before producing an archive', async t => {
  const f = await fixture(t, {secret: true});
  await assert.rejects(prepareArchive(f.options), /Private key material forbidden/);
  await assert.rejects(fs.stat(f.options.output), {code: 'ENOENT'});
});

test('an existing output directory is preserved', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.options.output);
  await fs.writeFile(path.join(f.options.output, 'keep'), 'existing work');
  await assert.rejects(prepareArchive(f.options), {code: 'EEXIST'});
  assert.equal(await fs.readFile(path.join(f.options.output, 'keep'), 'utf8'), 'existing work');
});
