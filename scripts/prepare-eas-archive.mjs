#!/usr/bin/env node
// Offline preparation only. Never invokes EAS build, upload, credentials or submit.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {verifyBundle} from './bundle-gemma.mjs';

const require = createRequire(import.meta.url);
const easRoot = path.dirname(require.resolve('eas-cli/package.json'));
const {default: GitClient} = require(path.join(easRoot, 'build/vcs/clients/git.js'));
const {Ignore} = require(path.join(easRoot, 'build/vcs/local.js'));
const {assertProjectTarballSizeDoesNotExceedLimit} = require(path.join(easRoot, 'build/build/utils/repository.js'));
const tar = require(require.resolve('tar', {paths: [easRoot]}));
const BUNDLE = 'mobile/ios/Assist/BundledModels/Gemma';
const LOCK = 'mobile/gemma-bundle.lock.json';
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|credentials\.json|\.xcode\.env\.local)$|\.(?:p12|p8|pem|key|mobileprovision|keystore)$/i;

const git = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

async function digestFile(file, {rejectPrivateKey = false, relative = ''} = {}) {
  const digest = createHash('sha256');
  let bytes = 0;
  let tail = '';
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    digest.update(chunk);
    if (rejectPrivateKey) {
      const text = tail + chunk.toString('latin1');
      assert(!/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text),
        `Private key material forbidden in archive: ${relative}`);
      tail = text.slice(-100);
    }
  }
  return {bytes, sha256: digest.digest('hex')};
}

async function inventory(root) {
  const records = [];
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assert(!/[\0\r\n\\]/.test(relative), 'Archive paths must be canonical');
      const full = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), 'Archive symlinks are forbidden');
      if (entry.isDirectory()) await walk(full, relative);
      else {
        assert(entry.isFile(), 'Archive special files are forbidden');
        assert(!SECRET_PATH.test(relative), `Secret file forbidden in archive: ${relative}`);
        records.push({path: relative, ...(await digestFile(full, {rejectPrivateKey: true, relative}))});
      }
    }
  }
  await walk(root);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

