import { Chess, type Move as ChessJsMove, type Square as SquareName } from 'chess.js';
import {
  oppositeColor,
  type GameStatus,
  type Move,
  type Piece,
  type PieceColor,
  type PieceType,
  type Square,
} from './types';

const TYPE_FROM_SYMBOL = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
} as const satisfies Record<string, PieceType>;

const SYMBOL_FROM_TYPE = {
  pawn: 'p',
  knight: 'n',
  bishop: 'b',
  rook: 'r',
  queen: 'q',
  king: 'k',
} as const satisfies Record<PieceType, string>;

function squareName(square: Square): SquareName {
  return `${String.fromCharCode(97 + square.file)}${square.rank + 1}` as SquareName;
}

function parseSquare(name: string): Square {
  return { file: name.charCodeAt(0) - 97, rank: Number(name[1]) - 1 };
}

/**
 * Thin adapter over chess.js: game tracking, legal move generation and end
 * states all come from the library. Verbose chess.js moves are converted to
 * the richer {@link Move} shape the 3D layer consumes (capture squares,
 * castling rook paths, en passant targets, SAN).
 */
export class ChessEngine {
  private readonly chess: Chess;

  constructor(fen?: string) {
    this.chess = fen ? new Chess(fen) : new Chess();
  }

  get turn(): PieceColor {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  pieceAt(square: Square): Piece | null {
    const piece = this.chess.get(squareName(square));
    return piece
      ? { type: TYPE_FROM_SYMBOL[piece.type], color: piece.color === 'w' ? 'white' : 'black' }
      : null;
  }

  /** All legal moves for the piece on `from` (empty if not the side to move). */
  legalMovesFrom(from: Square): Move[] {
    return this.chess
      .moves({ square: squareName(from), verbose: true })
      .filter(keepQueenPromotions)
      .map(convertMove);
  }

  /** All legal moves for the side to move. */
  allLegalMoves(): Move[] {
    return this.chess.moves({ verbose: true }).filter(keepQueenPromotions).map(convertMove);
  }

  /** Where the king of the given color stands. */
  kingSquare(color: PieceColor): Square {
    const symbol = color === 'white' ? 'w' : 'b';
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell && cell.type === 'k' && cell.color === symbol) {
          return parseSquare(cell.square);
        }
      }
    }
    throw new Error(`No ${color} king on the board`);
  }

  /** Applies a move previously obtained from legalMovesFrom(). */
  makeMove(move: Move): void {
    this.chess.move({
      from: squareName(move.from),
      to: squareName(move.to),
      promotion: move.promotion ? SYMBOL_FROM_TYPE[move.promotion] : undefined,
    });
  }

  /** Takes back the last move played. */
  undo(): void {
    this.chess.undo();
  }

  /** Game status for the side to move. */
  getStatus(): GameStatus {
    if (this.chess.isCheckmate()) return 'checkmate';
    if (this.chess.isStalemate()) return 'stalemate';
    // Fifty-move rule, threefold repetition or insufficient material.
    if (this.chess.isDraw()) return 'draw';
    if (this.chess.isCheck()) return 'check';
    return 'playing';
  }

  fen(): string {
    return this.chess.fen();
  }

  /** SAN move list of the game so far. */
  history(): string[] {
    return this.chess.history();
  }
}

/** The UI auto-queens, so underpromotion variants are not offered. */
function keepQueenPromotions(move: ChessJsMove): boolean {
  return !move.isPromotion() || move.promotion === 'q';
}

function convertMove(m: ChessJsMove): Move {
  const move: Move = {
    from: parseSquare(m.from),
    to: parseSquare(m.to),
    piece: TYPE_FROM_SYMBOL[m.piece],
    color: m.color === 'w' ? 'white' : 'black',
    san: m.san,
  };

  if (m.captured) {
    move.captured = { type: TYPE_FROM_SYMBOL[m.captured], color: oppositeColor(move.color) };
    // En passant captures the pawn beside the destination, not on it.
    move.capturedSquare = m.isEnPassant()
      ? { file: move.to.file, rank: move.from.rank }
      : move.to;
  }

  if (m.promotion) {
    move.promotion = TYPE_FROM_SYMBOL[m.promotion];
  }

  if (m.isKingsideCastle()) {
    move.castle = 'kingside';
    move.rookFrom = { file: 7, rank: move.from.rank };
    move.rookTo = { file: 5, rank: move.from.rank };
  } else if (m.isQueensideCastle()) {
    move.castle = 'queenside';
    move.rookFrom = { file: 0, rank: move.from.rank };
    move.rookTo = { file: 3, rank: move.from.rank };
  }

  if (m.isBigPawn()) move.isDoublePush = true;
  if (m.isEnPassant()) move.isEnPassant = true;

  return move;
}
