# MarkerLayer — Event Schema & Marker Specification

**Status:** v0.2 (2026-07-11) — **verified against the full text of SR EN 18144:2025** (identical national adoption of EN 18144:2025, "Online gambling — Markers of harm in support of identification and prevention of risky and problem gambling behaviour", CEN/TC 456, approved 26 Oct 2025).
**Scope:** Deterministic scoring engine implementing the standard's nine markers of harm.

Clause references below (§3.x, §4.x, §5.x) are to EN 18144:2025.

---

## 1. What the standard requires — and how this engine maps to it

- **A minimum set of nine markers** (§5.1–§5.9), each with required time spans and measurements. The engine's `MarkerId`s mirror the clause names and order verbatim: `M1_volume_of_stakes` … `M9_losses` (§2.5 below).
- **Both absolute values and deviations from the player's typical pattern shall be analysed, compared both to the population and to the player themself** (§4.1). → Every marker combines self-baseline z-scores, absolute rule overrides, and (when `populationRef` is configured) a standing population z (`*PopulationZ` features).
- **Markers shall be considered together, not in isolation; explicit methods should be point-based or similar, incorporating the interactions between markers** (§4.2). → The engine ships a point-based composite (`composite` in the output): each marker contributes points by state (elevated = 1, high = 2, per-marker weights configurable) plus explicit interaction terms scored when both members of a documented pair are active (e.g. losses × depositing = chasing, stake escalation × weakened protections). Point values, interactions, and band cut-offs (low < 2 ≤ moderate < 5 ≤ high) are operator policy in `EngineConfig.composite`; the breakdown in `composite.points` sums exactly to the score, and `insufficient_data` markers are listed as `coverageGaps` rather than silently scoring zero.
- **No prescribed thresholds or interventions** (§1, §4.1: any prescribed limit "will inevitably yield false positives"). → All thresholds are `EngineConfig` policy with documented conservative defaults.
- **Jurisdictional omission** (§1): if collecting a marker is legally prohibited, omitting only that marker keeps you compliant. → Per-marker `insufficient_data` with named `missing` inputs; the other eight still compute.
- **Not a medical evaluation** (§1, Introduction, §4.1: "cannot serve as a clinical assessment of gambling disorder"). → No diagnosis language anywhere; output is markers requiring review.
- **Chasing is a cross-cutting dynamic, not a standalone marker** (§4.3). → Chase-deposits and in-session top-ups appear as features inside M2/M3 rather than as a tenth marker.

## 2. Design principles

1. **Deterministic and explainable.** Same events in → same marker values out; every flag carries evidence naming the feature, value, and rule. No ML in the scoring path. (§4.2 permits implicit/ML methods but then requires all markers to be accessible to the model — a transparent explicit method is the stronger audit posture.)
2. **Self-referential baselines + population comparison** per §4.1 (see above).
3. **No clinical claims** (§1).
4. **Data minimisation.** Pseudonymous `playerId` only; no PII anywhere in the schema.
5. **Graceful degradation** per §1's omission rule.
6. **Timezone honesty.** Time-of-day analysis is suppressed, never guessed, when the player-local offset is unknown.

### 2.1 Event schema

Seven event types (`wager`, `deposit`, `withdrawal`, `session`, `support_contact`, `safety_tool`, `bonus`) with a shared envelope (`eventId` idempotency key, pseudonymous `playerId`, UTC `occurredAt`, `tzOffsetMinutes`). Normative definitions in [`src/schema.ts`](./src/schema.ts). Standard-driven details:

- **Deposits** (§3.3 Note 2): `succeeded` = reached the gambling account; `failed`/`declined` = did not. Declined attempts are marker inputs (§5.3.2) and MUST be sent.
- **Withdrawals** (§3.4, §3.10): lifecycle transitions; `cancelled_by_player` feeds M4, `completed` feeds net deposits (§3.11).
- **Sessions** (§3.6): a session is a continuous span of betting where **no 5-minute period passes without a bet**. When the operator does not send session events, the engine derives sessions from wager timestamps with exactly this rule (`sessionGapMinutes: 5` default).
- **Support contacts** (§3.5, §5.5.2): categorized **positive / neutral / negative** (`sentiment`), plus an optional topical category. No free text is ever ingested.
- **Safety tools** (§3.8): for `self_exclusion`, `action: 'set'` is an activation — §5.8.2 requires counting activations over the whole account history.
- **Bonuses** (§5.9.2): claimed bonuses subtract from losses; forfeited/withdrawn bonuses count negatively toward the bonus sum.

### 2.2 Aggregation layer

Raw events reduce to per-player daily aggregates on the player-local calendar. Per §5.6.2 **Method 1**, sessions are split across day boundaries — each minute of a session is attributed to the day it falls in. Per **Method 2**, each day also records the number of one-hour slots containing at least one wager. Raw events can be discarded after aggregation per the configurable retention window.

### 2.3 Baseline machinery

