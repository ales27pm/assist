export type WeatherPresentationStatus = 'loading' | 'ready' | 'failed';
type Entry = {
  marks: Map<string, WeatherPresentationStatus>;
  waiters: Set<(ready: boolean) => void>;
};

/** Presentation evidence, not tool authority. A final native weather receipt
 * must have its actual provider mark loaded before its answer can be shown or
 * spoken. Cancellation closes waiters; it never replays a weather request. */
export class WeatherPresentationGate {
  private entries = new Map<string, Entry>();

  expect(requestId: string, forecastId: string) {
    let entry = this.entries.get(requestId);
    if (!entry) {
      entry = { marks: new Map(), waiters: new Set() };
      this.entries.set(requestId, entry);
    }
    if (!entry.marks.has(forecastId)) entry.marks.set(forecastId, 'loading');
  }

  update(
    requestId: string,
    forecastId: string,
    status: WeatherPresentationStatus,
  ) {
    const entry = this.entries.get(requestId);
    if (!entry?.marks.has(forecastId)) return;
    entry.marks.set(forecastId, status);
    const result = this.settled(entry);
    if (result !== undefined) {
      for (const done of entry.waiters) done(result);
      entry.waiters.clear();
    }
  }

  private settled(entry: Entry): boolean | undefined {
    const states = [...entry.marks.values()];
    if (states.includes('failed')) return false;
    return states.every(state => state === 'ready') ? true : undefined;
  }

  wait(requestId: string, timeoutMs = 25000): Promise<boolean> {
    const entry = this.entries.get(requestId);
    if (!entry) return Promise.resolve(true); // no native weather evidence
    const settled = this.settled(entry);
    if (settled !== undefined) return Promise.resolve(settled);
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        entry.waiters.delete(finish);
        resolve(ready);
      };
      entry.waiters.add(finish);
    });
  }

  cancel(requestId?: string) {
    for (const [id, entry] of this.entries) {
      if (requestId !== undefined && id !== requestId) continue;
      for (const done of entry.waiters) done(false);
      this.entries.delete(id);
    }
  }
}
