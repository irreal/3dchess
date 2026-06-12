import * as THREE from 'three';

const GRAVITY = 22; // gamey gravity: snappier than Earth's
const FAST_FALL_GRAVITY = 44; // holding duck mid-air slams the piece down
const JUMP_SPEED = 6.5; // apex ≈ 0.96 m, airtime ≈ 0.6 s
const DUCK_JUMP_BONUS = 1.3; // jumping out of a crouch springs higher

const DUCK_SCALE_Y = 0.55;

/** Underdamped spring on the vertical scale: everything wobbles to rest. */
const SPRING_STIFFNESS = 110;
const SPRING_DAMPING = 11;
const MAX_SUBSTEP = 1 / 50; // keeps the spring integration stable

const RISE_STRETCH = 0.05; // vertical stretch per m/s of airborne speed
const TAKEOFF_KICK = 2.2; // scale-velocity impulse on take-off
const LAND_KICK_PER_SPEED = -0.35; // squash impulse per m/s of landing speed

const MIN_SCALE_Y = 0.4;
const MAX_SCALE_Y = 1.45;

/**
 * Squash-and-stretch acrobatics for one possessed piece: jumping (with
 * anticipation kick, airborne stretch and a springy landing splat) and
 * ducking (a chunky crouch). Purely cosmetic — drives the group's vertical
 * position and scale, nothing else. Used for the player's own piece and to
 * replay the online friend's antics from the presence stream.
 */
export class PieceAntics {
  private group: THREE.Group | null = null;

  private y = 0;
  private velocityY = 0;
  private airborne = false;
  private ducking = false;

  private scaleY = 1;
  private scaleVelocity = 0;

  /** Bumped on every take-off; streamed so the friend's client replays it. */
  jumpCount = 0;

  /** Current jump height (m), for the first-person camera. */
  get height(): number {
    return this.y;
  }

  /** Current vertical scale factor, for the first-person eye height. */
  get verticalScale(): number {
    return this.scaleY;
  }

  get isDucking(): boolean {
    return this.ducking;
  }

  /** The piece this instance animates; switching restores the old one. */
  attach(group: THREE.Group | null): void {
    if (group === this.group) return;
    this.reset();
    this.group = group;
  }

  jump(): void {
    if (this.airborne || !this.group) return;
    this.velocityY = JUMP_SPEED * (this.ducking ? DUCK_JUMP_BONUS : 1);
    this.airborne = true;
    this.scaleVelocity += TAKEOFF_KICK;
    this.jumpCount++;
  }

  setDuck(ducking: boolean): void {
    this.ducking = ducking;
  }

  update(delta: number): void {
    if (!this.group) return;

    let remaining = delta;
    while (remaining > 0) {
      const step = Math.min(remaining, MAX_SUBSTEP);
      remaining -= step;
      this.step(step);
    }

    // Conserve silhouette: thinner when stretched, wider when squashed.
    const widen = 1 / Math.sqrt(this.scaleY);
    this.group.scale.set(widen, this.scaleY, widen);
    this.group.position.y = this.y;
  }

  private step(delta: number): void {
    if (this.airborne) {
      const gravity = this.ducking ? FAST_FALL_GRAVITY : GRAVITY;
      this.velocityY -= gravity * delta;
      this.y += this.velocityY * delta;
      if (this.y <= 0) {
        this.y = 0;
        this.airborne = false;
        // Landing splat proportional to impact speed.
        this.scaleVelocity += LAND_KICK_PER_SPEED * Math.abs(this.velocityY);
        this.velocityY = 0;
      }
    }

    // Pose target the spring chases: crouched, airborne-stretched, or normal.
    let target = 1;
    if (this.airborne) {
      target = 1 + Math.abs(this.velocityY) * RISE_STRETCH;
    } else if (this.ducking) {
      target = DUCK_SCALE_Y;
    }

    // Semi-implicit Euler keeps the underdamped spring stable.
    this.scaleVelocity += (target - this.scaleY) * SPRING_STIFFNESS * delta;
    this.scaleVelocity *= Math.exp(-SPRING_DAMPING * delta);
    this.scaleY = THREE.MathUtils.clamp(
      this.scaleY + this.scaleVelocity * delta,
      MIN_SCALE_Y,
      MAX_SCALE_Y,
    );
  }

  /** Restore the attached piece to its neutral pose and zero all state. */
  reset(): void {
    if (this.group) {
      this.group.scale.set(1, 1, 1);
      this.group.position.y = 0;
    }
    this.y = 0;
    this.velocityY = 0;
    this.airborne = false;
    this.ducking = false;
    this.scaleY = 1;
    this.scaleVelocity = 0;
  }
}
