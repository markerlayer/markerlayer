# MarkerLayer

[![npm](https://img.shields.io/npm/v/markerlayer)](https://www.npmjs.com/package/markerlayer)
[![license](https://img.shields.io/badge/license-MIT-16655A)](./LICENSE)
[![standard](https://img.shields.io/badge/EN%2018144%3A2025-clause--mapped-14212B)](./SPEC.md)

**The player-protection layer for your gambling platform** — a deterministic
reference implementation of the **EN 18144:2025** behavioural markers of
harm, verified against the full standard text (SR EN 18144:2025, CEN/TC 456).
Self-host the open-source engine, or send your events to the managed cloud.

A **[Duomind](https://duomind.eu)** product · [markerlayer.com](https://markerlayer.com)

![MarkerLayer Cloud console on the synthetic demo dataset](docs/dashboard.png)
*The demo console (`demo/dashboard.html`) on a deterministic synthetic
operator — 78 players, 74k events, scored by this engine. Run
`npx tsx demo/generate.ts` to reproduce it.*

Operators send seven kinds of behavioural events they already have (wagers,
deposits, withdrawals, sessions, support contacts, safety-tool changes,
bonuses); the engine returns the nine standardized markers per player, each
with named features, an attention state, and plain-language evidence for every
flag.

```
events in ──► daily aggregates ──► robust self-baselines ──► 9 markers out
             (median/MAD z-scores, 90-day baseline, 7-day scrutiny window)
```

## Why this design

- **Deterministic & explainable.** Same events in → same markers out. Every
  non-normal state carries evidence naming the exact feature, value, and rule
  (`"declinedDepositCountWeek=4 ≥ 3"`). No ML in the scoring path — this is
  what makes the output auditable by a regulator.
- **Self-referential baselines.** Markers compare a player's recent behaviour
  against their own 90-day history (robust median/MAD z-scores), because the
  research shows *change and trajectory* predict harm better than absolute
  thresholds. New players fall back to configurable population references.
- **Composite = review pressure, not diagnosis.** Per §4.2 the markers are
  considered together in a point-based composite with explicit interaction
  terms (losses × depositing, escalation × weakened protections, …). The
  breakdown always sums to the score, coverage gaps are listed, and bands
  are operator policy — an identification aid, never a clinical measure.
- **No PII.** Pseudonymous player IDs, amounts in minor units, categorical
  fields only. Nothing in the schema can identify a person.

## Quick start

```bash
npm install
npm test
```

```ts
import { computePlayerMarkers } from 'markerlayer';

const result = computePlayerMarkers(events, 'player-123', {
  asOf: '2026-07-10T00:00:00Z',
});

console.log(result.attention);
// e.g. ['M3_depositing_behaviour', 'M1_volume_of_stakes']
console.log(result.markers.M3_depositing_behaviour.evidence);
// ['declinedDepositCountWeek=3 ≥ 3']
console.log(result.composite);
// { score: 6, band: 'high', points: [...], coverageGaps: [...] }
```

Run the demo (a synthetic escalating player):

```bash
npx tsx examples/demo.ts
```

Run the ingestion API (auth required; storage is append-only JSONL):

```bash
MARKERLAYER_API_KEYS=your-key-min-16-chars npm run serve

curl -X POST localhost:3200/v1/events \
  -H "Authorization: Bearer your-key-min-16-chars" \
  -H "content-type: application/json" -d @events.json

curl "localhost:3200/v1/players/op-4711/markers" \
  -H "Authorization: Bearer your-key-min-16-chars"
```

Or with Docker (persists events in the `markers-data` volume):

```bash
docker build -t markerlayer .
docker run -p 3200:3200 -v markers-data:/data \
  -e MARKERLAYER_API_KEYS=your-key-min-16-chars markerlayer
```

The API is described in [`openapi.yaml`](./openapi.yaml) (OpenAPI 3.1,
validated) — import it into Postman/Insomnia or hand it to an integrating
operator as the contract.

## The nine markers (EN 18144:2025 §5.1–§5.9)

| ID | Standard clause | Key absolute rules (defaults) |
|---|---|---|
| M1 Volume of Stakes | §5.1 | stake trajectory ≥ 50%/week, 2 weeks |
| M2 Speed of Play | §5.2 | ≥3 in-session top-ups twice in 7d; 2× speed-up |
| M3 Depositing Behaviour | §5.3 | ≥3 declined or chase deposits in 7d |
| M4 Cancelled Withdrawals | §5.4 | cancel ratio ≥ 0.25 / cancel→wager <1h twice |
| M5 Player Initiated Contact | §5.5 | any responsible-gambling contact |
| M6 Gambling Time | §5.6 | session ≥ 6h; sustained night play |
| M7 Gambling Products | §5.7 | ≥4 verticals or ≥2 new adoptions |
| M8 Responsible Gambling Tools | §5.8 | play ≤24h after exclusion ends; near-limit weakening |
| M9 Losses | §5.9 | 30d losses ≥2× prior norm and rising |

Each marker computes the standard's required measurements over its required
time spans (day/week/month, plus 90/180 days for stakes, deposits, and
losses); sessions follow the §3.6 definition (a 5-minute gap without a bet
ends the session) and gambling time follows both §5.6.2 methods (day-split
session minutes + hour slots with activity).

Everything else is robust z-scores against the player's own baseline, sustained
over ≥2 of the last 7 days. All thresholds are operator policy configuration
(`EngineConfig`), shipped with documented conservative defaults — they are not
clinical claims.

Full specification: [SPEC.md](./SPEC.md).

## Status & caveats

- Marker names, measurements, time spans, and the session definition are
  **verified against the full text of SR EN 18144:2025** (see SPEC.md §1 for
  the requirement-by-requirement mapping and §3 for documented deviations).
- Flag thresholds remain operator policy: the standard deliberately
  prescribes no trigger points or interventions (§1) and notes any prescribed
  limit yields false positives (§4.1).
- Single-currency per player is assumed (amounts are summed in minor units).
- Losses use §5.9.2 Method 2 (stakes − winnings − bonuses, settled bets only).
- This library identifies patterns; deciding **interventions** is the
  operator's regulated responsibility. Nothing here diagnoses or screens for
  gambling disorder — the standard itself states it "cannot serve as a
  clinical assessment of gambling disorder" (§4.1).

## License

MIT
