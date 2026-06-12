import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameManager } from './GameManager.js';
import { GameError, type GameRoom } from './GameRoom.js';
import { sanitizePresence } from './presence.js';
import type { AppliedMove, ClientMessage, Color, ServerMessage } from './protocol.js';

const PORT = Number(process.env.PORT ?? 8080);
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Flood guard for the live presence stream: clients send at ~12 Hz, so a
 * 40 ms floor (25 Hz) leaves headroom while capping a misbehaving client.
 */
const PRESENCE_MIN_INTERVAL_MS = 40;

/**
 * WebRTC signaling relay limits. SDP offers run a few KB; trickle ICE sends
 * a burst of small candidate messages, so a token bucket (instead of a flat
 * interval) lets legitimate bursts through while capping sustained abuse.
 */
const MAX_RTC_FRAME_BYTES = 32 * 1024;
const RTC_BUCKET_CAPACITY = 40;
const RTC_BUCKET_REFILL_PER_S = 10;

/**
 * Signaling must be reliable or WebRTC negotiation deadlocks: an offer lost
 * while the opponent's socket is down means neither side ever answers. Any
 * signal that can't be delivered right now is queued per seat and flushed
 * when that seat (re)connects.
 */
const RTC_OUTBOX_LIMIT = 64;
const rtcOutbox = new Map<string, Partial<Record<Color, unknown[]>>>();

/**
 * Cloudflare Realtime TURN: when the secrets are configured, /api/ice mints
 * short-lived TURN credentials so clients behind symmetric NATs can still
 * connect their calls. Without them (local dev), clients get STUN only.
 */
const TURN_KEY_ID = process.env.TURN_KEY_ID;
const TURN_API_TOKEN = process.env.TURN_API_TOKEN;
const ICE_TTL_SECONDS = 24 * 60 * 60; // matches the game expiry window
const STUN_ONLY_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

async function mintIceServers(): Promise<unknown[]> {
  if (!TURN_KEY_ID || !TURN_API_TOKEN) return STUN_ONLY_ICE_SERVERS;
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TURN_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl: ICE_TTL_SECONDS }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error(`Cloudflare TURN responded ${response.status}`);
    const body = (await response.json()) as { iceServers?: unknown };
    const ice = body.iceServers;
    if (Array.isArray(ice) && ice.length > 0) return ice;
    if (ice && typeof ice === 'object') return [ice];
    throw new Error('Cloudflare TURN returned no iceServers');
  } catch (error) {
    console.error('[ice] falling back to STUN only:', error);
    return STUN_ONLY_ICE_SERVERS;
  }
}

const manager = new GameManager();

/** Live socket per seat; a newer connection for the same seat replaces the old one. */
const seats = new Map<string, Partial<Record<Color, WebSocket>>>();

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  // The game client is served from a different origin (Vite dev server etc.).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders({ 'access-control-max-age': '86400' }));
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/ice') {
      json(res, 200, { iceServers: await mintIceServers() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/games') {
      const body = await readJsonBody(req);
      const room = manager.create();
      const { token, color } = room.join(parsePreferredColor(body));
      json(res, 201, { code: room.code, token, color });
      return;
    }

    const gameRoute = url.pathname.match(/^\/api\/games\/([A-Za-z0-9]+)(\/join|\/resume)?$/);
    if (gameRoute) {
      const room = manager.get(gameRoute[1]!);
      if (!room) {
        json(res, 404, { error: 'Game not found' });
        return;
      }
      if (req.method === 'POST' && gameRoute[2] === '/resume') {
        const body = await readJsonBody(req);
        const token = String((body as { token?: string } | null)?.token ?? '');
        const color = room.colorOf(token);
        if (!color) {
          json(res, 401, { error: 'Invalid or expired session' });
          return;
        }
        json(res, 200, { code: room.code, token, color });
        return;
      }
      if (req.method === 'POST' && gameRoute[2] === '/join') {
        const { token, color } = room.join();
        json(res, 200, { code: room.code, token, color });
        return;
      }
      if (req.method === 'GET' && !gameRoute[2]) {
        json(res, 200, room.snapshot());
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof GameError) {
      json(res, 409, { error: error.message });
    } else {
      console.error(error);
      json(res, 500, { error: 'Internal error' });
    }
  }
});

function parsePreferredColor(body: unknown): Color {
  const color = (body as { color?: string } | null)?.color;
  if (color === 'black' || color === 'white') return color;
  if (color === 'random') return Math.random() < 0.5 ? 'white' : 'black';
  return 'white';
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...extra,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders() });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new GameError('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new GameError('Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// WebSocket: /ws?code=ABC123&token=...
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const room = manager.get(url.searchParams.get('code') ?? '');
  const color = room?.colorOf(url.searchParams.get('token') ?? '') ?? null;
  if (url.pathname !== '/ws' || !room || !color) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, room, color));
});

