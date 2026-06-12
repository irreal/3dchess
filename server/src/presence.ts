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
  const { possessed, pos, duck, jumps, yaw, pitch } = raw as {
    possessed?: unknown;
    pos?: unknown;
    duck?: unknown;
    jumps?: unknown;
    yaw?: unknown;
    pitch?: unknown;
  };

  if (typeof possessed !== 'string' || !SQUARE_RE.test(possessed)) return null;
  if (duck !== undefined && typeof duck !== 'boolean') return null;
  if (
    jumps !== undefined &&
    (typeof jumps !== 'number' || !Number.isInteger(jumps) || jumps < 0 || jumps > 1e9)
  ) {
    return null;
  }
  // Yaw is radians; anything within one wrap is fine.
  if (yaw !== undefined && (typeof yaw !== 'number' || !Number.isFinite(yaw) || Math.abs(yaw) > 7)) {
    return null;
  }
  // Pitch is radians; clamp to a sane look range.
  if (
    pitch !== undefined &&
    (typeof pitch !== 'number' || !Number.isFinite(pitch) || Math.abs(pitch) > 2)
  ) {
    return null;
  }

  const clean: PresencePayload = { possessed };
  if (duck === true) clean.duck = true;
  if (typeof jumps === 'number' && jumps > 0) clean.jumps = jumps;
  if (typeof yaw === 'number') clean.yaw = yaw;
  if (typeof pitch === 'number') clean.pitch = pitch;

  if (pos === undefined || pos === null) return clean;

  if (typeof pos !== 'object') return null;
  const { x, z } = pos as { x?: unknown; z?: unknown };
  if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > MAX_COORD) return null;
  if (typeof z !== 'number' || !Number.isFinite(z) || Math.abs(z) > MAX_COORD) return null;

  clean.pos = { x, z };
  return clean;
}
