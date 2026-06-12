import type { PieceColor } from '../chess/types';
import type { ClientMessage, ServerMessage } from './protocol';

const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

/**
 * Per-tab session storage so a reload rejoins the same seat, while a second
 * tab joining the same code becomes the other player (handy for testing).
 */
const SESSION_KEY = '3dchess-online-session';
const IN_GAME_KEY = '3dchess-online-in-game';

export interface OnlineSession {
  code: string;
  token: string;
  color: PieceColor;
}

export async function createOnlineGame(): Promise<OnlineSession> {
  const session = await post('/api/games');
  saveSession(session);
  return session;
}

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/**
 * ICE servers for the video call. The server mints short-lived Cloudflare
 * TURN credentials when configured, so calls connect even across symmetric
 * NATs; any failure degrades to public STUN (direct P2P only).
 */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch(`${SERVER_URL}/api/ice`);
    const body = (await response.json()) as { iceServers?: RTCIceServer[] } | null;
    if (response.ok && Array.isArray(body?.iceServers) && body.iceServers.length > 0) {
      const urls = body.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
      const turnUrls = urls.filter((url) => String(url).startsWith('turn'));
      console.info(
        `[rtc] ICE config from server: ${urls.length} urls, ${turnUrls.length} TURN`,
      );
      return body.iceServers;
    }
    console.warn('[rtc] server returned no usable ICE config, falling back to STUN only');
  } catch (error) {
    console.warn('[rtc] failed to fetch ICE config, falling back to STUN only', error);
  }
  return FALLBACK_ICE_SERVERS;
}

export function getStoredOnlineSession(): OnlineSession | null {
  return loadSession();
}

/** True when the player had entered the 3D board before the last reload. */
export function wasOnlineInGame(): boolean {
  return sessionStorage.getItem(IN_GAME_KEY) === '1';
}

export function markOnlineInGame(inGame: boolean): void {
  if (inGame) sessionStorage.setItem(IN_GAME_KEY, '1');
  else sessionStorage.removeItem(IN_GAME_KEY);
}

/** Keep the invite code in the URL so a reload can find the game. Token stays in sessionStorage. */
export function syncGameUrl(code: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('join', code);
  history.replaceState(null, '', url);
}

export function clearStoredOnlineSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(IN_GAME_KEY);
}

export async function joinOnlineGame(code: string): Promise<OnlineSession> {
  const normalized = code.toUpperCase();
  const stored = loadSession();
  if (stored && stored.code === normalized) {
    try {
      return await resumeOnlineGame(stored);
    } catch {
      clearStoredOnlineSession();
    }
  }
  const session = await post(`/api/games/${encodeURIComponent(normalized)}/join`);
  saveSession(session);
  return session;
}

/** Reclaim an existing seat after a reload (validates the token with the server). */
export async function resumeOnlineGame(session: OnlineSession): Promise<OnlineSession> {
  const body = await postWithBody(`/api/games/${encodeURIComponent(session.code)}/resume`, {
    token: session.token,
  });
  const restored = { code: body.code, token: body.token, color: body.color };
  saveSession(restored);
  return restored;
}

async function post(path: string): Promise<OnlineSession> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, { method: 'POST' });
  } catch {
    throw new Error('Could not reach the game server');
  }
  const body = (await response.json().catch(() => null)) as
    | (OnlineSession & { error?: string })
    | null;
  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Server error (${response.status})`);
  }
  return { code: body.code, token: body.token, color: body.color };
}

async function postWithBody(
  path: string,
  payload: Record<string, unknown>,
): Promise<OnlineSession> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Could not reach the game server');
  }
  const body = (await response.json().catch(() => null)) as
    | (OnlineSession & { error?: string })
    | null;
  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Server error (${response.status})`);
  }
  return { code: body.code, token: body.token, color: body.color };
}

function saveSession(session: OnlineSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession(): OnlineSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as OnlineSession) : null;
  } catch {
    return null;
  }
}

/**
 * WebSocket connection to one game. Reconnects automatically with backoff;
 * messages sent while offline are queued and flushed on reconnect, so a move
 * committed during a connection blip still reaches the server.
 */
export class OnlineClient {
  onMessage: ((message: ServerMessage) => void) | null = null;
  onConnection: ((connected: boolean) => void) | null = null;

  private socket: WebSocket | null = null;
  private readonly queue: ClientMessage[] = [];
  private closed = false;
  private retryMs = 1000;

  constructor(private readonly session: OnlineSession) {}

  connect(): void {
    const base = SERVER_URL.replace(/^http/, 'ws');
    const url = `${base}/ws?code=${encodeURIComponent(this.session.code)}&token=${encodeURIComponent(this.session.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryMs = 1000;
      while (this.queue.length > 0) {
        socket.send(JSON.stringify(this.queue.shift()));
      }
      this.onConnection?.(true);
    });

    socket.addEventListener('message', (event) => {
      try {
        this.onMessage?.(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        // Ignore malformed frames.
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return; // superseded by a newer connection
      this.socket = null;
      this.onConnection?.(false);
      if (!this.closed) {
        window.setTimeout(() => {
          if (!this.closed) this.connect();
        }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 10_000);
      }
    });
  }

  /**
   * Volatile messages (the high-frequency presence stream) are dropped while
   * offline instead of queued — replaying a stale walk on reconnect would
   * only confuse the opponent.
   */
  send(message: ClientMessage, volatile = false): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else if (!volatile) {
      this.queue.push(message);
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}
