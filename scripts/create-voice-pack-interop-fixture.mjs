#!/usr/bin/env node
// Synthetic Node -> CryptoKit interoperability fixture. Never uses a release key.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { generateKey, signPack } from './voice-pack-signing.mjs';

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error('Supply an absolute, new fixture directory');
await mkdir(destination); // Fail if it exists: do not overwrite someone else's files.
const temporaryKeys = await realpath(await mkdtemp(join(tmpdir(), 'assist-interop-key-')));
try {
  const pack = join(destination, 'pack');
  await mkdir(pack);
  const bytes = Buffer.from('Synthetic compatible weights from the Node signPack implementation');
  const asset = { path: 'Model.mlmodelc/weight.bin', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const reference = { schemaVersion: 1, sdkRevision: 'b'.repeat(40), groups: {} };
  for (const name of ['pocket', 'redux', 'ultra', 'silero']) {
    reference.groups[name] = { repository: 'fixture', revision: 'a'.repeat(40), files: [asset] };
    if (name === 'ultra') continue;
    await mkdir(join(pack, name, 'Model.mlmodelc'), { recursive: true });
    await writeFile(join(pack, name, asset.path), bytes);
  }
  const manifestPath = join(destination, 'reference.json');
  await writeFile(manifestPath, JSON.stringify(reference));
  const privateKeyPath = join(temporaryKeys, 'key.pem');
  const publicInfo = await generateKey(privateKeyPath, 'interop-key');
  await signPack({ pack, manifestPath, privateKeyPath, keyId: publicInfo.keyId,
    version: 'interop-1.0', reference });
  await writeFile(join(destination, 'public-key.json'), JSON.stringify(publicInfo));
} finally {
  await rm(temporaryKeys, { recursive: true, force: true });
}
console.log('Prepared synthetic interoperability fixture; temporary private key removed.');
