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
  /** Duck (crouch) is held; absent when standing. */
  duck?: boolean;
  /** Cumulative take-off count — the receiver replays the jump physics
   * locally whenever this grows, so animations stay perfect at any rate. */
  jumps?: number;
  /** Camera look yaw (radians), so the face screen orbits with the gaze. */
  yaw?: number;
  /** Camera look pitch (radians), so the face screen tilts with the gaze. */
  pitch?: number;
  /** Webcam is on; false when the friend turned their camera off. */
  camera?: boolean;
}

/**
 * WebRTC signaling payload (an SDP description or an ICE candidate),
 * relayed verbatim through the server. The video itself flows peer-to-peer.
 */
export interface RtcSignalPayload {
  description?: RTCSessionDescriptionInit;
  /** Null signals end-of-candidates. */
  candidate?: RTCIceCandidateInit | null;
  /** Ask the friend to tear down their peer connection and start fresh
   * (a new connection cannot resume against a stale one). */
  reset?: boolean;
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
  | { type: 'rtc'; payload: RtcSignalPayload }
  | { type: 'resign' };

export type ServerMessage =
  | { type: 'state'; you: PieceColor; state: GameSnapshot }
  | { type: 'move'; move: AppliedMove; state: GameSnapshot }
  | { type: 'presence'; presence: PresencePayload }
  | { type: 'rtc'; payload: RtcSignalPayload }
  | { type: 'opponent'; connected: boolean }
  | { type: 'error'; message: string };
