import type { PieceType } from './chess/types';

/** Size of a single chessboard square in world units (meters). */
export const SQUARE_SIZE = 1.5;

/** Number of squares along one side of the board. */
export const BOARD_SQUARES = 8;

/** Total width/depth of the playable board surface. */
export const BOARD_SIZE = SQUARE_SIZE * BOARD_SQUARES;

/** Width of the decorative border around the board. */
export const BORDER_WIDTH = SQUARE_SIZE * 0.75;

/** Eye height of the player camera. */
export const PLAYER_EYE_HEIGHT = 1.7;

/** Height of the surrounding ground plane (board top surface is y = 0). */
export const GROUND_Y = -0.34;

/**
 * Camera height when possessing a piece, slightly below the top of each
 * model — a pawn sees the world from much lower than the king.
 */
export const PIECE_EYE_HEIGHT: Record<PieceType, number> = {
  pawn: 1.0,
  rook: 1.25,
  knight: 1.3,
  bishop: 1.4,
  queen: 1.6,
  king: 1.78,
};

/** World-space center of a square (top surface is y = 0). */
export function squareCenter(file: number, rank: number): { x: number; z: number } {
  const half = BOARD_SIZE / 2;
  return {
    x: -half + SQUARE_SIZE / 2 + file * SQUARE_SIZE,
    z: -half + SQUARE_SIZE / 2 + rank * SQUARE_SIZE,
  };
}

/** Algebraic coordinate ("e4") for a file/rank pair. */
export function squareCoord(file: number, rank: number): string {
  return `${String.fromCharCode(97 + file)}${rank + 1}`;
}
