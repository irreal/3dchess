/// <reference lib="webworker" />
import { ai } from 'js-chess-engine';
import type { AILevel } from 'js-chess-engine';

export interface AiRequest {
  id: number;
  fen: string;
  level: AILevel;
}

export type AiResponse =
  | { id: number; from: string; to: string }
  | { id: number; error: string };

/**
 * Runs the js-chess-engine search off the main thread so deeper difficulty
 * levels never freeze the render loop, audio, or input. Replies with the
 * chosen move as plain from/to squares for the host to apply via chess.js.
 */
self.onmessage = (event: MessageEvent<AiRequest>) => {
  const { id, fen, level } = event.data;
  try {
    const result = ai(fen, { level, play: false });
    const entry = Object.entries(result.move)[0];
    if (!entry) {
      (self as DedicatedWorkerGlobalScope).postMessage({ id, error: 'no move' } satisfies AiResponse);
      return;
    }
    const [from, to] = entry;
    (self as DedicatedWorkerGlobalScope).postMessage({ id, from, to } satisfies AiResponse);
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies AiResponse);
  }
};
