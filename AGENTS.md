# 3D Chess

A first-person 3D chess experiment built with Vite, TypeScript and Three.js (no external chess library).

The player experiences the game from inside their own pieces: the camera sits at eye height inside the possessed piece, you leap into another friendly piece by looking at it and clicking, and you move by walking the possessed piece along "corridors" built from its legal moves (knights walk their L-path through the elbow square). Resting on a legal square or pressing Enter commits the move.

## Structure

- `src/Game.ts` — orchestrator: scene, render loop, input, HUD, possession flow
- `src/chess/` — custom rules engine (`ChessEngine`), types, SAN notation
- `src/controls/` — `PossessionController` (look, piece-jumping, corridor traversal) and `corridors.ts` (legal-move rails)
- `src/world/` — board, piece meshes, move highlights, square indicator
- `tests/engine.test.ts` — engine unit tests, run with `npx tsx tests/engine.test.ts`

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npx tsc --noEmit` — type-check

## Testing policy

Do NOT perform automated runtime testing (no browser automation, no simulated input/pointer-lock smoke tests, no screenshot-driven verification). The maintainer tests gameplay changes manually.

Unit tests are fine: running and extending `tests/engine.test.ts` (and adding similar pure-logic tests) is welcome. Type-checking and builds are also fine.
