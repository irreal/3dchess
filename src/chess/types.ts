export type PieceType = 'pawn' | 'rook' | 'knight' | 'bishop' | 'queen' | 'king';
export type PieceColor = 'white' | 'black';

export interface Piece {
  type: PieceType;
  color: PieceColor;
}

/** Board square: file 0-7 = a-h, rank 0-7 = 1-8. */
export interface Square {
  file: number;
  rank: number;
}

export interface Move {
  from: Square;
  to: Square;
  piece: PieceType;
  color: PieceColor;
  /** Standard algebraic notation, including +/# suffixes (from chess.js). */
  san: string;
  /** Piece removed by this move, if any. */
  captured?: Piece;
  /** Where the captured piece actually stands (differs from `to` for en passant). */
  capturedSquare?: Square;
  /** Piece the pawn turns into when reaching the last rank. */
  promotion?: PieceType;
  castle?: 'kingside' | 'queenside';
  rookFrom?: Square;
  rookTo?: Square;
  isDoublePush?: boolean;
  isEnPassant?: boolean;
}

/** Status for the side to move. */
export type GameStatus = 'playing' | 'check' | 'checkmate' | 'stalemate' | 'draw';

export function oppositeColor(color: PieceColor): PieceColor {
  return color === 'white' ? 'black' : 'white';
}

export function sameSquare(a: Square, b: Square): boolean {
  return a.file === b.file && a.rank === b.rank;
}
