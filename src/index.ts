export * from './schema.js';
export { DEFAULT_CONFIG, DEFAULT_THRESHOLDS, resolveConfig } from './config.js';
export { DEFAULT_COMPOSITE, computeComposite, resolveComposite } from './composite.js';
export { computeMarkers, computePlayerMarkers, type ComputeOptions } from './engine.js';
export { createServer, type ServerOptions } from './server/server.js';
export { JsonlStore, MemoryStore, type EventStore, type IngestResult } from './server/store.js';
export { validateEvents, type ValidationError } from './server/validate.js';
export {
  buildHistory,
  deriveSessions,
  normalizeEvents,
  type DayAgg,
  type PlayerHistory,
  type SessionInterval,
} from './history.js';
export { median, mad, robustZ, robustStats, olsSlope, trajectoryPctPerWeek, shannonEntropy } from './stats.js';
