import { WeatherPresentationGate } from '../src/WeatherPresentationGate';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
test('non-weather replies do not wait or invent attribution', async () => {
  await expect(new WeatherPresentationGate().wait('request')).resolves.toBe(
    true,
  );
});
test('all actual native marks must load; unrelated or old events do not release the answer', async () => {
  const gate = new WeatherPresentationGate();
  gate.expect('request', 'forecast1');
  gate.expect('request', 'forecast2');
  const done = jest.fn();
  const pending = gate.wait('request').then(done);
  gate.update('old', 'forecast1', 'ready');
  gate.update('request', 'unknown', 'ready');
  gate.update('request', 'forecast1', 'ready');
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  gate.update('request', 'forecast2', 'ready');
  await pending;
  expect(done).toHaveBeenCalledWith(true);
});
test('repeat expectation preserves a loaded official mark', async () => {
  const gate = new WeatherPresentationGate();
  gate.expect('request', 'forecast');
  gate.update('request', 'forecast', 'ready');
  gate.expect('request', 'forecast');
  await expect(gate.wait('request')).resolves.toBe(true);
});
test('mark failure blocks answer/TTS without retrying tool execution', async () => {
  const gate = new WeatherPresentationGate();
  gate.expect('request', 'forecast');
  const pending = gate.wait('request');
  gate.update('request', 'forecast', 'failed');
  await expect(pending).resolves.toBe(false);
});
test('absolute presentation deadline prevents an indefinite wait', async () => {
  const gate = new WeatherPresentationGate();
  gate.expect('request', 'forecast');
  const pending = gate.wait('request', 100);
  jest.advanceTimersByTime(100);
  await expect(pending).resolves.toBe(false);
});
test('cancellation closes only the specified task and ignores its late image load', async () => {
  const gate = new WeatherPresentationGate();
  gate.expect('old', 'forecast');
  gate.expect('new', 'forecast');
  const old = gate.wait('old');
  const current = gate.wait('new');
  gate.cancel('old');
  gate.update('old', 'forecast', 'ready');
  await expect(old).resolves.toBe(false);
  gate.update('new', 'forecast', 'ready');
  await expect(current).resolves.toBe(true);
});
test('global cancellation drains all presentation waiters', async () => {
  const gate = new WeatherPresentationGate();
  gate.expect('one', 'f');
  gate.expect('two', 'f');
  const one = gate.wait('one');
  const two = gate.wait('two');
  gate.cancel();
  await expect(one).resolves.toBe(false);
  await expect(two).resolves.toBe(false);
});
