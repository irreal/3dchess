import { randomInt } from 'node:crypto';
import { GameRoom } from './GameRoom.js';

/** Unambiguous alphabet for invite codes (no 0/O or 1/I). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const DEFAULT_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

/** In-memory registry of running games, keyed by invite code. */
export class GameManager {
  private readonly games = new Map<string, GameRoom>();

  create(): GameRoom {
    const code = this.generateCode();
    const room = new GameRoom(code);
    this.games.set(code, room);
    return room;
  }

  get(code: string): GameRoom | undefined {
    return this.games.get(code.toUpperCase());
  }

  /** Drops games idle longer than `maxIdleMs`; returns the dropped codes. */
  sweep(maxIdleMs = DEFAULT_MAX_IDLE_MS): string[] {
    const now = Date.now();
    const removed: string[] = [];
    for (const [code, room] of this.games) {
      if (now - room.lastActivity > maxIdleMs) {
        this.games.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }

  private generateCode(): string {
    while (true) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
      if (!this.games.has(code)) return code;
    }
  }
}
