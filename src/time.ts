/** Time helpers. All arithmetic is on epoch milliseconds; "local" means
 * player-local via the event's tzOffsetMinutes. */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO timestamp: ${iso}`);
  return ms;
}

/** Player-local day key (YYYY-MM-DD). Falls back to UTC when offset is null. */
export function dayKey(utcMs: number, tzOffsetMinutes: number | null): string {
  const localMs = utcMs + (tzOffsetMinutes ?? 0) * MINUTE_MS;
  return new Date(localMs).toISOString().slice(0, 10);
}

/** Player-local hour of day [0, 24). Null when offset is unknown. */
export function localHour(utcMs: number, tzOffsetMinutes: number | null): number | null {
  if (tzOffsetMinutes === null) return null;
  const localMs = utcMs + tzOffsetMinutes * MINUTE_MS;
  return new Date(localMs).getUTCHours() + new Date(localMs).getUTCMinutes() / 60;
}

/** Enumerate day keys (UTC-based grid) covering [fromMs, toMs). */
export function dayKeysBetween(fromMs: number, toMs: number): string[] {
  const keys: string[] = [];
  let cursor = fromMs - (fromMs % DAY_MS);
  while (cursor < toMs) {
    keys.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return keys;
}

/**
 * Minutes of [startMs, endMs) that fall inside the nightly window
 * [nightStartHour, nightEndHour) in player-local time.
 */
export function nightMinutes(
  startMs: number,
  endMs: number,
  tzOffsetMinutes: number | null,
  nightHours: [number, number],
): number | null {
  if (tzOffsetMinutes === null) return null;
  const [nightStart, nightEnd] = nightHours;
  let total = 0;
  // Walk in minute steps only across at most a few days per session; sessions
  // are bounded in practice, but cap the walk defensively at 48h.
  const cappedEnd = Math.min(endMs, startMs + 48 * HOUR_MS);
  for (let t = startMs; t < cappedEnd; t += MINUTE_MS) {
    const h = localHour(t, tzOffsetMinutes);
    if (h !== null && h >= nightStart && h < nightEnd) total += 1;
  }
  return total;
}