/** Prepare a local EAS archive from a clean, exact HEAD plus an explicitly reviewed 32K bundle. */
export async function prepareArchive({projectRoot, profile, output, bundleDirectory, lockPath, lockSHA256}) {
  assert(['preview', 'testflight'].includes(profile), 'Profile must be preview or testflight');
  const root = await fs.realpath(projectRoot);
  assert.equal(git(root, ['rev-parse', '--show-toplevel']).trim(), root, 'Use the repository root');
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all']), '',
    'A clean committed source candidate is required; existing work was not changed');
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  assert(/^[a-f0-9]{40,64}$/.test(revision), 'Exact source revision required');
  const requestedDestination = path.resolve(output);
  const destinationParent = await fs.realpath(path.dirname(requestedDestination));
  const destination = path.join(destinationParent, path.basename(requestedDestination));
  assert(!inside(root, destination), 'Output must be outside the source repository');
  if (profile === 'preview') {
    assert(bundleDirectory && lockPath && /^[a-f0-9]{64}$/.test(lockSHA256 ?? ''),
      'Preview requires --bundle, --lock and the independently reviewed --lock-sha256');
    const bundle = await fs.realpath(bundleDirectory);
    assert(!inside(bundle, destination), 'Output must be outside the approved bundle');
    assert.equal((await digestFile(lockPath)).sha256, lockSHA256, 'Reviewed lock SHA-256 mismatch');
  } else {
    assert(!bundleDirectory && !lockPath && !lockSHA256, 'TestFlight uses signed model import; do not stage bundled weights');
  }
  await fs.mkdir(destination, {mode: 0o700}); // Never overwrite another preparation.
  try {
    const staging = path.join(destination, 'staging');
    const archiveRoot = path.join(destination, 'archive-tree');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--depth', '1', pathToFileURL(root).href, staging],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    assert.equal(git(staging, ['rev-parse', 'HEAD']).trim(), revision, 'Source HEAD changed during preparation');
    const configPath = path.join(staging, 'mobile/eas.json');
    const originalConfig = await fs.readFile(configPath);
    const config = JSON.parse(originalConfig);
    assert.equal(config.cli?.requireCommit, true, 'Normal source must retain requireCommit: true');
    assert.equal(config.build?.testflight?.env?.ASSIST_REQUIRE_BUNDLED_GEMMA, '0', 'TestFlight model import contract changed');
    assert.equal(config.build?.preview?.env?.ASSIST_REQUIRE_BUNDLED_GEMMA, '1', 'Preview must require bundled Gemma');
    const tracked = git(staging, ['ls-files', '-z']).split('\0').filter(Boolean);
    assert(!tracked.some(file => file.startsWith(`${BUNDLE}/`) || file === LOCK),
      'Bundled weights and their external reviewed lock must stay outside Git');
    let verified;
    if (profile === 'preview') {
      await fs.mkdir(path.dirname(path.join(staging, BUNDLE)), {recursive: true});
      await fs.cp(bundleDirectory, path.join(staging, BUNDLE), {recursive: true, verbatimSymlinks: true});
      await fs.copyFile(lockPath, path.join(staging, LOCK));
      assert.equal((await digestFile(path.join(staging, LOCK))).sha256, lockSHA256, 'Reviewed lock changed during copying');
      verified = await verifyBundle(staging);
      assert.equal(verified.lock.export.contextLength, 32768, 'Preview must preserve the complete 32K context');
      config.cli.requireCommit = false; // Only this isolated staging tree permits external resources.
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    const expected = new Map();
    const ignore = await Ignore.createForCheckingAsync(staging);
    for (const relative of tracked) {
      if (!ignore.ignores(relative)) {
        assert((await fs.lstat(path.join(staging, relative))).isFile(), 'Committed archive source must be a regular file');
        expected.set(relative, await digestFile(path.join(staging, relative)));
      }
    }
    if (verified) {
      expected.set(LOCK, await digestFile(path.join(staging, LOCK)));
      for (const [relative, record] of verified.records) expected.set(`${BUNDLE}/${relative}`, record);
    }
    // Exercise the installed EAS Git clone AND local copier, not git check-ignore alone.
    const client = new GitClient({maybeCwdOverride: staging, requireCommit: profile !== 'preview'});
    await client.makeShallowCopyAsync(archiveRoot);
    const files = await inventory(archiveRoot);
    assert.equal(files.length, expected.size, 'EAS archive has missing or unexpected files');
    for (const record of files) {
      const source = expected.get(record.path);
      assert(source && source.bytes === record.bytes && source.sha256 === record.sha256,
        `EAS archive is missing, changed or unexpected: ${record.path}`);
    }
    for (const required of ['mobile/eas.json', 'mobile/package.json', 'mobile/ios/Assist.xcodeproj/project.pbxproj', 'scripts/bundle-gemma.mjs']) {
      assert(expected.has(required), `Required source excluded by EAS: ${required}`);
    }
    const archive = path.join(destination, 'project.tar.gz');
    await tar.create({cwd: archiveRoot, file: archive, prefix: 'project', gzip: true, portable: true}, ['.']);
    const compressed = await digestFile(archive);
    assertProjectTarballSizeDoesNotExceedLimit(compressed.bytes);
    assert.deepEqual(await inventory(archiveRoot), files, 'EAS copy changed during compression');
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all']), '', 'Source changed during preparation');
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), revision, 'Source HEAD changed during preparation');
    const report = {schemaVersion: 1, sourceRevision: revision, profile,
      easVersion: require(path.join(easRoot, 'package.json')).version,
      normalRequireCommit: true, stagingRequireCommit: config.cli.requireCommit,
      configSourceSHA256: sha256(originalConfig),
      ...(verified ? {reviewedLockSHA256: lockSHA256, modelContextLength: 32768} : {}),
      archive: {path: 'project.tar.gz', ...compressed}, files};
    await fs.writeFile(path.join(destination, 'archive-inventory.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    await fs.rm(destination, {recursive: true, force: true});
    throw error;
  }
}

async function main() {
  const names = {'--project-root': 'projectRoot', '--profile': 'profile', '--output': 'output',
    '--bundle': 'bundleDirectory', '--lock': 'lockPath', '--lock-sha256': 'lockSHA256'};
  const options = {};
  const args = process.argv.slice(2);
  assert(args.length % 2 === 0, 'Expected option/value pairs');
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    assert(key && !Object.hasOwn(options, key), 'Unknown or duplicate archive option');
    options[key] = args[i + 1];
  }
  assert(options.projectRoot && options.output && options.profile,
    'Usage: prepare-eas-archive.mjs --project-root ROOT --profile preview|testflight --output NEW_EXTERNAL_DIRECTORY [--bundle DIR --lock FILE --lock-sha256 SHA256]');
  const result = await prepareArchive(options);
  console.log(`Offline EAS archive verified: ${result.files.length} files, source ${result.sourceRevision}, profile ${result.profile}. No upload or build was launched.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`EAS archive preparation failed: ${error.message}`); process.exitCode = 1; });
}
