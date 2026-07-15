/**
 * Structural validation for ingested events. Returns per-event errors with
 * their batch index so operators can fix exactly the failing records; a
 * batch with any invalid event is rejected atomically (400).
 */

import type { MarkerEvent } from '../schema.js';

const EVENT_TYPES = new Set([
  'wager',
  'deposit',
  'withdrawal',
  'session',
  'support_contact',
  'safety_tool',
  'bonus',
]);

export interface ValidationError {
  index: number;
  error: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function payloadError(type: string, p: Record<string, unknown>): string | null {
  switch (type) {
    case 'wager':
      if (typeof p['stakeMinor'] !== 'number' || p['stakeMinor'] < 0) return 'payload.stakeMinor must be a non-negative number';
      if (typeof p['payoutMinor'] !== 'number' || p['payoutMinor'] < 0) return 'payload.payoutMinor must be a non-negative number';
      if (typeof p['currency'] !== 'string') return 'payload.currency must be a string';
      if (typeof p['product'] !== 'string') return 'payload.product must be a string';
      return null;
    case 'deposit':
      if (typeof p['amountMinor'] !== 'number' || p['amountMinor'] < 0) return 'payload.amountMinor must be a non-negative number';
      if (!['succeeded', 'failed', 'declined'].includes(p['status'] as string)) return 'payload.status must be succeeded|failed|declined';
      return null;
    case 'withdrawal':
      if (typeof p['amountMinor'] !== 'number' || p['amountMinor'] < 0) return 'payload.amountMinor must be a non-negative number';
      if (!['requested', 'cancelled_by_player', 'completed', 'rejected'].includes(p['status'] as string))
        return 'payload.status must be requested|cancelled_by_player|completed|rejected';
      if (typeof p['withdrawalId'] !== 'string') return 'payload.withdrawalId must be a string';
      return null;
    case 'session':
      if (!['started', 'ended'].includes(p['status'] as string)) return 'payload.status must be started|ended';
      if (typeof p['sessionId'] !== 'string') return 'payload.sessionId must be a string';
      return null;
    case 'support_contact':
      if (typeof p['channel'] !== 'string') return 'payload.channel must be a string';
      return null;
    case 'safety_tool':
      if (typeof p['tool'] !== 'string') return 'payload.tool must be a string';
      if (typeof p['action'] !== 'string') return 'payload.action must be a string';
      return null;
    case 'bonus':
      if (!['claimed', 'wagering_completed', 'forfeited'].includes(p['action'] as string))
        return 'payload.action must be claimed|wagering_completed|forfeited';
      return null;
    default:
      return `unknown type ${type}`;
  }
}

export function validateEvents(body: unknown): { events: MarkerEvent[]; errors: ValidationError[] } {
  if (!Array.isArray(body)) {
    return { events: [], errors: [{ index: -1, error: 'body must be a JSON array of events' }] };
  }
  const errors: ValidationError[] = [];
  body.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push({ index, error: 'event must be an object' });
      return;
    }
    if (typeof raw['eventId'] !== 'string' || raw['eventId'].length === 0) {
      errors.push({ index, error: 'eventId must be a non-empty string' });
      return;
    }
    if (!EVENT_TYPES.has(raw['type'] as string)) {
      errors.push({ index, error: `type must be one of ${[...EVENT_TYPES].join('|')}` });
      return;
    }
    if (typeof raw['playerId'] !== 'string' || raw['playerId'].length === 0) {
      errors.push({ index, error: 'playerId must be a non-empty string' });
      return;
    }
    if (typeof raw['occurredAt'] !== 'string' || Number.isNaN(Date.parse(raw['occurredAt']))) {
      errors.push({ index, error: 'occurredAt must be an ISO 8601 timestamp' });
      return;
    }
    if (raw['tzOffsetMinutes'] !== null && typeof raw['tzOffsetMinutes'] !== 'number') {
      errors.push({ index, error: 'tzOffsetMinutes must be a number or null' });
      return;
    }
    if (!isRecord(raw['payload'])) {
      errors.push({ index, error: 'payload must be an object' });
      return;
    }
    const pErr = payloadError(raw['type'] as string, raw['payload']);
    if (pErr) errors.push({ index, error: pErr });
  });
  return { events: errors.length === 0 ? (body as MarkerEvent[]) : [], errors };
}
