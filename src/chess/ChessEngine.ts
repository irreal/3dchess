import {
  oppositeColor,
  type GameStatus,
  type Move,
  type Piece,
  type PieceColor,
  type PieceType,
  type Square,
} from './types';

type Board = (Piece | null)[][]; // indexed [rank][file]

type Offset = readonly [file: number, rank: number];

const KNIGHT_OFFSETS: readonly Offset[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

const KING_OFFSETS: readonly Offset[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

const ROOK_DIRS: readonly Offset[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const BISHOP_DIRS: readonly Offset[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const QUEEN_DIRS: readonly Offset[] = [...ROOK_DIRS, ...BISHOP_DIRS];

const BACK_RANK: readonly PieceType[] = [
  'rook',
  'knight',
  'bishop',
  'queen',
  'king',
  'bishop',
  'knight',
  'rook',
];

function inBounds(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function cloneBoard(board: Board): Board {
  return board.map((rank) => rank.slice());
}

function createStartBoard(): Board {
  const board: Board = Array.from({ length: 8 }, () => Array<Piece | null>(8).fill(null));
  for (let file = 0; file < 8; file++) {
    board[0][file] = { type: BACK_RANK[file], color: 'white' };
    board[1][file] = { type: 'pawn', color: 'white' };
    board[6][file] = { type: 'pawn', color: 'black' };
    board[7][file] = { type: BACK_RANK[file], color: 'black' };
  }
  return board;
}

function findKing(board: Board, color: PieceColor): Square | null {
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank][file];
      if (piece && piece.type === 'king' && piece.color === color) {
        return { file, rank };
      }
    }
  }
  return null;
}

function isSquareAttacked(board: Board, square: Square, by: PieceColor): boolean {
  // Pawns.
  const pawnDir = by === 'white' ? 1 : -1;
  for (const df of [-1, 1]) {
    const file = square.file + df;
    const rank = square.rank - pawnDir;
    if (inBounds(file, rank)) {
      const piece = board[rank][file];
      if (piece && piece.color === by && piece.type === 'pawn') return true;
    }
  }

  // Knights and kings.
  const stepChecks: [readonly Offset[], PieceType][] = [
    [KNIGHT_OFFSETS, 'knight'],
    [KING_OFFSETS, 'king'],
  ];
  for (const [offsets, type] of stepChecks) {
    for (const [df, dr] of offsets) {
      const file = square.file + df;
      const rank = square.rank + dr;
      if (!inBounds(file, rank)) continue;
      const piece = board[rank][file];
      if (piece && piece.color === by && piece.type === type) return true;
    }
  }

  // Sliding pieces.
  const slideChecks: [readonly Offset[], PieceType][] = [
    [ROOK_DIRS, 'rook'],
    [BISHOP_DIRS, 'bishop'],
  ];
  for (const [dirs, type] of slideChecks) {
    for (const [df, dr] of dirs) {
      let file = square.file + df;
      let rank = square.rank + dr;
      while (inBounds(file, rank)) {
        const piece = board[rank][file];
        if (piece) {
          if (piece.color === by && (piece.type === type || piece.type === 'queen')) return true;
          break;
        }
        file += df;
        rank += dr;
      }
    }
  }

  return false;
}

/** Applies a move to a board. Handles captures, promotion and castling. */
function applyMoveToBoard(board: Board, move: Move): void {
  const piece = board[move.from.rank][move.from.file];
  if (!piece) return;

  if (move.capturedSquare) {
    board[move.capturedSquare.rank][move.capturedSquare.file] = null;
  }

  board[move.from.rank][move.from.file] = null;
  board[move.to.rank][move.to.file] = move.promotion
    ? { type: move.promotion, color: piece.color }
    : piece;

  if (move.rookFrom && move.rookTo) {
    const rook = board[move.rookFrom.rank][move.rookFrom.file];
    board[move.rookFrom.rank][move.rookFrom.file] = null;
    board[move.rookTo.rank][move.rookTo.file] = rook;
  }
}

/**
 * Standard chess rules engine: move generation (including castling,
 * en passant, promotion), full check legality, checkmate and stalemate.
 *
 * Not implemented: draw by repetition, fifty-move rule, insufficient material.
 */
export class ChessEngine {
  turn: PieceColor = 'white';

  private board = createStartBoard();
  private castling = {
    white: { kingside: true, queenside: true },
    black: { kingside: true, queenside: true },
  };
  /** Square a pawn skipped with a double push last move (en passant target). */
  private enPassant: Square | null = null;

  pieceAt(square: Square): Piece | null {
    return this.board[square.rank][square.file];
  }

  isInCheck(color: PieceColor): boolean {
    const king = findKing(this.board, color);
    return king !== null && isSquareAttacked(this.board, king, oppositeColor(color));
  }

  /** All legal moves for the piece on `from` (empty if not the side to move). */
  legalMovesFrom(from: Square): Move[] {
    const piece = this.pieceAt(from);
    if (!piece || piece.color !== this.turn) return [];
    return this.pseudoMoves(from, piece).filter((move) => !this.leavesKingInCheck(move));
  }

  /** All legal moves for the side to move. */
  allLegalMoves(): Move[] {
    const moves: Move[] = [];
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = this.board[rank][file];
        if (piece && piece.color === this.turn) {
          moves.push(...this.legalMovesFrom({ file, rank }));
        }
      }
    }
    return moves;
  }

  clone(): ChessEngine {
    const copy = new ChessEngine();
    copy.board = cloneBoard(this.board);
    copy.turn = this.turn;
    copy.castling = {
      white: { ...this.castling.white },
      black: { ...this.castling.black },
    };
    copy.enPassant = this.enPassant ? { ...this.enPassant } : null;
    return copy;
  }

  /** Applies a move previously obtained from legalMovesFrom(). */
  makeMove(move: Move): void {
    applyMoveToBoard(this.board, move);
    this.updateCastlingRights(move);

    this.enPassant = move.isDoublePush
      ? { file: move.from.file, rank: (move.from.rank + move.to.rank) / 2 }
      : null;

    this.turn = oppositeColor(this.turn);
  }

  /** Game status for the side to move. */
  getStatus(): GameStatus {
    const inCheck = this.isInCheck(this.turn);
    if (!this.hasAnyLegalMove()) {
      return inCheck ? 'checkmate' : 'stalemate';
    }
    return inCheck ? 'check' : 'playing';
  }

  private hasAnyLegalMove(): boolean {
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = this.board[rank][file];
        if (piece && piece.color === this.turn && this.legalMovesFrom({ file, rank }).length > 0) {
          return true;
        }
      }
    }
    return false;
  }

  private leavesKingInCheck(move: Move): boolean {
    const board = cloneBoard(this.board);
    applyMoveToBoard(board, move);
    const king = findKing(board, move.color);
    return king === null || isSquareAttacked(board, king, oppositeColor(move.color));
  }

  private updateCastlingRights(move: Move): void {
    const rights = this.castling[move.color];
    const homeRank = move.color === 'white' ? 0 : 7;

    if (move.piece === 'king') {
      rights.kingside = false;
      rights.queenside = false;
    } else if (move.piece === 'rook' && move.from.rank === homeRank) {
      if (move.from.file === 0) rights.queenside = false;
      if (move.from.file === 7) rights.kingside = false;
    }

    // Capturing a rook on its home square removes the opponent's right.
    if (move.captured?.type === 'rook' && move.capturedSquare) {
      const enemyRights = this.castling[oppositeColor(move.color)];
      const enemyHomeRank = move.color === 'white' ? 7 : 0;
      if (move.capturedSquare.rank === enemyHomeRank) {
        if (move.capturedSquare.file === 0) enemyRights.queenside = false;
        if (move.capturedSquare.file === 7) enemyRights.kingside = false;
      }
    }
  }

  private pseudoMoves(from: Square, piece: Piece): Move[] {
    switch (piece.type) {
      case 'pawn':
        return this.pawnMoves(from, piece.color);
      case 'knight':
        return this.stepMoves(from, piece, KNIGHT_OFFSETS);
      case 'bishop':
        return this.slideMoves(from, piece, BISHOP_DIRS);
      case 'rook':
        return this.slideMoves(from, piece, ROOK_DIRS);
      case 'queen':
        return this.slideMoves(from, piece, QUEEN_DIRS);
      case 'king':
        return [...this.stepMoves(from, piece, KING_OFFSETS), ...this.castleMoves(piece.color)];
    }
  }

  private createMove(from: Square, to: Square, piece: Piece): Move {
    const captured = this.board[to.rank][to.file];
    const move: Move = { from, to, piece: piece.type, color: piece.color };
    if (captured) {
      move.captured = captured;
      move.capturedSquare = to;
    }
    return move;
  }

  private stepMoves(from: Square, piece: Piece, offsets: readonly Offset[]): Move[] {
    const moves: Move[] = [];
    for (const [df, dr] of offsets) {
      const file = from.file + df;
      const rank = from.rank + dr;
      if (!inBounds(file, rank)) continue;
      const target = this.board[rank][file];
      if (!target || target.color !== piece.color) {
        moves.push(this.createMove(from, { file, rank }, piece));
      }
    }
    return moves;
  }

  private slideMoves(from: Square, piece: Piece, dirs: readonly Offset[]): Move[] {
    const moves: Move[] = [];
    for (const [df, dr] of dirs) {
      let file = from.file + df;
      let rank = from.rank + dr;
      while (inBounds(file, rank)) {
        const target = this.board[rank][file];
        if (!target) {
          moves.push(this.createMove(from, { file, rank }, piece));
        } else {
          if (target.color !== piece.color) {
            moves.push(this.createMove(from, { file, rank }, piece));
          }
          break;
        }
        file += df;
        rank += dr;
      }
    }
    return moves;
  }

  private pawnMoves(from: Square, color: PieceColor): Move[] {
    const moves: Move[] = [];
    const dir = color === 'white' ? 1 : -1;
    const startRank = color === 'white' ? 1 : 6;
    const promoRank = color === 'white' ? 7 : 0;

    const push = (move: Move): void => {
      // Auto-promote to queen (underpromotion not offered by the UI).
      if (move.to.rank === promoRank) move.promotion = 'queen';
      moves.push(move);
    };

    // Forward pushes.
    const oneAhead = { file: from.file, rank: from.rank + dir };
    if (inBounds(oneAhead.file, oneAhead.rank) && !this.board[oneAhead.rank][oneAhead.file]) {
      push({ from, to: oneAhead, piece: 'pawn', color });

      const twoAhead = { file: from.file, rank: from.rank + 2 * dir };
      if (from.rank === startRank && !this.board[twoAhead.rank][twoAhead.file]) {
        moves.push({ from, to: twoAhead, piece: 'pawn', color, isDoublePush: true });
      }
    }

    // Captures, including en passant.
    for (const df of [-1, 1]) {
      const to = { file: from.file + df, rank: from.rank + dir };
      if (!inBounds(to.file, to.rank)) continue;

      const target = this.board[to.rank][to.file];
      if (target && target.color !== color) {
        push({ from, to, piece: 'pawn', color, captured: target, capturedSquare: to });
      } else if (
        !target &&
        this.enPassant &&
        this.enPassant.file === to.file &&
        this.enPassant.rank === to.rank
      ) {
        const capturedSquare = { file: to.file, rank: from.rank };
        const captured = this.board[capturedSquare.rank][capturedSquare.file];
        if (captured) {
          moves.push({
            from,
            to,
            piece: 'pawn',
            color,
            captured,
            capturedSquare,
            isEnPassant: true,
          });
        }
      }
    }

    return moves;
  }

  private castleMoves(color: PieceColor): Move[] {
    const moves: Move[] = [];
    const rank = color === 'white' ? 0 : 7;
    const rights = this.castling[color];
    const enemy = oppositeColor(color);

    if (!rights.kingside && !rights.queenside) return moves;
    // Cannot castle out of check.
    if (isSquareAttacked(this.board, { file: 4, rank }, enemy)) return moves;

    const empty = (file: number): boolean => !this.board[rank][file];
    const safe = (file: number): boolean => !isSquareAttacked(this.board, { file, rank }, enemy);

    if (rights.kingside && empty(5) && empty(6) && safe(5) && safe(6)) {
      moves.push({
        from: { file: 4, rank },
        to: { file: 6, rank },
        piece: 'king',
        color,
        castle: 'kingside',
        rookFrom: { file: 7, rank },
        rookTo: { file: 5, rank },
      });
    }

    if (rights.queenside && empty(1) && empty(2) && empty(3) && safe(2) && safe(3)) {
      moves.push({
        from: { file: 4, rank },
        to: { file: 2, rank },
        piece: 'king',
        color,
        castle: 'queenside',
        rookFrom: { file: 0, rank },
        rookTo: { file: 3, rank },
      });
    }

    return moves;
  }
}