function handleConnection(ws: WebSocket, room: GameRoom, color: Color): void {
  const seat = seatsOf(room.code);
  seat[color]?.close(4000, 'Replaced by a newer connection');
  seat[color] = ws;

  // Fresh snapshot for both sides: the connector initializes from it, and the
  // opponent learns the second seat was claimed the moment the friend joins.
  broadcastState(room);
  const opponent = seat[color === 'white' ? 'black' : 'white'];
  send(ws, { type: 'opponent', connected: opponent !== undefined });
  notifyOpponent(room, color, true);

  // Deliver signaling that arrived while this seat's socket was down.
  const queued = rtcOutbox.get(room.code)?.[color];
  if (queued && queued.length > 0) {
    console.log(`[rtc] ${room.code}: flushing ${queued.length} queued signal(s) to ${color}`);
    for (const payload of queued.splice(0)) {
      send(ws, { type: 'rtc', payload: payload as Record<string, unknown> });
    }
  }

  let lastPresenceRelayAt = 0;
  let rtcTokens = RTC_BUCKET_CAPACITY;
  let rtcRefillAt = Date.now();

  ws.on('message', (data) => {
    const text = String(data);
    if (text.length > MAX_RTC_FRAME_BYTES) return; // nothing legitimate is this big

    let message: ClientMessage;
    try {
      message = JSON.parse(text);
    } catch {
      send(ws, { type: 'error', message: 'Malformed message' });
      return;
    }

    // Presence is ephemeral and high-frequency: validate, rate-limit and
    // relay straight to the opponent without touching game state. Anything
    // malformed or too fast is dropped silently (no error round-trips).
    if (message.type === 'presence') {
      const now = Date.now();
      if (now - lastPresenceRelayAt < PRESENCE_MIN_INTERVAL_MS) return;
      const presence = sanitizePresence(message.presence);
      if (!presence) return;
      lastPresenceRelayAt = now;
      const opponent = seat[color === 'white' ? 'black' : 'white'];
      if (opponent) send(opponent, { type: 'presence', presence });
      return;
    }

    // WebRTC signaling: relayed opaque to the opponent so the two browsers
    // can negotiate a peer-to-peer video connection. The video itself never
    // touches this server.
    if (message.type === 'rtc') {
      const now = Date.now();
      rtcTokens = Math.min(
        RTC_BUCKET_CAPACITY,
        rtcTokens + ((now - rtcRefillAt) / 1000) * RTC_BUCKET_REFILL_PER_S,
      );
      rtcRefillAt = now;
      if (rtcTokens < 1) return;
      const payload = message.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
      rtcTokens -= 1;

      const opponentColor: Color = color === 'white' ? 'black' : 'white';
      const opponent = seat[opponentColor];
      if (opponent && opponent.readyState === opponent.OPEN) {
        send(opponent, { type: 'rtc', payload });
      } else {
        let box = rtcOutbox.get(room.code);
        if (!box) {
          box = {};
          rtcOutbox.set(room.code, box);
        }
        const queue = (box[opponentColor] ??= []);
        queue.push(payload);
        if (queue.length > RTC_OUTBOX_LIMIT) queue.shift();
        console.log(`[rtc] ${room.code}: ${opponentColor} offline, queued signal (${queue.length})`);
      }
      return;
    }

    try {
      handleMessage(ws, room, color, message);
    } catch (error) {
      if (error instanceof GameError) {
        send(ws, { type: 'error', message: error.message });
      } else {
        console.error(error);
        send(ws, { type: 'error', message: 'Internal error' });
      }
    }
  });

  ws.on('close', () => {
    if (seat[color] === ws) {
      delete seat[color];
      notifyOpponent(room, color, false);
    }
  });
}

function handleMessage(ws: WebSocket, room: GameRoom, color: Color, message: ClientMessage): void {
  switch (message.type) {
    case 'move': {
      const applied = room.applyMove(color, message.move);
      broadcastMove(room, applied);
      break;
    }
    case 'ready':
      room.markReady(color);
      broadcastState(room);
      break;
    case 'resign':
      room.resign(color);
      broadcastState(room);
      break;
    default:
      send(ws, { type: 'error', message: 'Unknown message type' });
  }
}

function seatsOf(code: string): Partial<Record<Color, WebSocket>> {
  let seat = seats.get(code);
  if (!seat) {
    seat = {};
    seats.set(code, seat);
  }
  return seat;
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function notifyOpponent(room: GameRoom, color: Color, connected: boolean): void {
  const opponent = seats.get(room.code)?.[color === 'white' ? 'black' : 'white'];
  if (opponent) send(opponent, { type: 'opponent', connected });
}

function broadcastMove(room: GameRoom, move: AppliedMove): void {
  const state = room.snapshot();
  const seat = seats.get(room.code);
  for (const color of ['white', 'black'] as const) {
    const ws = seat?.[color];
    if (ws) send(ws, { type: 'move', move, state });
  }
}

function broadcastState(room: GameRoom): void {
  const state = room.snapshot();
  const seat = seats.get(room.code);
  for (const color of ['white', 'black'] as const) {
    const ws = seat?.[color];
    if (ws) send(ws, { type: 'state', you: color, state });
  }
}

// ---------------------------------------------------------------------------

setInterval(() => {
  for (const code of manager.sweep()) {
    const seat = seats.get(code);
    seat?.white?.close(4001, 'Game expired');
    seat?.black?.close(4001, 'Game expired');
    seats.delete(code);
    rtcOutbox.delete(code);
  }
}, SWEEP_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`3dchess server listening on :${PORT}`);
});
