import type { PresencePayload } from './protocol.js';

const SQUARE_RE = /^[a-h][1-8]$/;

/** Board world coordinates stay well within this radius. */
const MAX_COORD = 50;

/**
 * Validates an untrusted presence payload and rebuilds it field by field, so
 * nothing beyond the known shape is ever relayed to the opponent. Returns
 * null for anything malformed (the message is then silently dropped).
 */
export function sanitizePresence(raw: unknown): PresencePayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { possessed, pos } = raw as { possessed?: unknown; pos?: unknown };

  if (typeof possessed !== 'string' || !SQUARE_RE.test(possessed)) return null;
  if (pos === undefined || pos === null) return { possessed };

  if (typeof pos !== 'object') return null;
  const { x, z } = pos as { x?: unknown; z?: unknown };
  if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > MAX_COORD) return null;
  if (typeof z !== 'number' || !Number.isFinite(z) || Math.abs(z) > MAX_COORD) return null;

  return { possessed, pos: { x, z } };
}
