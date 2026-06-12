/**
 * Engine sanity tests. Run with: npx tsx tests/engine.test.ts
 */
import { ChessEngine } from '../src/chess/ChessEngine';
import { moveToSan } from '../src/chess/notation';
import type { Move, Square } from '../src/chess/types';

let failures = 0;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` (expected ${expected}, got ${actual})`}`);
}

function sq(coord: string): Square {
  return { file: coord.charCodeAt(0) - 97, rank: Number(coord[1]) - 1 };
}

function findMove(engine: ChessEngine, from: string, to: string): Move | undefined {
  const target = sq(to);
  return engine
    .legalMovesFrom(sq(from))
    .find((m) => m.to.file === target.file && m.to.rank === target.rank);
}

function play(engine: ChessEngine, ...moves: [string, string][]): void {
  for (const [from, to] of moves) {
    const move = findMove(engine, from, to);
    if (!move) throw new Error(`Illegal/unknown move ${from}-${to}`);
    engine.makeMove(move);
  }
}

// --- Perft: node counts from the start position ---
function perft(engine: ChessEngine, depth: number): number {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const move of engine.allLegalMoves()) {
    const next = engine.clone();
    next.makeMove(move);
    nodes += perft(next, depth - 1);
  }
  return nodes;
}

const start = new ChessEngine();
assertEqual(perft(start, 1), 20, 'perft(1) = 20');
assertEqual(perft(start, 2), 400, 'perft(2) = 400');
assertEqual(perft(start, 3), 8902, 'perft(3) = 8902');
assertEqual(perft(start, 4), 197281, 'perft(4) = 197281');

// --- Fool's mate: 1.f3 e5 2.g4 Qh4# ---
{
  const engine = new ChessEngine();
  play(engine, ['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']);
  assertEqual(engine.getStatus(), 'checkmate', "fool's mate is checkmate");
}

// --- En passant: 1.e4 a6 2.e5 d5 -> exd6 e.p. available, then gone next move ---
{
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
  const ep = findMove(engine, 'e5', 'd6');
  assertEqual(ep?.isEnPassant, true, 'en passant capture available');
  assertEqual(ep?.capturedSquare?.rank, 4, 'en passant captures the pawn on d5');

  // If white plays something else, the en passant right expires.
  play(engine, ['b1', 'c3'], ['a6', 'a5']);
  assertEqual(findMove(engine, 'e5', 'd6') === undefined, true, 'en passant expires');
}

// --- Castling: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 -> O-O available ---
{
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']);
  const castle = findMove(engine, 'e1', 'g1');
  assertEqual(castle?.castle, 'kingside', 'kingside castling available');

  // After castling the rook ends up on f1.
  engine.makeMove(castle!);
  assertEqual(engine.pieceAt(sq('f1'))?.type, 'rook', 'rook lands on f1');
  assertEqual(engine.pieceAt(sq('g1'))?.type, 'king', 'king lands on g1');
}

// --- Promotion: pawn reaching the last rank auto-queens ---
{
  const engine = new ChessEngine();
  play(
    engine,
    ['h2', 'h4'], ['g7', 'g5'],
    ['h4', 'g5'], ['h7', 'h6'],
    ['g5', 'h6'], ['a7', 'a6'],
    ['h6', 'h7'], ['a6', 'a5'],
  );
  const promo = findMove(engine, 'h7', 'g8'); // capture the knight and promote
  assertEqual(promo?.promotion, 'queen', 'promotion move auto-queens');
  engine.makeMove(promo!);
  assertEqual(engine.pieceAt(sq('g8'))?.type, 'queen', 'queen appears on g8');
}

// --- Pinned piece cannot move ---
{
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['d2', 'd4'], ['f8', 'b4']); // bishop pins...
  // Nb1-c3 would block the pin square; the pawn on d4 is NOT pinned, but after
  // 3.Nc3?? is illegal? Actually Bb4 pins Nc3 once it moves there. Check c3 knight pin:
  play(engine, ['b1', 'c3']);
  play(engine, ['g8', 'f6']);
  // Now white knight on c3 is pinned against the king by the b4 bishop.
  assertEqual(engine.legalMovesFrom(sq('c3')).length, 0, 'pinned knight has no moves');
}

// --- SAN notation ---
{
  const engine = new ChessEngine();
  assertEqual(moveToSan(engine, findMove(engine, 'g1', 'f3')!), 'Nf3', 'SAN: knight move');
  assertEqual(moveToSan(engine, findMove(engine, 'e2', 'e4')!), 'e4', 'SAN: pawn push');

  // Fool's mate final move is Qh4#.
  play(engine, ['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4']);
  assertEqual(moveToSan(engine, findMove(engine, 'd8', 'h4')!), 'Qh4#', 'SAN: mate suffix');
}
{
  // Pawn capture and en passant notation.
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
  assertEqual(moveToSan(engine, findMove(engine, 'e5', 'd6')!), 'exd6', 'SAN: en passant');
}
{
  // Castling notation.
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']);
  assertEqual(moveToSan(engine, findMove(engine, 'e1', 'g1')!), 'O-O', 'SAN: kingside castle');
}
{
  // Disambiguation: knights on b1 and f3 can both reach d2 once the d-pawn moves.
  const engine = new ChessEngine();
  play(engine, ['g1', 'f3'], ['a7', 'a6'], ['d2', 'd4'], ['a6', 'a5']);
  assertEqual(moveToSan(engine, findMove(engine, 'f3', 'd2')!), 'Nfd2', 'SAN: file disambiguation');
  assertEqual(moveToSan(engine, findMove(engine, 'b1', 'd2')!), 'Nbd2', 'SAN: file disambiguation 2');
  // A knight move with no rival needs no disambiguation.
  assertEqual(moveToSan(engine, findMove(engine, 'f3', 'e5')!), 'Ne5', 'SAN: no disambiguation');
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
