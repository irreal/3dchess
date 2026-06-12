import type { PieceColor, PieceType } from '../chess/types';

/**
 * Client-side mirror of the server wire protocol (see server/src/protocol.ts).
 * Squares travel as algebraic names ("e2"), promotions as chess.js symbols.
 */

export type OnlineGameStatus =
  | 'waiting'
  | 'playing'
  | 'check'
  | 'checkmate'
  | 'stalemate'
  | 'draw'
  | 'resigned';

export type PromotionSymbol = 'q' | 'r' | 'b' | 'n';

export const PROMOTION_SYMBOLS: Partial<Record<PieceType, PromotionSymbol>> = {
  queen: 'q',
  rook: 'r',
  bishop: 'b',
  knight: 'n',
};

export interface MovePayload {
  from: string;
  to: string;
  promotion?: PromotionSymbol;
}

/**
 * Ephemeral "where is the other player" signal: which piece their perspective
 * inhabits, and the live board position while that piece walks a corridor.
 * Streamed frequently and relayed best-effort; never part of game state.
 */
export interface PresencePayload {
  /** Square of the possessed piece, e.g. "g1". */
  possessed: string;
  /** World position while displaced from the home square; absent at rest. */
  pos?: { x: number; z: number };
}

export interface AppliedMove extends MovePayload {
  san: string;
  color: PieceColor;
}

export interface GameSnapshot {
  code: string;
  fen: string;
  turn: PieceColor;
  status: OnlineGameStatus;
  winner?: PieceColor;
  /** SAN move list of the whole game; the client replays what it is missing. */
  history: string[];
  players: { white: boolean; black: boolean };
}

export type ClientMessage =
  | { type: 'move'; move: MovePayload }
  | { type: 'presence'; presence: PresencePayload }
  | { type: 'resign' };

export type ServerMessage =
  | { type: 'state'; you: PieceColor; state: GameSnapshot }
  | { type: 'move'; move: AppliedMove; state: GameSnapshot }
  | { type: 'presence'; presence: PresencePayload }
  | { type: 'opponent'; connected: boolean }
  | { type: 'error'; message: string };
