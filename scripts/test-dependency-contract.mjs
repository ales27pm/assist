import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = async relative => JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));

test('UUID overrides resolve all consumer chains to the patched CommonJS release in both lockfiles', async () => {
  for (const relative of ['package-lock.json', 'mobile/package-lock.json']) {
    const lock = await read(relative);
    const uuids = Object.entries(lock.packages).filter(([name]) => name.endsWith('/uuid'));
    assert(uuids.length > 0);
    for (const [name, record] of uuids) assert.equal(record.version, '11.1.1', `${relative}: ${name}`);
  }
});

test('dependency fixes preserve the application framework and TypeScript versions', async () => {
  const mobile = await read('mobile/package.json');
  assert.equal(mobile.dependencies.expo, '~58.0.0');
  assert.equal(mobile.dependencies['react-native'], '0.88.0');
  assert.equal(mobile.devDependencies.typescript, '^6.0.3');
  const lock = await read('package-lock.json');
  for (const [name, version] of Object.entries({ajv: '8.20.0', joi: '17.13.8', minimatch: '5.1.8',
    nanoid: '3.3.18', tar: '7.5.22', yaml: '2.9.1'})) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
});

// Run against an isolated `npm ci --ignore-scripts` reconstruction; the repository's
// tracked node_modules deliberately remains untouched by the lockfile change.
test('reconstructed consumers retain their UUID APIs, Xcode project parsing and EAS schema', {
  skip: !process.env.ASSIST_DEPENDENCY_TEST_ROOT,
}, async () => {
  const dependencyRoot = await fs.realpath(process.env.ASSIST_DEPENDENCY_TEST_ROOT);
  assert.notEqual(dependencyRoot, root, 'Use an isolated dependency reconstruction');
  const require = createRequire(path.join(dependencyRoot, 'package.json'));
  for (const name of ['xcode', '@expo/bunyan', '@expo/rudder-sdk-node']) {
    const consumer = createRequire(require.resolve(`${name}/package.json`));
    assert.equal(consumer('uuid/package.json').version, '11.1.1');
    assert.match(consumer('uuid').v1(), /^[a-f0-9-]{36}$/);
    assert.match(consumer('uuid').v4(), /^[a-f0-9-]{36}$/);
  }
  const project = require('xcode').project(path.join(root, 'mobile/ios/Assist.xcodeproj/project.pbxproj'));
  project.parseSync();
  assert.match(project.generateUuid(), /^[A-F0-9]{24}$/);
  assert(project.writeSync().includes('org.27pm.assist'));
  const records = [];
  require('@expo/bunyan').createLogger({name: 'offline-fixture', streams: [
    {type: 'raw', stream: {write: record => records.push(record)}},
  ]}).info('test');
  assert.match(records[0].id, /^[a-f0-9-]{36}$/);
  // Instantiation is local; telemetry remains disabled and no event is sent.
  const Analytics = require('@expo/rudder-sdk-node').default;
  const analytics = new Analytics('synthetic-unused-key', 'http://127.0.0.1:1', {enable: false, flushInterval: 0});
  assert.equal(analytics.enable, false);
  const eas = require('@expo/eas-json');
  const accessor = eas.EasJsonAccessor.fromProjectPath(path.join(root, 'mobile'));
  const cli = await eas.EasJsonUtils.getCliConfigAsync(accessor);
  assert.equal(cli.requireCommit, true);
  assert.equal(require('eas-cli/package.json').version, '25.1.1');
});
