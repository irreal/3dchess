/**
 * Looping background music, kept quiet so it sits under gameplay and never
 * competes with the players' voices on a call. Browsers block audio until a
 * user gesture, so playback starts on the first pointer/key interaction.
 *
 * The track ("The Patient Move") lives in `public/audio/` and is served by Vite.
 */
export class BackgroundMusic {
  private readonly audio = new Audio('audio/the-patient-move.mp3');

  /** Quiet by default; ducked further while a voice call is active. */
  private readonly baseVolume = 0.14;
  private readonly duckedVolume = 0.045;

  private started = false;
  private ducked = false;
  private fadeHandle: number | null = null;
  private readonly tryStart = (): void => this.start();

  constructor() {
    this.audio.loop = true;
    this.audio.preload = 'auto';
    this.audio.volume = this.baseVolume;

    window.addEventListener('pointerdown', this.tryStart);
    window.addEventListener('keydown', this.tryStart);
  }

  /** Attempt playback; retries on the next gesture if the browser blocks it. */
  start(): void {
    if (this.started) return;
    void this.audio
      .play()
      .then(() => {
        this.started = true;
        window.removeEventListener('pointerdown', this.tryStart);
        window.removeEventListener('keydown', this.tryStart);
      })
      .catch(() => {
        /* Still blocked — keep the gesture listeners armed for the next try. */
      });
  }

  /** Lower the music while players are talking so they can hear each other. */
  setDucked(ducked: boolean): void {
    if (ducked === this.ducked) return;
    this.ducked = ducked;
    this.fadeTo(ducked ? this.duckedVolume : this.baseVolume);
  }

  private fadeTo(target: number): void {
    if (this.fadeHandle !== null) cancelAnimationFrame(this.fadeHandle);
    const from = this.audio.volume;
    const duration = 400;
    const start = performance.now();

    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      this.audio.volume = from + (target - from) * t;
      if (t < 1) {
        this.fadeHandle = requestAnimationFrame(step);
      } else {
        this.fadeHandle = null;
      }
    };
    this.fadeHandle = requestAnimationFrame(step);
  }
}
