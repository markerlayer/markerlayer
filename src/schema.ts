/**
 * MarkerLayer — event schema & marker output types.
 * Verified against the full text of SR EN 18144:2025 — see SPEC.md for the
 * clause-by-clause mapping.
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type EventType =
  | 'wager'
  | 'deposit'
  | 'withdrawal'
  | 'session'
  | 'support_contact'
  | 'safety_tool'
  | 'bonus';

export interface EventEnvelope<T extends EventType, P> {
  /** Idempotency key (UUID). Duplicate eventIds are discarded. */
  eventId: string;
  type: T;
  /** Operator-side pseudonymous ID. Never PII. */
  playerId: string;
  /** When the behaviour occurred, ISO 8601 UTC (not send time). */
  occurredAt: string;
  /**
   * Player-local UTC offset in minutes at event time (Bucharest DST = 180).
   * null ⇒ time-of-day analysis (M6) is suppressed for this event.
   */
  tzOffsetMinutes: number | null;
  payload: P;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** ISO 4217 code, amounts in minor units (RON bani, EUR cents). */
export type CurrencyCode = string;

export type ProductVertical =
  | 'slots'
  | 'casino_table'
  | 'live_casino'
  | 'sports_prematch'
  | 'sports_live'
  | 'poker'
  | 'bingo'
  | 'lottery'
  | 'other';

export interface WagerPayload {
  stakeMinor: number;
  currency: CurrencyCode;
  /** 0 for a loss. v0 assumes settled wagers. */
  payoutMinor: number;
  product: ProductVertical;
  gameId?: string;
  /** Strongly recommended; enables session-native intensity features. */
  sessionId?: string;
}

export type DepositStatus = 'succeeded' | 'failed' | 'declined';

export interface DepositPayload {
  amountMinor: number;
  currency: CurrencyCode;
  /** failed/declined attempts MUST be sent — they are a marker input (M3). */
  status: DepositStatus;
  methodClass?: 'card' | 'bank' | 'wallet' | 'voucher' | 'crypto' | 'other';
}

export type WithdrawalStatus =
  | 'requested'
  | 'cancelled_by_player'
  | 'completed'
  | 'rejected';

export interface WithdrawalPayload {
  amountMinor: number;
  currency: CurrencyCode;
  status: WithdrawalStatus;
  /** Links lifecycle transitions of one withdrawal. */
  withdrawalId: string;
}

export interface SessionPayload {
  status: 'started' | 'ended';
  sessionId: string;
}

export interface SupportContactPayload {
  channel: 'chat' | 'email' | 'phone' | 'other';
  /**
   * EN 18144 §5.5.2 requires categorization so that contacts "do not fall
   * into the same category, i.e. positive, neutral and negative".
   */
  sentiment?: 'positive' | 'neutral' | 'negative';
  /** Optional topical category. Categorical only — free text is never ingested. */
  category?:
    | 'payments'
    | 'bonuses'
    | 'responsible_gambling'
    | 'complaint'
    | 'account'
    | 'other';
}

export type SafetyTool =
  | 'deposit_limit'
  | 'loss_limit'
  | 'wager_limit'
  | 'session_limit'
  | 'reality_check'
  | 'time_out'
  | 'self_exclusion';

export type SafetyToolAction =
  | 'set'
  | 'lowered'
  | 'raised'
  | 'removed'
  | 'expired'
  | 'revoked';

export interface SafetyToolPayload {
  tool: SafetyTool;
  /**
   * For self_exclusion, 'set' means an activation — EN 18144 §5.8.2 requires
   * counting self-exclusion activations over the whole account history.
   */
  action: SafetyToolAction;
  /** For monetary limits. */
  valueMinor?: number;
  /** For time-based tools. */
  valueMinutes?: number;
}

export interface BonusPayload {
  action: 'claimed' | 'wagering_completed' | 'forfeited';
  amountMinor?: number;
}

export type WagerEvent = EventEnvelope<'wager', WagerPayload>;
export type DepositEvent = EventEnvelope<'deposit', DepositPayload>;
export type WithdrawalEvent = EventEnvelope<'withdrawal', WithdrawalPayload>;
export type SessionEvent = EventEnvelope<'session', SessionPayload>;
export type SupportContactEvent = EventEnvelope<'support_contact', SupportContactPayload>;
export type SafetyToolEvent = EventEnvelope<'safety_tool', SafetyToolPayload>;
export type BonusEvent = EventEnvelope<'bonus', BonusPayload>;

export type MarkerEvent =
  | WagerEvent
  | DepositEvent
  | WithdrawalEvent
  | SessionEvent
  | SupportContactEvent
  | SafetyToolEvent
  | BonusEvent;

