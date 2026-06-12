/**
 * Engine adapter sanity tests. Run with: npx tsx tests/engine.test.ts
 *
 * The rules themselves come from chess.js; these tests pin down the adapter:
 * the Move shape the 3D layer consumes (capture squares, rook paths, flags),
 * queen-only promotion filtering, SAN passthrough and end states.
 */
import { ChessEngine } from '../src/chess/ChessEngine';
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
    engine.makeMove(move);
    nodes += perft(engine, depth - 1);
    engine.undo();
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
  assertEqual(engine.history().join(' '), 'f3 e5 g4 Qh4#', 'history records the game');
}

// --- En passant: 1.e4 a6 2.e5 d5 -> exd6 e.p. available, then gone next move ---
{
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
  const ep = findMove(engine, 'e5', 'd6');
  assertEqual(ep?.isEnPassant, true, 'en passant capture available');
  assertEqual(ep?.capturedSquare?.rank, 4, 'en passant captures the pawn on d5');
  assertEqual(ep?.captured?.color, 'black', 'en passant victim is black');

  // If white plays something else, the en passant right expires.
  play(engine, ['b1', 'c3'], ['a6', 'a5']);
  assertEqual(findMove(engine, 'e5', 'd6') === undefined, true, 'en passant expires');
}

// --- Double pawn push flag (used to build pawn corridors) ---
{
  const engine = new ChessEngine();
  assertEqual(findMove(engine, 'e2', 'e4')?.isDoublePush, true, 'double push flagged');
  assertEqual(findMove(engine, 'e2', 'e3')?.isDoublePush, undefined, 'single push not flagged');
}

// --- Castling: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 -> O-O available ---
{
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']);
  const castle = findMove(engine, 'e1', 'g1');
  assertEqual(castle?.castle, 'kingside', 'kingside castling available');
  assertEqual(castle?.rookFrom?.file, 7, 'castling rook starts on h1');
  assertEqual(castle?.rookTo?.file, 5, 'castling rook slides to f1');

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
  // chess.js offers four promotion choices; the adapter keeps only the queen.
  const toG8 = engine.legalMovesFrom(sq('h7')).filter((m) => m.to.file === 6 && m.to.rank === 7);
  assertEqual(toG8.length, 1, 'one promotion move per destination');
  assertEqual(toG8[0].promotion, 'queen', 'promotion move auto-queens');
  engine.makeMove(toG8[0]);
  assertEqual(engine.pieceAt(sq('g8'))?.type, 'queen', 'queen appears on g8');
}

// --- Pinned piece cannot move ---
{
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['d2', 'd4'], ['f8', 'b4']);
  play(engine, ['b1', 'c3'], ['g8', 'f6']);
  // The white knight on c3 is pinned against the king by the b4 bishop.
  assertEqual(engine.legalMovesFrom(sq('c3')).length, 0, 'pinned knight has no moves');
}

// --- SAN comes straight from chess.js ---
{
  const engine = new ChessEngine();
  assertEqual(findMove(engine, 'g1', 'f3')?.san, 'Nf3', 'SAN: knight move');
  assertEqual(findMove(engine, 'e2', 'e4')?.san, 'e4', 'SAN: pawn push');

  // Fool's mate final move is Qh4#.
  play(engine, ['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4']);
  assertEqual(findMove(engine, 'd8', 'h4')?.san, 'Qh4#', 'SAN: mate suffix');
}
{
  // Pawn capture and en passant notation.
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
  assertEqual(findMove(engine, 'e5', 'd6')?.san, 'exd6', 'SAN: en passant');
}
{
  // Castling notation.
  const engine = new ChessEngine();
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']);
  assertEqual(findMove(engine, 'e1', 'g1')?.san, 'O-O', 'SAN: kingside castle');
}
{
  // Disambiguation: knights on b1 and f3 can both reach d2 once the d-pawn moves.
  const engine = new ChessEngine();
  play(engine, ['g1', 'f3'], ['a7', 'a6'], ['d2', 'd4'], ['a6', 'a5']);
  assertEqual(findMove(engine, 'f3', 'd2')?.san, 'Nfd2', 'SAN: file disambiguation');
  assertEqual(findMove(engine, 'b1', 'd2')?.san, 'Nbd2', 'SAN: file disambiguation 2');
  assertEqual(findMove(engine, 'f3', 'e5')?.san, 'Ne5', 'SAN: no disambiguation');
}

// --- King lookup (used to bail out when the CPU captures the possessed piece) ---
{
  const engine = new ChessEngine();
  assertEqual(engine.kingSquare('white').file, 4, 'white king starts on the e-file');
  assertEqual(engine.kingSquare('white').rank, 0, 'white king starts on rank 1');
  assertEqual(engine.kingSquare('black').rank, 7, 'black king starts on rank 8');

  // The lookup tracks the king as it moves (castling relocates it to g1).
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']);
  engine.makeMove(findMove(engine, 'e1', 'g1')!);
  assertEqual(engine.kingSquare('white').file, 6, 'king lookup follows castling');
}

// --- SAN -> Move conversion (used to replay multiplayer server history) ---
{
  const engine = new ChessEngine();
  const e4 = engine.moveFromSan('e4');
  assertEqual(e4?.from.file, 4, 'moveFromSan: pawn push origin file');
  assertEqual(e4?.isDoublePush, true, 'moveFromSan: double push flagged');
  assertEqual(engine.moveFromSan('Ke2'), null, 'moveFromSan: illegal SAN yields null');

  // Castling SAN converts with the rook path attached.
  play(engine, ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5']);
  const castle = engine.moveFromSan('O-O');
  assertEqual(castle?.castle, 'kingside', 'moveFromSan: castling converts');
  assertEqual(castle?.rookTo?.file, 5, 'moveFromSan: rook path attached');
}
{
  // Underpromotions are reachable via SAN even though the UI auto-queens.
  const engine = new ChessEngine('k7/7P/8/8/8/8/8/4K3 w - - 0 1');
  assertEqual(engine.moveFromSan('h8=N')?.promotion, 'knight', 'moveFromSan: underpromotion');
}

// --- End states from chess.js ---
{
  const stalemate = new ChessEngine('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assertEqual(stalemate.getStatus(), 'stalemate', 'stalemate detected');

  const bareKings = new ChessEngine('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  assertEqual(bareKings.getStatus(), 'draw', 'insufficient material is a draw');

  // Threefold repetition: both sides shuffle knights out and back twice.
  const engine = new ChessEngine();
  for (let i = 0; i < 2; i++) {
    play(engine, ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']);
  }
  assertEqual(engine.getStatus(), 'draw', 'threefold repetition is a draw');
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
