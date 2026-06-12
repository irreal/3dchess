/**
 * Server game-logic tests. Run with: npx tsx tests/game.test.ts (or npm test).
 *
 * Chess rules come from chess.js; these tests pin down the multiplayer rules
 * layered on top: seat assignment, token auth, turn enforcement, illegal-move
 * rejection, end states, resignation and game expiry.
 */
import { GameManager } from '../src/GameManager.js';
import { GameError, GameRoom } from '../src/GameRoom.js';
import { sanitizePresence } from '../src/presence.js';

let failures = 0;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` (expected ${expected}, got ${actual})`}`);
}

function assertThrows(fn: () => void, label: string): void {
  try {
    fn();
    failures++;
    console.log(`FAIL ${label} (expected GameError, nothing thrown)`);
  } catch (error) {
    const ok = error instanceof GameError;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` (threw non-GameError: ${error})`}`);
  }
}

/** Fresh room with both seats taken; creator is white. */
function fullRoom(): { room: GameRoom; white: string; black: string } {
  const room = new GameRoom('TEST42');
  const white = room.join('white').token;
  const black = room.join().token;
  return { room, white, black };
}

// --- Invite codes ---
{
  const manager = new GameManager();
  const room = manager.create();
  assertEqual(room.code.length, 6, 'code has 6 characters');
  assertEqual(/^[A-HJ-NP-Z2-9]+$/.test(room.code), true, 'code avoids ambiguous characters');
  assertEqual(manager.get(room.code), room, 'lookup by code');
  assertEqual(manager.get(room.code.toLowerCase()), room, 'lookup is case-insensitive');
  assertEqual(manager.get('NOPE99'), undefined, 'unknown code yields nothing');

  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) codes.add(manager.create().code);
  assertEqual(codes.size, 200, 'codes are unique');
}

// --- Seats and tokens ---
{
  const room = new GameRoom('TEST42');
  const creator = room.join('black');
  assertEqual(creator.color, 'black', 'creator gets the preferred color');
  assertEqual(room.status(), 'waiting', 'one player seated means waiting');

  const friend = room.join('black');
  assertEqual(friend.color, 'white', 'second player gets the remaining color');
  assertEqual(room.status(), 'playing', 'both seated means playing');
  assertThrows(() => room.join(), 'third join is rejected');

  assertEqual(room.colorOf(creator.token), 'black', 'token resolves to its seat');
  assertEqual(room.colorOf(friend.token), 'white', 'other token resolves too');
  assertEqual(room.colorOf('forged-token'), null, 'unknown token resolves to nobody');
  assertEqual(room.colorOf(''), null, 'empty token resolves to nobody');
}

// --- Move authorization ---
{
  const room = new GameRoom('TEST42');
  room.join('white');
  assertThrows(() => room.applyMove('white', { from: 'e2', to: 'e4' }), 'no moves before the opponent joins');
}
{
  const { room } = fullRoom();
  assertThrows(() => room.applyMove('black', { from: 'e7', to: 'e5' }), 'black cannot move first');
  assertThrows(() => room.applyMove('white', { from: 'e2', to: 'e5' }), 'illegal move rejected');
  assertThrows(() => room.applyMove('white', { from: 'e7', to: 'e5' }), "cannot move the opponent's piece");

  const applied = room.applyMove('white', { from: 'e2', to: 'e4' });
  assertEqual(applied.san, 'e4', 'legal move is applied and returns SAN');
  assertEqual(room.turn(), 'black', 'turn passes to black');
  assertThrows(() => room.applyMove('white', { from: 'd2', to: 'd4' }), 'white cannot move twice in a row');

  room.applyMove('black', { from: 'e7', to: 'e5' });
  assertEqual(room.snapshot().history.join(' '), 'e4 e5', 'snapshot history records the game');
}

// --- Promotion ---
{
  const { room } = fullRoom();
  const moves: [string, string, string][] = [
    ['white', 'h2', 'h4'], ['black', 'g7', 'g5'],
    ['white', 'h4', 'g5'], ['black', 'h7', 'h6'],
    ['white', 'g5', 'h6'], ['black', 'a7', 'a6'],
    ['white', 'h6', 'h7'], ['black', 'a6', 'a5'],
  ];
  for (const [color, from, to] of moves) {
    room.applyMove(color as 'white' | 'black', { from, to });
  }
  const promo = room.applyMove('white', { from: 'h7', to: 'g8', promotion: 'q' });
  assertEqual(promo.promotion, 'q', 'promotion applied');
  assertEqual(promo.san, 'hxg8=Q', 'promotion SAN passthrough');
}

// --- Checkmate ends the game ---
{
  const { room } = fullRoom();
  room.applyMove('white', { from: 'f2', to: 'f3' });
  room.applyMove('black', { from: 'e7', to: 'e5' });
  room.applyMove('white', { from: 'g2', to: 'g4' });
  room.applyMove('black', { from: 'd8', to: 'h4' });
  assertEqual(room.status(), 'checkmate', "fool's mate is checkmate");
  assertEqual(room.winner(), 'black', 'black wins by checkmate');
  assertThrows(() => room.applyMove('white', { from: 'a2', to: 'a3' }), 'no moves after checkmate');
}