- **Baseline window:** trailing 90 days ending 7 days before `asOf` (the scrutiny week never contaminates its own baseline). Minimum 14 wager-active days; otherwise population fallback (`populationRef`) with `baseline: "population"` in the output.
- **Robust z:** `z = (x − median) / (1.4826 × MAD)` over baseline active days; MAD = 0 falls back deterministically to `max(0.1×|median|, 1)`.
- **Population z** (§4.1): when `populationRef[feature]` is configured, the max scrutiny-day z against the population reference is always reported (`stakePopulationZ`, `depositPopulationZ`, `lossPopulationZ`).
- **Trajectory:** OLS slope over `log(1+x)` of the trailing 28 days, as %/week.
- **State mapping** (operator-configurable): `normal` / `elevated` (z ≥ 1.5, ≥2 of last 7 days) / `high` (z ≥ 2.5, ≥2 of last 7 days, or an absolute override).

### 2.4 The nine markers

Each marker computes the standard's **required measurements over its required time spans** (features named `…Day`, `…Week`, `…Month`, `…90d`, `…180d`), plus characterisation features and flag rules (our policy layer — the standard mandates *what to measure*, not *when to flag*).

| ID | Clause | Required spans | Required measurements (implemented) |
|---|---|---|---|
| `M1_volume_of_stakes` | §5.1 | session, day, week, month, 90d, 180d | cumulative bet amount AND number of stakes |
| `M2_speed_of_play` | §5.2 | session, day, week, month | **mean** inter-bet interval: sum of times-since-previous-stake-in-session ÷ count of stakes with a measured time (first stake of a session has none) |
| `M3_depositing_behaviour` | §5.3 | session, day, week, month, 90d, 180d | successful + declined deposit counts, total amount deposited, deposit methods used, **net deposits** (deposits − withdrawals, §3.11) |
| `M4_cancelled_withdrawals` | §5.4 | day, week, month | count of cancelled withdrawals |
| `M5_player_initiated_contact` | §5.5 | day, week, month | contact counts, categorized positive / neutral / negative |
| `M6_gambling_time` | §5.6 | session, day, week, month | Method 1: session length split across day boundaries; Method 2: one-hour slots with activity per 24h — both computed |
| `M7_gambling_products` | §5.7 | session, day, week, month | number of distinct products per session and per span (product granularity is operator discretion — the `ProductVertical` enum here) |
| `M8_responsible_gambling_tools` | §5.8 | day, week, month | all tool changes counted; increases vs reductions distinguished; self-exclusion counted separately incl. **lifetime activation count** |
| `M9_losses` | §5.9 | session, day, week, month, 90d, 180d | Loss Calculation Method 2: stakes − winnings − bonuses (settled only; forfeited bonuses negative; result may be negative) |

**Flag-rule layer (policy, defaults):** stake ramp ≥50%/week ×2 weeks (M1); ≥3 in-session top-ups twice in 7d, 2× speed-up vs baseline (M2); ≥3 declined or chase deposits in 7d (M3); cancel ratio ≥0.25/0.5, cancel→wager <1h twice (M4); any responsible-gambling contact, ≥3 negative contacts/month (M5); session ≥6h, sustained night play (M6); ≥4 verticals or ≥2 new adoptions (M7); ≥2 limit raises, near-limit weakening, play ≤24h after exclusion ends (M8); 30d losses ≥2× prior norm and rising (M9).

### 2.5 Output shape

All nine markers always present with `state` / `features` / `evidence` / `missing`, plus `attention` (severity-ordered), the §4.2 `composite` (score, band, explainable point breakdown, coverage gaps), and `protectiveSignals`.

### 2.6 Ingestion API

`src/server/` provides a zero-dependency HTTP API: `POST /v1/events` (batched, idempotent by `eventId`, structurally validated with per-index errors), `GET /v1/players`, `GET /v1/players/{id}/markers?asOf=…`, `GET /health`. Auth is `Authorization: Bearer <key>` against configured keys (≥16 chars, sha256 + constant-time comparison). Storage is pluggable (`EventStore`): in-memory, or append-only JSONL replayed at boot — swappable for a database without touching the engine.

## 3. Deviations & implementation notes

- **Loss Method 2 only.** §5.9.2 allows either method if consistent; Method 1 needs account-balance snapshots the event schema deliberately avoids. Unsettled bets are out of scope for v0 (settled wagers assumed).
- **Within-session span variants** (§5.1.1, §5.3.1, §5.9.1 "within individual gambling sessions") are computed where they carry signal (M2 speed, M7 products-per-session, M2 top-ups); per-session stake/deposit/loss tables are a straightforward addition for the reporting layer.
- **Contact sentiment** is operator-supplied (categorical), since the engine never ingests free text.
- **Product granularity** uses the `ProductVertical` enum; §5.7.2 leaves this to the operator.

## 4. References

- SR EN 18144:2025 / EN 18144:2025, CEN/TC 456 (full text; purchased from ASRO)
- Annex A of the standard (informative literature): Braverman & Shaffer 2012; LaBrie & Shaffer 2011; Auer & Griffiths 2022 (chasing); Catania & Griffiths 2021; Delfabbro et al. 2023; Håkansson & Widinghoff 2020; McAuliffe et al. 2022; Wardle et al. 2018
- Ferris & Wynne (2001), *The Canadian Problem Gambling Index* (PGSI) — the questionnaire-based instrument referenced throughout the markers-of-harm literature
