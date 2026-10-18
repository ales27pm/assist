import {
  CalendarAgentTrace,
  boundedIdentifier,
  validAgentTrace,
  validCalendarScope,
} from './protocol';

/** Metadata only. Never accepts model text, event titles, or raw arguments. */
export type CalendarActivity = {
  schemaVersion: 1;
  requestId: string;
  sequence: 1 | 2 | 3;
  phase: 'planning' | 'executing' | 'observing';
  scope: CalendarAgentTrace['scope'];
  receipt?: CalendarAgentTrace;
};

export type CalendarToolTransaction = {
  id: string;
  status:
    | 'proposed'
    | 'executing'
    | 'observing'
    | 'success'
    | 'failed_safe'
    | 'cancelled';
  scope?: CalendarAgentTrace['scope'];
  receipt?: CalendarAgentTrace;
  error?: 'permission' | 'interrupted' | 'unconfirmed';
  cancelRequested?: boolean;
  lastSequence?: number;
};

function sameScope(
  left: CalendarAgentTrace['scope'],
  right: CalendarAgentTrace['scope'],
) {
  return (
    left.startISO === right.startISO &&
    left.endISO === right.endISO &&
    left.timeZoneIdentifier === right.timeZoneIdentifier
  );
}

function sameReceipt(left: CalendarAgentTrace, right: CalendarAgentTrace) {
  return (
    left.callId === right.callId &&
    sameScope(left.scope, right.scope) &&
    left.returnedCount === right.returnedCount &&
    left.possiblyTruncated === right.possiblyTruncated
  );
}

export function parseCalendarActivity(json: string): CalendarActivity {
  if (typeof json !== 'string' || json.length > 4096)
    throw new Error('Activité calendrier invalide.');
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Activité calendrier invalide.');
  const item = value as Record<string, unknown>;
  const phases = ['planning', 'executing', 'observing'];
  const keys = ['schemaVersion', 'requestId', 'sequence', 'phase', 'scope'];
  if (item.phase === 'observing') keys.push('receipt');
  if (
    Object.keys(item).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(item, key)) ||
    item.schemaVersion !== 1 ||
    !boundedIdentifier(item.requestId) ||
    typeof item.sequence !== 'number' ||
    !Number.isInteger(item.sequence) ||
    item.sequence < 1 ||
    item.sequence > 3 ||
    phases[item.sequence - 1] !== item.phase ||
    !validCalendarScope(item.scope) ||
    (item.phase === 'observing' &&
      (!validAgentTrace(item.receipt) ||
        !sameScope(item.scope, item.receipt.scope)))
  )
    throw new Error('Activité calendrier invalide.');
  return item as CalendarActivity;
}

function terminal(transaction: CalendarToolTransaction) {
  return ['success', 'failed_safe', 'cancelled'].includes(transaction.status);
}

export function reduceCalendarActivity(
  transaction: CalendarToolTransaction,
  event: CalendarActivity,
): CalendarToolTransaction {
  if (
    transaction.id !== event.requestId ||
    terminal(transaction) ||
    transaction.cancelRequested ||
    event.sequence !== (transaction.lastSequence ?? 0) + 1 ||
    transaction.status !== (event.sequence === 3 ? 'executing' : 'proposed') ||
    (transaction.scope && !sameScope(transaction.scope, event.scope))
  )
    return transaction;
  return {
    ...transaction,
    lastSequence: event.sequence,
    scope: event.scope,
    status: event.phase === 'planning' ? 'proposed' : event.phase,
    ...(event.receipt ? { receipt: event.receipt } : {}),
  };
}

/** Only a validated native trace can confirm a read; EOS prose cannot. */
export function finishCalendarTransaction(
  transaction: CalendarToolTransaction,
  trace: CalendarAgentTrace | null | undefined,
): CalendarToolTransaction {
  if (terminal(transaction) || transaction.cancelRequested) return transaction;
  if (
    trace != null &&
    (!validAgentTrace(trace) ||
      (transaction.scope && !sameScope(transaction.scope, trace.scope)) ||
      (transaction.receipt && !sameReceipt(transaction.receipt, trace)))
  )
    throw new Error('Reçu calendrier incohérent.');
  if (
    !trace &&
    (transaction.receipt ||
      transaction.status === 'executing' ||
      transaction.status === 'observing' ||
      (transaction.lastSequence ?? 0) >= 2)
  )
    throw new Error('Reçu calendrier absent de la réponse finale.');
  return trace
    ? { ...transaction, status: 'success', scope: trace.scope, receipt: trace }
    : { ...transaction, status: 'cancelled' };
}

export function interruptCalendarTransaction(
  transaction: CalendarToolTransaction,
  error: NonNullable<CalendarToolTransaction['error']>,
): CalendarToolTransaction {
  if (terminal(transaction)) return transaction;
  return {
    ...transaction,
    status: error === 'interrupted' ? 'cancelled' : 'failed_safe',
    error,
    cancelRequested: false,
  };
}
