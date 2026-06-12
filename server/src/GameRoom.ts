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
  private resignedBy: Color | null = null;
  lastActivity = Date.now();

  constructor(readonly code: string) {}

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

  /** Validates and applies a move for the player seated as `color`. */
  applyMove(color: Color, move: MovePayload): AppliedMove {
    this.assertRunning();
    if (this.turn() !== color) throw new GameError('Not your turn');

    let result;
    try {
      result = this.chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    } catch {
      throw new GameError(`Illegal move ${move.from}-${move.to}`);
    }
    this.touch();
    return {
      from: result.from,
      to: result.to,
      promotion: result.promotion as AppliedMove['promotion'],
      san: result.san,
      color,
    };
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
    if (this.resignedBy) return opposite(this.resignedBy);
    if (this.chess.isCheckmate()) return opposite(this.turn());
    return undefined;
  }

  snapshot(): GameSnapshot {
    return {
      code: this.code,
      fen: this.chess.fen(),
      turn: this.turn(),
      status: this.status(),
      winner: this.winner(),
      history: this.chess.history(),
      players: { white: !!this.tokens.white, black: !!this.tokens.black },
    };
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }
}
