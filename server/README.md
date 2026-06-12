# 3D Chess Multiplayer Server

Authoritative game server for the 3D chess client. It holds the only real copy
of each game's state and validates every move with chess.js, so a modified
client cannot move out of turn, move the opponent's pieces, or play illegal
moves. Games live in memory and expire after 24 hours of inactivity.

## How a game works

1. Player A creates a game: `POST /api/games` returns an invite `code`, a
   secret `token` and their `color`.
2. Player A shares the code (e.g. as a URL like `https://game/?join=GBAPCW`).
3. Player B joins: `POST /api/games/{code}/join` returns their own `token`
   and the remaining color.
4. Both open a WebSocket to `/ws?code={code}&token={token}` and play.

The token is the player's identity: it is returned exactly once at seat
claim, never appears in any public payload, and is required for the WebSocket
handshake (forged or missing tokens get a 401).

## HTTP API

All endpoints return JSON and allow cross-origin requests.

| Method | Path                    | Body                                      | Response |
| ------ | ----------------------- | ----------------------------------------- | -------- |
| POST   | `/api/games`            | optional `{ "color": "white" \| "black" \| "random" }` (default white) | `201 { code, token, color }` |
| POST   | `/api/games/{code}/join`| —                                         | `200 { code, token, color }`, `409` if full |
| GET    | `/api/games/{code}`     | —                                         | `200` public game snapshot |
| GET    | `/health`               | —                                         | `200 { ok: true }` |

## WebSocket protocol

Connect to `ws://host/ws?code={code}&token={token}`. Messages are JSON; the
full TypeScript types live in [`src/protocol.ts`](src/protocol.ts).

Client → server:

```json
{ "type": "ready" }
{ "type": "move", "move": { "from": "e2", "to": "e4", "promotion": "q" } }
{ "type": "resign" }
```

`ready` ends a player's free-roam warm-up phase (one-way). Moves are only
accepted once both players have sent it.

Server → client:

- `{ "type": "state", "you": "white", "state": { ... } }` — full snapshot,
  broadcast to both players whenever a socket connects (so the creator learns
  the friend joined) and after non-move events such as resignation.
- `{ "type": "move", "move": { from, to, promotion?, san, color }, "state": { ... } }`
  — broadcast to both players after every accepted move. Clients apply the
  move locally (or just trust `state.fen`).
- `{ "type": "opponent", "connected": true | false }` — opponent presence.
- `{ "type": "error", "message": "Not your turn" }` — rejected action; the
  game state is unchanged.

Every snapshot contains `code`, `fen`, `turn`, `status`
(`waiting | playing | check | checkmate | stalemate | draw | resigned`),
`winner` (when over), `history` (SAN list), `players` (which seats are
claimed) and `ready` (per-seat warm-up readiness). Moves are rejected until
both seats are claimed and both players have sent `ready`.

Reconnecting with the same token is fine at any time; a newer connection for
a seat replaces the older one.

## Development

```sh
npm install
npm run dev     # tsx watch, listens on :8080 (override with PORT)
npm test        # unit tests (npx tsx tests/game.test.ts)
npx tsc --noEmit
```

## Docker

```sh
docker build -t 3dchess-server .
docker run --rm -p 8080:8080 3dchess-server
```

## Deployment

The server runs on Fly.io as app `3dchess-server` (config in `fly.toml`),
reachable at <https://3dchess-server.fly.dev>. Deploy a new version with:

```sh
fly deploy
```

The machine auto-stops when no clients are connected; since games live in
memory, an idle (no open sockets) game does not survive a stop. The client
reads the server URL from `VITE_SERVER_URL` in the repo-root `.env`.

## TURN (video/voice relay)

`GET /api/ice` returns the ICE servers clients use for the face-to-face
call. With the Cloudflare Realtime TURN secrets configured, it mints
short-lived TURN credentials so calls connect even across symmetric NATs;
without them (e.g. local dev) it returns public STUN only, which still works
for most network pairs. Configure with:

```sh
fly secrets set TURN_KEY_ID=... TURN_API_TOKEN=...
```

The API token is only ever used server-side; clients receive ephemeral
per-request credentials (24 h TTL, matching game expiry).
