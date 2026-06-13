import type { PieceColor } from './types';

/** Time-control presets offered in the menu (seconds per player; 0 = off). */
export const TIME_CONTROLS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '3 min', seconds: 180 },
  { label: '5 min', seconds: 300 },
  { label: '10 min', seconds: 600 },
  { label: '15 min', seconds: 900 },
  { label: '30 min', seconds: 1800 },
];

/**
 * A two-sided chess clock. Pure timekeeping: the host (Game) decides each
 * frame which side's clock is running and feeds elapsed milliseconds via
 * {@link tick}; the clock counts that side down and reports the first side to
 * flag (hit zero). For online play the remaining times are periodically
 * re-synced from the authoritative server with {@link setRemaining}.
 */
export class ChessClock {
  /** Disabled clocks never run and render as blank. */
  enabled = false;

  private baseMs = 0;
  private readonly remaining: Record<PieceColor, number> = { white: 0, black: 0 };
  private flagged: PieceColor | null = null;

  /** Per-player base time in seconds (0 = disabled). */
  get baseSeconds(): number {
    return Math.round(this.baseMs / 1000);
  }

  /** Configure the per-player base time (seconds) and reset both clocks. */
  configure(seconds: number): void {
    this.baseMs = Math.max(0, seconds) * 1000;
    this.enabled = this.baseMs > 0;
    this.reset();
  }

  reset(): void {
    this.remaining.white = this.baseMs;
    this.remaining.black = this.baseMs;
    this.flagged = null;
  }

  /** Overwrite remaining times (authoritative resync from the server). */
  setRemaining(white: number, black: number): void {
    this.remaining.white = Math.max(0, white);
    this.remaining.black = Math.max(0, black);
    if (this.remaining.white > 0 && this.remaining.black > 0) this.flagged = null;
  }

  remainingMs(color: PieceColor): number {
    return this.remaining[color];
  }

  flaggedColor(): PieceColor | null {
    return this.flagged;
  }

  /**
   * Advance the running side's clock by `deltaMs`. Pass `null` when no clock
   * should run (paused, warm-up, game over). Returns the color that just ran
   * out of time on this tick, or null.
   */
  tick(running: PieceColor | null, deltaMs: number): PieceColor | null {
    if (!this.enabled || running === null || this.flagged) return null;
    const next = this.remaining[running] - deltaMs;
    this.remaining[running] = Math.max(0, next);
    if (next <= 0) {
      this.flagged = running;
      return running;
    }
    return null;
  }

  /** mm:ss, dropping to a tenths display under ten seconds for tension. */
  format(color: PieceColor): string {
    if (!this.enabled) return '';
    const ms = Math.max(0, this.remaining[color]);
    if (ms < 10_000) {
      return (ms / 1000).toFixed(1);
    }
    const total = Math.ceil(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}
