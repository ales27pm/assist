import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

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
