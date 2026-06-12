# 3D Chess

A first-person 3D chess experiment built with Vite, TypeScript and Three.js. Game tracking, legal moves and end states come from the [chess.js](https://github.com/jhlywa/chess.js) library.

The player experiences the game from inside their own pieces: the camera sits at eye height inside the possessed piece, you leap into another friendly piece by looking at it and clicking, and you move by walking the possessed piece along "corridors" built from its legal moves (knights walk their L-path through the elbow square). Resting on a legal square or pressing Enter commits the move.

The game starts on a menu with three modes: free play (the player controls both sides), vs CPU (pick a color; the CPU — currently a random-move placeholder — plays the other side), and online play (create a game, share an invite link `?join=CODE` with a friend; the Fly.io server in `server/` is authoritative). Online games open in a free-roam warm-up: pieces walk anywhere on the board (no corridors, no chess moves) until both players tap Ready, at which point everything resets to its square and the chess game starts; the server rejects moves until both seats have sent `ready`. In CPU and online modes the enemy's "perspective" is tracked too: a floating marker hovers over the piece the enemy possesses, leaps into the piece it is about to move before walking it, and a screen-edge arrow points toward the marker when it is out of view.

## Structure

- `src/Game.ts` — orchestrator: scene, render loop, input, HUD, menu/game modes, possession flow, CPU opponent
- `src/chess/` — `ChessEngine`, a thin adapter over chess.js that emits the rich `Move` shape (capture squares, rook paths, SAN) the 3D layer consumes
- `src/controls/` — `PossessionController` (look, piece-jumping, corridor traversal) and `corridors.ts` (legal-move rails)
- `src/net/` — `OnlineClient` (HTTP lobby + WebSocket with reconnect/queue), `VideoCall` (P2P WebRTC for the face-to-face camera feature, signaled through the server relay), and the client-side mirror of the server wire protocol; remote moves are replayed from SAN history via `ChessEngine.moveFromSan`
- `src/world/` — board, piece meshes, move highlights, square indicator, enemy possession marker
- `tests/engine.test.ts` — engine unit tests, run with `npx tsx tests/engine.test.ts`
- `server/` — standalone multiplayer server (own npm package, Dockerized): authoritative game state via chess.js, HTTP API for creating/joining games by invite code, WebSocket play protocol. See `server/README.md`.

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npx tsc --noEmit` — type-check
- `cd server && npm test` — multiplayer server unit tests

## Testing policy

Do NOT perform automated runtime testing (no browser automation, no simulated input/pointer-lock smoke tests, no screenshot-driven verification). The maintainer tests gameplay changes manually.

Unit tests are fine: running and extending `tests/engine.test.ts` (and adding similar pure-logic tests) is welcome. Type-checking and builds are also fine.
