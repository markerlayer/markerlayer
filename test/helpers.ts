/** Deterministic synthetic event builders for tests. No randomness. */

import type {
  DepositEvent,
  MarkerEvent,
  ProductVertical,
  SafetyToolEvent,
  SessionEvent,
  SupportContactEvent,
  WagerEvent,
  WithdrawalEvent,
} from '../src/schema.js';

export const AS_OF = '2026-07-10T00:00:00.000Z';
export const AS_OF_MS = Date.parse(AS_OF);
export const DAY_MS = 86_400_000;
export const PLAYER = 'p1';

let counter = 0;
export function nextId(): string {
  counter += 1;
  return `evt-${counter}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Timestamp `daysAgo` days before AS_OF, at `minuteOfDay` (UTC). */
export function at(daysAgo: number, minuteOfDay: number): number {
  return AS_OF_MS - daysAgo * DAY_MS + minuteOfDay * 60_000;
}

export function wager(
  ms: number,
  stakeMinor: number,
  payoutMinor: number,
  opts: { product?: ProductVertical; tz?: number | null; sessionId?: string; playerId?: string } = {},
): WagerEvent {
  return {
    eventId: nextId(),
    type: 'wager',
    playerId: opts.playerId ?? PLAYER,
    occurredAt: iso(ms),
    tzOffsetMinutes: opts.tz === undefined ? 0 : opts.tz,
    payload: {
      stakeMinor,
      currency: 'RON',
      payoutMinor,
      product: opts.product ?? 'slots',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    },
  };
}

export function deposit(
  ms: number,
  amountMinor: number,
  status: DepositEvent['payload']['status'] = 'succeeded',
): DepositEvent {
  return {
    eventId: nextId(),
    type: 'deposit',
    playerId: PLAYER,
    occurredAt: iso(ms),
    tzOffsetMinutes: 0,
    payload: { amountMinor, currency: 'RON', status },
  };
}

export function withdrawal(
  ms: number,
  status: WithdrawalEvent['payload']['status'],
  withdrawalId: string,
  amountMinor = 50_000,
): WithdrawalEvent {
  return {
    eventId: nextId(),
    type: 'withdrawal',
    playerId: PLAYER,
    occurredAt: iso(ms),
    tzOffsetMinutes: 0,
    payload: { amountMinor, currency: 'RON', status, withdrawalId },
  };
}

export function contact(
  ms: number,
  category?: SupportContactEvent['payload']['category'],
): SupportContactEvent {
  return {
    eventId: nextId(),
    type: 'support_contact',
    playerId: PLAYER,
    occurredAt: iso(ms),
    tzOffsetMinutes: 0,
    payload: { channel: 'chat', ...(category ? { category } : {}) },
  };
}

export function safetyTool(
  ms: number,
  tool: SafetyToolEvent['payload']['tool'],
  action: SafetyToolEvent['payload']['action'],
  valueMinor?: number,
): SafetyToolEvent {
  return {
    eventId: nextId(),
    type: 'safety_tool',
    playerId: PLAYER,
    occurredAt: iso(ms),
    tzOffsetMinutes: 0,
    payload: { tool, action, ...(valueMinor !== undefined ? { valueMinor } : {}) },
  };
}

export function sessionEvent(ms: number, status: 'started' | 'ended', sessionId: string): SessionEvent {
  return {
    eventId: nextId(),
    type: 'session',
    playerId: PLAYER,
    occurredAt: iso(ms),
    tzOffsetMinutes: 0,
    payload: { status, sessionId },
  };
}

/**
 * A steady, unremarkable player: for each of `days` days ending `endDaysAgo`
 * days ago, one 20-wager midday session (stake 1000, payout 1000 → net 0)
 * and one succeeded deposit two hours before the session.
 */
export function steadyDays(days: number, endDaysAgo = 0, stakeMinor = 1000): MarkerEvent[] {
  const events: MarkerEvent[] = [];
  for (let d = endDaysAgo + days; d > endDaysAgo; d--) {
    events.push(deposit(at(d, 10 * 60), 20_000));
    for (let i = 0; i < 20; i++) {
      events.push(wager(at(d, 12 * 60 + i), stakeMinor, stakeMinor));
    }
  }
  return events;
}
