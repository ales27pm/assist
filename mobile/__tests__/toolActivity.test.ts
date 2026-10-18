import type { CalendarAgentTrace } from '../src/protocol';
import {
  finishCalendarTransaction,
  interruptCalendarTransaction,
  parseCalendarActivity,
  reduceCalendarActivity,
} from '../src/toolActivity';
import type {
  CalendarActivity,
  CalendarToolTransaction,
} from '../src/toolActivity';

const scope = {
  startISO: '2026-10-18T04:00:00Z',
  endISO: '2026-10-19T04:00:00Z',
  timeZoneIdentifier: 'America/Toronto',
};
const otherScope = {
  startISO: '2026-10-19T04:00:00Z',
  endISO: '2026-10-20T04:00:00Z',
  timeZoneIdentifier: 'America/Toronto',
};
const receipt: CalendarAgentTrace = {
  schemaVersion: 1,
  tool: 'calendar.list',
  callId: 'calendar-read-1',
  scope,
  returnedCount: 1,
  possiblyTruncated: false,
};

function transaction(): CalendarToolTransaction {
  return { id: 'request-1', status: 'proposed' };
}

function activity(
  phase: CalendarActivity['phase'],
  requestId = 'request-1',
): CalendarActivity {
  const sequence = { planning: 1, executing: 2, observing: 3 } as const;
  return {
    schemaVersion: 1,
    requestId,
    sequence: sequence[phase],
    phase,
    scope,
    ...(phase === 'observing' ? { receipt } : {}),
  };
}

function observing(): CalendarToolTransaction {
  return ['planning', 'executing', 'observing'].reduce(
    (current, phase) =>
      reduceCalendarActivity(
        current,
        activity(phase as CalendarActivity['phase']),
      ),
    transaction(),
  );
}