// ---------------------------------------------------------------------------
// Marker outputs
// ---------------------------------------------------------------------------

/**
 * Stable marker identifiers, mirroring EN 18144:2025 clause 5 names and
 * order verbatim (M1 ↔ §5.1 … M9 ↔ §5.9).
 */
export type MarkerId =
  | 'M1_volume_of_stakes'
  | 'M2_speed_of_play'
  | 'M3_depositing_behaviour'
  | 'M4_cancelled_withdrawals'
  | 'M5_player_initiated_contact'
  | 'M6_gambling_time'
  | 'M7_gambling_products'
  | 'M8_responsible_gambling_tools'
  | 'M9_losses';

export type MarkerState = 'normal' | 'elevated' | 'high' | 'insufficient_data';

export interface MarkerResult {
  state: MarkerState;
  /** Named features per SPEC.md §3 — stable API surface. */
  features: Record<string, number | null>;
  /**
   * Explainability contract: every non-normal state names the exact
   * feature, value, and rule that produced it.
   */
  evidence: string[];
  /** Present only when state === 'insufficient_data'. */
  missing?: string[];
}

/** One scored contribution to the composite (marker state or interaction). */
export interface CompositePoint {
  /** e.g. "M9_losses: high" or "interaction: losses × depositing". */
  source: string;
  points: number;
}

/**
 * Point-based composite per EN 18144 §4.2: markers considered together,
 * with explicit interaction terms between them. The score is behavioural
 * review pressure — not a clinical measure, and the bands are operator
 * policy (CompositeConfig), not prescribed thresholds.
 */
export interface CompositeResult {
  score: number;
  band: 'low' | 'moderate' | 'high';
  /** Full explainable breakdown; sums to score. */
  points: CompositePoint[];
  /** Markers that reported insufficient_data — visible coverage gaps. */
  coverageGaps: MarkerId[];
}

export interface CompositeInteraction {
  /** Both markers must be ≥ elevated for the interaction to score. */
  markers: [MarkerId, MarkerId];
  points: number;
  label: string;
}

export interface CompositeConfig {
  /** Points contributed by a marker in each state (normal contributes 0). */
  statePoints: { elevated: number; high: number };
  /** Per-marker weight multipliers (default 1). */
  markerWeights?: Partial<Record<MarkerId, number>>;
  /** Interaction terms per §4.2 — scored when both markers are ≥ elevated. */
  interactions: CompositeInteraction[];
  /** Band cut-offs: score ≥ moderate → 'moderate', ≥ high → 'high'. */
  bands: { moderate: number; high: number };
}

export interface PlayerMarkers {
  playerId: string;
  computedAt: string;
  windowDays: number;
  /** 'population' during cold start (< 14 active baseline days). */
  baseline: 'self' | 'population';
  /** All nine markers are always present — gaps are visible, never silent. */
  markers: Record<MarkerId, MarkerResult>;
  /** MarkerIds with state ≥ elevated, ordered by severity. */
  attention: MarkerId[];
  /** Point-based composite per EN 18144 §4.2. */
  composite: CompositeResult;
  /** e.g. "M8: deposit_limit set 2026-07-03" — reported, never risk-scored. */
  protectiveSignals: string[];
}

// ---------------------------------------------------------------------------
// Configuration (operator policy, not science) — defaults per SPEC.md
// ---------------------------------------------------------------------------

export interface MarkerThresholds {
  elevatedZ: number;        // 1.5
  highZ: number;            // 2.5
  sustainedDays: number;    // 2 of last 7
  /** Per-marker overrides, keyed by feature name (SPEC.md §3 flag rules). */
  overrides?: Record<string, number>;
}

export interface EngineConfig {
  baselineDays: number;          // 90, ending 7 days before scrutiny window
  scrutinyDays: number;          // 7
  trajectoryDays: number;        // 28
  minBaselineActiveDays: number; // 14 — below this, population fallback
  sessionGapMinutes: number;     // 5 — per EN 18144 §3.6 session definition
  nightHours: [number, number];  // [0, 6] player-local
  thresholds: Partial<Record<MarkerId, MarkerThresholds>>;
  /** Overrides for the §4.2 point-based composite (see DEFAULT_COMPOSITE). */
  composite?: Partial<CompositeConfig>;
  /**
   * Cold-start population baselines keyed by feature name
   * (e.g. "dailyStakeMinor"). Used when a player has fewer than
   * minBaselineActiveDays of history.
   */
  populationRef?: Record<string, { median: number; mad: number }>;
  /** Raw-event TTL after aggregation (data minimisation). */
  retentionDays: number;         // e.g. 35
}
