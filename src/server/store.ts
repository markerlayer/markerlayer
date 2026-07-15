/**
 * Event storage for the ingestion API. Pluggable: the in-memory store backs
 * tests and evaluation; the JSONL store gives durable, append-only,
 * human-auditable persistence without a database dependency.
 *
 * Both stores dedupe by eventId (idempotent ingestion) and hold a per-player
 * index in memory — right-sized for pilots, swappable for Postgres later.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarkerEvent } from '../schema.js';

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

export interface EventStore {
  ingest(events: MarkerEvent[]): IngestResult;
  eventsFor(playerId: string): MarkerEvent[];
  playerIds(): string[];
}

export class MemoryStore implements EventStore {
  protected byPlayer = new Map<string, MarkerEvent[]>();
  protected seen = new Set<string>();

  ingest(events: MarkerEvent[]): IngestResult {
    let accepted = 0;
    let duplicates = 0;
    for (const e of events) {
      if (this.seen.has(e.eventId)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(e.eventId);
      const list = this.byPlayer.get(e.playerId) ?? [];
      list.push(e);
      this.byPlayer.set(e.playerId, list);
      this.persist(e);
      accepted += 1;
    }
    return { accepted, duplicates };
  }

  eventsFor(playerId: string): MarkerEvent[] {
    return this.byPlayer.get(playerId) ?? [];
  }

  playerIds(): string[] {
    return [...this.byPlayer.keys()].sort();
  }

  protected persist(_event: MarkerEvent): void {
    // MemoryStore keeps nothing beyond process lifetime.
  }
}

/** Append-only JSONL persistence; the full log is replayed at construction. */
export class JsonlStore extends MemoryStore {
  private readonly file: string;

  constructor(dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'events.jsonl');
    if (existsSync(this.file)) {
      const lines = readFileSync(this.file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as MarkerEvent;
        if (this.seen.has(event.eventId)) continue;
        this.seen.add(event.eventId);
        const list = this.byPlayer.get(event.playerId) ?? [];
        list.push(event);
        this.byPlayer.set(event.playerId, list);
      }
    }
  }

  protected override persist(event: MarkerEvent): void {
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