describe('closed calendar activity metadata', () => {
  it.each(['planning', 'executing', 'observing'] as const)(
    'accepts the native %s phase and its exact sequence',
    phase => {
      const event = activity(phase);
      expect(parseCalendarActivity(JSON.stringify(event))).toEqual(event);
    },
  );

  it.each([null, [], 'not an object', 1, true])(
    'rejects non-object activity %j',
    value => {
      expect(() => parseCalendarActivity(JSON.stringify(value))).toThrow();
    },
  );

  it('rejects malformed JSON and oversized valid JSON including trailing whitespace', () => {
    expect(() => parseCalendarActivity('{')).toThrow();
    const json = JSON.stringify(activity('planning'));
    expect(() =>
      parseCalendarActivity(json + ' '.repeat(4_097 - json.length)),
    ).toThrow();
  });

  it.each([
    ['wrong version', { ...activity('planning'), schemaVersion: 2 }],
    ['string sequence', { ...activity('planning'), sequence: '1' }],
    ['fractional sequence', { ...activity('planning'), sequence: 1.5 }],
    ['unknown phase', { ...activity('planning'), phase: 'success' }],
    ['mismatched phase sequence', { ...activity('planning'), sequence: 2 }],
    ['empty request identity', { ...activity('planning'), requestId: '' }],
    [
      'invalid request identity',
      { ...activity('planning'), requestId: 'bad\nrequest' },
    ],
    ['missing scope', { ...activity('planning'), scope: undefined }],
    [
      'invalid scope dates',
      { ...activity('planning'), scope: { ...scope, endISO: scope.startISO } },
    ],
    [
      'extra scope field',
      {
        ...activity('planning'),
        scope: { ...scope, permission: 'authorized' },
      },
    ],
    ['unexpected planning receipt', { ...activity('planning'), receipt }],
    ['unexpected executing receipt', { ...activity('executing'), receipt }],
    [
      'missing observation receipt',
      { ...activity('observing'), receipt: undefined },
    ],
    [
      'different observation scope',
      { ...activity('observing'), scope: otherScope },
    ],
    [
      'unbounded result count',
      { ...activity('observing'), receipt: { ...receipt, returnedCount: 6 } },
    ],
    [
      'wrong receipt tool',
      {
        ...activity('observing'),
        receipt: { ...receipt, tool: 'calendar.create' },
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => parseCalendarActivity(JSON.stringify(value))).toThrow();
  });

  it.each(['text', 'arguments', 'events', 'title', 'authorization'])(
    'rejects private or authority-bearing extra field %s',
    key => {
      const value = { ...activity('planning'), [key]: 'PRIVATE_TOOL_DATA' };
      expect(() => parseCalendarActivity(JSON.stringify(value))).toThrow();
    },
  );
});

describe('calendar transaction progression', () => {
  it('advances one request from proposed through execution to observed native receipt', () => {
    const original = transaction();
    const planning = reduceCalendarActivity(original, activity('planning'));
    expect(planning).toMatchObject({
      id: 'request-1',
      status: 'proposed',
      lastSequence: 1,
      scope,
    });
    expect(planning.receipt).toBeUndefined();
    const executing = reduceCalendarActivity(planning, activity('executing'));
    expect(executing).toMatchObject({ status: 'executing', lastSequence: 2 });
    expect(executing.receipt).toBeUndefined();
    const observed = reduceCalendarActivity(executing, activity('observing'));
    expect(observed).toMatchObject({
      status: 'observing',
      lastSequence: 3,
      receipt,
    });
    expect(original).toEqual(transaction());
  });

  it('ignores another request, replayed phases, and skipped phases', () => {
    const initial = transaction();
    expect(
      reduceCalendarActivity(initial, activity('planning', 'request-2')),
    ).toEqual(initial);
    expect(reduceCalendarActivity(initial, activity('executing'))).toEqual(
      initial,
    );
    expect(reduceCalendarActivity(initial, activity('observing'))).toEqual(
      initial,
    );
    const planned = reduceCalendarActivity(initial, activity('planning'));
    expect(reduceCalendarActivity(planned, activity('planning'))).toEqual(
      planned,
    );
    expect(reduceCalendarActivity(planned, activity('observing'))).toEqual(
      planned,
    );
    const observed = observing();
    expect(reduceCalendarActivity(observed, activity('executing'))).toEqual(
      observed,
    );
    expect(reduceCalendarActivity(observed, activity('observing'))).toEqual(
      observed,
    );
  });

  it('starts sequence one only from the proposed state', () => {
    const executing: CalendarToolTransaction = {
      id: 'request-1',
      status: 'executing',
    };
    expect(reduceCalendarActivity(executing, activity('planning'))).toEqual(
      executing,
    );
  });

  it('cannot change the captured period midway through a request', () => {
    const planned = reduceCalendarActivity(transaction(), activity('planning'));
    const next = { ...activity('executing'), scope: otherScope };
    expect(reduceCalendarActivity(planned, next)).toEqual(planned);
  });

  it('ignores late activity immediately after cancellation is requested', () => {
    const pending = { ...transaction(), cancelRequested: true };
    expect(reduceCalendarActivity(pending, activity('planning'))).toEqual(
      pending,
    );
    expect(finishCalendarTransaction(pending, receipt)).toEqual(pending);
  });

  it.each(['success', 'failed_safe', 'cancelled'] as const)(
    'never resurrects a terminal %s transaction with a late event or result',
    status => {
      const terminal: CalendarToolTransaction = { ...observing(), status };
      expect(reduceCalendarActivity(terminal, activity('planning'))).toEqual(
        terminal,
      );
      expect(reduceCalendarActivity(terminal, activity('observing'))).toEqual(
        terminal,
      );
      expect(finishCalendarTransaction(terminal, receipt)).toEqual(terminal);
      expect(interruptCalendarTransaction(terminal, 'unconfirmed')).toEqual(
        terminal,
      );
    },
  );
});

describe('native evidence and terminal outcomes', () => {
  it('confirms a read only with its validated matching native trace', () => {
    const observed = observing();
    const completed = finishCalendarTransaction(observed, receipt);
    expect(completed).toMatchObject({ status: 'success', scope, receipt });
    expect(observed.status).toBe('observing');
  });

  it('accepts a final native trace when transport did not deliver intermediate events', () => {
    expect(finishCalendarTransaction(transaction(), receipt)).toMatchObject({
      status: 'success',
      scope,
      receipt,
    });
  });

  it.each([0, 5])(
    'preserves the bounded receipt for %s returned events',
    count => {
      const trace = {
        ...receipt,
        returnedCount: count,
        possiblyTruncated: count === 5,
      };
      expect(finishCalendarTransaction(transaction(), trace)).toMatchObject({
        status: 'success',
        receipt: trace,
      });
    },
  );

  it.each([null, undefined])(
    'does not claim a read without a native trace (%s)',
    trace => {
      const completed = finishCalendarTransaction(transaction(), trace);
      expect(completed.status).toBe('cancelled');
      expect(completed.receipt).toBeUndefined();
    },
  );

  it('refuses a final response that omits an already observed native receipt', () => {
    const observed = observing();
    expect(() => finishCalendarTransaction(observed, undefined)).toThrow();
    expect(observed).toMatchObject({ status: 'observing', receipt });
  });

  it('does not claim no read after native execution started but the final trace is missing', () => {
    const planned = reduceCalendarActivity(transaction(), activity('planning'));
    const executing = reduceCalendarActivity(planned, activity('executing'));
    expect(() => finishCalendarTransaction(executing, undefined)).toThrow();
    expect(executing.status).toBe('executing');
  });

  it.each([
    { ...receipt, returnedCount: -1 },
    { ...receipt, returnedCount: 6 },
    { ...receipt, returnedCount: '1' },
    { ...receipt, possiblyTruncated: true },
    { ...receipt, schemaVersion: 2 },
    { ...receipt, title: 'PRIVATE_EVENT_TITLE' },
    { text: 'Calendrier consulté avec succès.' },
  ])('refuses invalid or prose-only proof %j', trace => {
    expect(() =>
      finishCalendarTransaction(transaction(), trace as never),
    ).toThrow();
  });

  it('refuses a trace for another scope or contradicting the observed receipt', () => {
    const observed = observing();
    for (const trace of [
      { ...receipt, scope: otherScope },
      { ...receipt, callId: 'calendar-read-2' },
      { ...receipt, returnedCount: 2 },
    ]) {
      expect(() => finishCalendarTransaction(observed, trace)).toThrow();
    }
    expect(observed).toMatchObject({ status: 'observing', receipt });
  });

  it.each(['permission', 'unconfirmed'] as const)(
    'records %s as a safe failure while retaining any completed read evidence',
    error => {
      const failed = interruptCalendarTransaction(observing(), error);
      expect(failed).toMatchObject({ status: 'failed_safe', error, receipt });
      expect(finishCalendarTransaction(failed, receipt)).toEqual(failed);
    },
  );

  it('records interruption as cancelled and preserves any already acquired receipt', () => {
    const cancelled = interruptCalendarTransaction(
      { ...observing(), cancelRequested: true },
      'interrupted',
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      error: 'interrupted',
      receipt,
    });
    expect(finishCalendarTransaction(cancelled, receipt)).toEqual(cancelled);
  });
});
