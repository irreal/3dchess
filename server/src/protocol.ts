/**
 * Wire types shared between the server and the game client.
 *
 * Squares travel as plain algebraic names ("e2", "g8") and promotions as
 * chess.js piece symbols, so the payloads stay trivially JSON-serializable.
 */

export type Color = 'white' | 'black';

export type GameStatus =
  | 'waiting' // opponent has not joined yet
  | 'playing'
  | 'check'
  | 'checkmate'
  | 'stalemate'
  | 'draw'
  | 'resigned';

/** A move as requested by a client. */
export interface MovePayload {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

/**
 * Ephemeral "where is the other player" signal: which piece their perspective
 * inhabits, and the live board position while that piece is walking a
 * corridor. Relayed to the opponent without touching game state.
 */
export interface PresencePayload {
  /** Square of the possessed piece, e.g. "g1". */
  possessed: string;
  /** World position while displaced from the home square; absent at rest. */
  pos?: { x: number; z: number };
  /** Duck (crouch) is held; absent when standing. */
  duck?: boolean;
  /** Cumulative take-off count; the receiver replays jumps it hasn't seen. */
  jumps?: number;
  /** Camera look yaw (radians), so the face screen orbits with the gaze. */
  yaw?: number;
  /** Camera look pitch (radians), so the face screen tilts with the gaze. */
  pitch?: number;
  /** Webcam is on; false when the friend turned their camera off. */
  camera?: boolean;
}

/**
 * WebRTC signaling payload (SDP descriptions and ICE candidates) for the
 * face-to-face video feature. The server treats it as opaque and relays it
 * to the opponent; the video itself flows peer-to-peer, never through here.
 */
export type RtcSignalPayload = Record<string, unknown>;

/** A move after the server validated and applied it. */
export interface AppliedMove extends MovePayload {
  san: string;
  color: Color;
}

/** Public state of a game; never contains player tokens. */
export interface GameSnapshot {
  code: string;
  fen: string;
  turn: Color;
  status: GameStatus;
  winner?: Color;
  /** SAN move list of the game so far. */
  history: string[];
  /** Which seats have been claimed. */
  players: { white: boolean; black: boolean };
}

export type ClientMessage =
  | { type: 'move'; move: MovePayload }
  | { type: 'presence'; presence: PresencePayload }
  | { type: 'rtc'; payload: RtcSignalPayload }
  | { type: 'resign' };

export type ServerMessage =
  /** Full snapshot, sent on connect and after non-move events (e.g. resign). */
  | { type: 'state'; you: Color; state: GameSnapshot }
  /** Broadcast to both players after every accepted move. */
  | { type: 'move'; move: AppliedMove; state: GameSnapshot }
  /** The opponent's live possession/walk position (relayed, best-effort). */
  | { type: 'presence'; presence: PresencePayload }
  /** WebRTC signaling from the opponent (relayed verbatim). */
  | { type: 'rtc'; payload: RtcSignalPayload }
  /** The opponent's connection came up or went down. */
  | { type: 'opponent'; connected: boolean }
  | { type: 'error'; message: string };
