import type { ChessEngine } from './ChessEngine';
import { sameSquare, type Move, type PieceType, type Square } from './types';

const PIECE_LETTERS: Record<PieceType, string> = {
  pawn: '',
  knight: 'N',
  bishop: 'B',
  rook: 'R',
  queen: 'Q',
  king: 'K',
};

function fileChar(file: number): string {
  return String.fromCharCode(97 + file);
}

function squareName(square: Square): string {
  return `${fileChar(square.file)}${square.rank + 1}`;
}

/**
 * Standard algebraic notation for a legal move in the given position,
 * including disambiguation, captures, castling, promotion and +/# suffixes.
 */
export function moveToSan(engine: ChessEngine, move: Move): string {
  let san: string;

  if (move.castle) {
    san = move.castle === 'kingside' ? 'O-O' : 'O-O-O';
  } else {
    const pieceLetter = PIECE_LETTERS[move.piece];

    // Disambiguate when another piece of the same type can reach the square.
    let disambiguation = '';
    if (move.piece !== 'pawn' && move.piece !== 'king') {
      const rivals = engine
        .allLegalMoves()
        .filter(
          (other) =>
            other.piece === move.piece &&
            sameSquare(other.to, move.to) &&
            !sameSquare(other.from, move.from),
        );
      if (rivals.length > 0) {
        const fileIsUnique = !rivals.some((other) => other.from.file === move.from.file);
        const rankIsUnique = !rivals.some((other) => other.from.rank === move.from.rank);
        if (fileIsUnique) disambiguation = fileChar(move.from.file);
        else if (rankIsUnique) disambiguation = String(move.from.rank + 1);
        else disambiguation = squareName(move.from);
      }
    }

    // Pawn captures are written with the originating file (e.g. "exd5").
    const pawnFile = move.piece === 'pawn' && move.captured ? fileChar(move.from.file) : '';
    const capture = move.captured ? 'x' : '';

    san = pieceLetter + disambiguation + pawnFile + capture + squareName(move.to);

    if (move.promotion) {
      san += `=${PIECE_LETTERS[move.promotion]}`;
    }
  }

  // Check / checkmate suffix, determined by playing the move on a copy.
  const next = engine.clone();
  next.makeMove(move);
  const status = next.getStatus();
  if (status === 'checkmate') san += '#';
  else if (status === 'check') san += '+';

  return san;
}
