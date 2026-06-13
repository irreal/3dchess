import { Chess } from 'chess.js';
import { randomBytes } from 'node:crypto';
import type { AppliedMove, Color, GameSnapshot, GameStatus, MovePayload } from './protocol.js';

/** Expected failure (illegal move, wrong turn, full game...) safe to show to clients. */
export class GameError extends Error {}

function opposite(color: Color): Color {
  return color === 'white' ? 'black' : 'white';
}

/**
 * One chess game. The server is the single source of truth: the position
 * lives here, and every move must pass through {@link applyMove}, which
 * enforces that both players are seated, the game is still running, it is
 * the caller's turn, and chess.js accepts the move as legal. Clients only
 * ever hold a secret token that maps to their seat.
 */
export class GameRoom {
  private readonly chess = new Chess();
  private readonly tokens: Partial<Record<Color, string>> = {};
  /** Warm-up gate: chess moves are rejected until both players are ready. */
  private readonly ready: Record<Color, boolean> = { white: false, black: false };
  private resignedBy: Color | null = null;

  /** Authoritative clock: per-player remaining ms and when the running side's
   * turn began (null while paused — warm-up, game over). 0 base = no clock. */
  private readonly baseMs: number;
  private readonly remaining: Record<Color, number>;
  private turnStartedAt: number | null = null;
  private timedOutBy: Color | null = null;

  lastActivity = Date.now();

  constructor(
    readonly code: string,
    timeControlSeconds = 0,
  ) {
    this.baseMs = Math.max(0, Math.floor(timeControlSeconds)) * 1000;
    this.remaining = { white: this.baseMs, black: this.baseMs };
  }

  private get clockEnabled(): boolean {
    return this.baseMs > 0;
  }

  /** Claims a free seat and returns the secret token identifying it. */
  join(preferred?: Color): { token: string; color: Color } {
    const color = this.pickColor(preferred);
    if (!color) throw new GameError('Game is full');
    const token = randomBytes(24).toString('base64url');
    this.tokens[color] = token;
    this.touch();
    return { token, color };
  }

  private pickColor(preferred?: Color): Color | null {
    if (preferred && !this.tokens[preferred]) return preferred;
    if (!this.tokens.white) return 'white';
    if (!this.tokens.black) return 'black';
    return null;
  }

  /** Resolves a token to the seat it belongs to, or null for strangers. */
  colorOf(token: string): Color | null {
    if (token && this.tokens.white === token) return 'white';
    if (token && this.tokens.black === token) return 'black';
    return null;
  }

  /**
   * Marks a seat as ready to leave the free-roam warm-up. One-way: once the
   * chess game has started there is no way back to the warm-up.
   */
  markReady(color: Color): void {
    this.ready[color] = true;
    // The chess game (and the clock) begins the instant both seats are ready.
    if (this.clockEnabled && this.ready.white && this.ready.black && this.turnStartedAt === null) {
      this.turnStartedAt = Date.now();
    }
    this.touch();
  }

  /** Validates and applies a move for the player seated as `color`. */
  applyMove(color: Color, move: MovePayload): AppliedMove {
    this.assertRunning();
    if (!this.ready.white || !this.ready.black) {
      throw new GameError('Both players must be ready before the game starts');
    }
    if (this.turn() !== color) throw new GameError('Not your turn');

    // Charge the mover for the time they spent thinking. A move arriving after
    // the flag already fell is a loss on time, not a legal move.
    if (this.clockEnabled && this.turnStartedAt !== null) {
      const now = Date.now();
      this.remaining[color] = Math.max(0, this.remaining[color] - (now - this.turnStartedAt));
      if (this.remaining[color] <= 0) {
        this.timedOutBy = color;
        this.touch();
        throw new GameError('Out of time');
      }
    }

    let result;
    try {
      result = this.chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    } catch {
      throw new GameError(`Illegal move ${move.from}-${move.to}`);
    }
    // The opponent's clock starts now.
    if (this.clockEnabled) this.turnStartedAt = Date.now();
    this.touch();
    return {
      from: result.from,
      to: result.to,
      promotion: result.promotion as AppliedMove['promotion'],
      san: result.san,
      color,
    };
  }

  /**
   * Flag the active side if their clock has run out while idle (no move to
   * trigger the charge in {@link applyMove}). Returns true when this call
   * ended the game, so the caller can broadcast the new state.
   */
  checkTimeout(now = Date.now()): boolean {
    if (!this.clockEnabled || this.turnStartedAt === null || this.timedOutBy) return false;
    if (this.status() !== 'playing' && this.status() !== 'check') return false;
    const active = this.turn();
    if (this.remaining[active] - (now - this.turnStartedAt) > 0) return false;
    this.remaining[active] = 0;
    this.timedOutBy = active;
    this.touch();
    return true;
  }

  /** Remaining ms per side, current as of `now` (the active side ticks down). */
  private clockNow(now = Date.now()): Record<Color, number> {
    const snapshot = { white: this.remaining.white, black: this.remaining.black };
    if (this.clockEnabled && this.turnStartedAt !== null && !this.timedOutBy) {
      const status = this.status();
      if (status === 'playing' || status === 'check') {
        const active = this.turn();
        snapshot[active] = Math.max(0, snapshot[active] - (now - this.turnStartedAt));
      }
    }
    return snapshot;
  }

  resign(color: Color): void {
    this.assertRunning();
    this.resignedBy = color;
    this.touch();
  }

  private assertRunning(): void {
    const status = this.status();
    if (status === 'waiting') throw new GameError('Waiting for the opponent to join');
    if (status !== 'playing' && status !== 'check') throw new GameError('Game is over');
  }

  turn(): Color {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  status(): GameStatus {
    if (this.timedOutBy) return 'timeout';
    if (this.resignedBy) return 'resigned';
    if (!this.tokens.white || !this.tokens.black) return 'waiting';
    if (this.chess.isCheckmate()) return 'checkmate';
    if (this.chess.isStalemate()) return 'stalemate';
    // Fifty-move rule, threefold repetition or insufficient material.
    if (this.chess.isDraw()) return 'draw';
    if (this.chess.isCheck()) return 'check';
    return 'playing';
  }

  winner(): Color | undefined {
    if (this.timedOutBy) return opposite(this.timedOutBy);
    if (this.resignedBy) return opposite(this.resignedBy);
    if (this.chess.isCheckmate()) return opposite(this.turn());
    return undefined;
  }

  snapshot(): GameSnapshot {
    const clock = this.clockNow();
    return {
      code: this.code,
      fen: this.chess.fen(),
      turn: this.turn(),
      status: this.status(),
      winner: this.winner(),
      history: this.chess.history(),
      players: { white: !!this.tokens.white, black: !!this.tokens.black },
      ready: { ...this.ready },
      timeControl: Math.floor(this.baseMs / 1000),
      clock,
    };
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }
}