// --- Resignation ---
{
  const { room } = fullRoom();
  room.resign('white');
  assertEqual(room.status(), 'resigned', 'resignation ends the game');
  assertEqual(room.winner(), 'black', 'opponent of the resigner wins');
  assertThrows(() => room.applyMove('black', { from: 'e7', to: 'e5' }), 'no moves after resignation');
  assertThrows(() => room.resign('black'), 'cannot resign a finished game');
}

// --- Snapshot never leaks tokens ---
{
  const { room, white, black } = fullRoom();
  const serialized = JSON.stringify(room.snapshot());
  assertEqual(serialized.includes(white), false, 'snapshot omits the white token');
  assertEqual(serialized.includes(black), false, 'snapshot omits the black token');
  assertEqual(room.snapshot().players.white && room.snapshot().players.black, true, 'snapshot reports seats as taken');
}

// --- Presence sanitizing (relayed between players, never trusted) ---
{
  assertEqual(
    JSON.stringify(sanitizePresence({ possessed: 'e4', pos: { x: 1.5, z: -2 } })),
    '{"possessed":"e4","pos":{"x":1.5,"z":-2}}',
    'valid walking presence passes through',
  );
  assertEqual(
    JSON.stringify(sanitizePresence({ possessed: 'g1' })),
    '{"possessed":"g1"}',
    'resting presence (no pos) passes through',
  );
  assertEqual(
    JSON.stringify(sanitizePresence({ possessed: 'g1', pos: { x: 1, z: 1 }, extra: 'x' })),
    '{"possessed":"g1","pos":{"x":1,"z":1}}',
    'unknown fields are stripped',
  );
  assertEqual(sanitizePresence(null), null, 'null payload rejected');
  assertEqual(sanitizePresence({ possessed: 'z9' }), null, 'bad square rejected');
  assertEqual(sanitizePresence({ possessed: 'e4e5' }), null, 'overlong square rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', pos: { x: NaN, z: 0 } }), null, 'NaN rejected');
  assertEqual(
    sanitizePresence({ possessed: 'e4', pos: { x: 1e9, z: 0 } }),
    null,
    'off-board position rejected',
  );
  assertEqual(
    sanitizePresence({ possessed: 'e4', pos: { x: '1', z: 2 } }),
    null,
    'non-numeric position rejected',
  );

  // Antics fields: duck flag and cumulative jump counter.
  assertEqual(
    JSON.stringify(sanitizePresence({ possessed: 'e4', duck: true, jumps: 3 })),
    '{"possessed":"e4","duck":true,"jumps":3}',
    'duck and jumps pass through',
  );
  assertEqual(
    JSON.stringify(sanitizePresence({ possessed: 'e4', duck: false, jumps: 0 })),
    '{"possessed":"e4"}',
    'falsy duck/jumps are omitted',
  );
  assertEqual(sanitizePresence({ possessed: 'e4', duck: 'yes' }), null, 'non-bool duck rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', jumps: 1.5 }), null, 'fractional jumps rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', jumps: -1 }), null, 'negative jumps rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', jumps: 1e12 }), null, 'absurd jumps rejected');

  // Look yaw/pitch for the face screen.
  assertEqual(
    JSON.stringify(sanitizePresence({ possessed: 'e4', yaw: -1.57 })),
    '{"possessed":"e4","yaw":-1.57}',
    'yaw passes through',
  );
  assertEqual(sanitizePresence({ possessed: 'e4', yaw: 9 }), null, 'out-of-range yaw rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', yaw: NaN }), null, 'NaN yaw rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', yaw: '1' }), null, 'non-numeric yaw rejected');
  assertEqual(
    JSON.stringify(sanitizePresence({ possessed: 'e4', pitch: 0.42 })),
    '{"possessed":"e4","pitch":0.42}',
    'pitch passes through',
  );
  assertEqual(sanitizePresence({ possessed: 'e4', pitch: 3 }), null, 'out-of-range pitch rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', pitch: NaN }), null, 'NaN pitch rejected');
  assertEqual(sanitizePresence({ possessed: 'e4', pitch: '1' }), null, 'non-numeric pitch rejected');
}

// --- Expiry sweep ---
{
  const manager = new GameManager();
  const stale = manager.create();
  stale.lastActivity = Date.now() - 1000;
  const fresh = manager.create();
  const removed = manager.sweep(500);
  assertEqual(removed.length, 1, 'sweep removes exactly the idle game');
  assertEqual(removed[0], stale.code, 'the idle game is the one removed');
  assertEqual(manager.get(stale.code), undefined, 'removed game is gone');
  assertEqual(manager.get(fresh.code), fresh, 'active game survives the sweep');
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
