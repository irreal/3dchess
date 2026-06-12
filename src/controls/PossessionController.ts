import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import type { Move } from '../chess/types';
import { positionAt, tangentAt, type Corridor, type RestPoint } from './corridors';

const GLIDE_SPEED = 3.4; // m/s while walking a corridor
const RETURN_SPEED = 9; // m/s while retreating to the origin square
const REST_SNAP_RADIUS = 0.45; // counts as "resting on" a legal square
const ENTER_SNAP_RADIUS = 0.85; // Enter confirms the nearest square within this
const DWELL_COMMIT_SECONDS = 1.4; // resting this long confirms the move
const SETTLE_RATE = 6; // how quickly we center on a square while resting
const EYE_LERP_RATE = 5; // eye height blend (e.g. growing after promotion)
const MIN_DIR_ALIGNMENT = 0.2; // how aligned input must be to enter a corridor
const FULL_SPEED_ALIGNMENT = 0.7; // input within ~45° of the rail glides at full speed
const HUB_SNAP_RADIUS = 0.6; // near the origin square, mismatched input settles back
const CORNER_EPS = 0.02; // probe distance around corridor corners
const HIDE_DISTANCE = 1.0; // hide the target piece when the camera is this close

/** The piece the player currently inhabits (or is flying toward). */
export interface PossessTarget {
  coord: string;
  group: THREE.Group;
  eyeHeight: number;
}

interface Transition {
  from: THREE.Vector3;
  to: THREE.Vector3;
  target: PossessTarget;
  elapsed: number;
  duration: number;
  arcHeight: number;
  hidden: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * First-person "you are the piece" controller. The camera lives inside the
 * possessed piece; the player can look around freely, leap into another
 * friendly piece, and move the possessed piece along corridors built from
 * its legal moves. Resting on a legal square (or pressing Enter near one)
 * commits the move via {@link onCommitMove}.
 */
export class PossessionController {
  private readonly controls: PointerLockControls;
  private readonly keys = new Set<string>();

  private possessed: PossessTarget | null = null;
  private transition: Transition | null = null;

  private corridors: Corridor[] = [];
  private active: Corridor | null = null;
  private dist = 0;
  private dwell = 0;
  private returning = false;
  private wantCommit = false;
  private eyeHeight = 1.7;
  private readonly basePos = new THREE.Vector3();

  /** Fired when the possessed piece confirms a move. */
  onCommitMove: ((move: Move) => void) | null = null;

  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpAlt = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpDesired = new THREE.Vector3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.controls = new PointerLockControls(camera, domElement);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
  }

  get isLocked(): boolean {
    return this.controls.isLocked;
  }

  get isTransitioning(): boolean {
    return this.transition !== null;
  }

  /** 0..1 progress of the rest-to-confirm timer, for the HUD ring. */
  get dwellProgress(): number {
    return this.active ? Math.min(1, this.dwell / DWELL_COMMIT_SECONDS) : 0;
  }

  lock(): void {
    this.controls.lock();
  }

  addEventListener(type: 'lock' | 'unlock', listener: () => void): void {
    this.controls.addEventListener(type, listener);
  }

  /** Enter a piece: instantly, or by flying out of the current one. */
  possess(target: PossessTarget, instant: boolean): void {
    // Abort an in-flight transition.
    if (this.transition) {
      this.transition.target.group.visible = true;
      this.transition = null;
    }

    // Leave the current piece: put it back on its square and show it again.
    if (this.possessed) {
      this.possessed.group.visible = true;
      this.possessed.group.position.set(this.basePos.x, 0, this.basePos.z);
      this.possessed = null;
    }

    this.corridors = [];
    this.resetTraversal();

    if (instant) {
      this.finalizePossess(target);
      return;
    }

    const to = new THREE.Vector3(target.group.position.x, target.eyeHeight, target.group.position.z);
    const distance = this.camera.position.distanceTo(to);
    this.transition = {
      from: this.camera.position.clone(),
      to,
      target,
      elapsed: 0,
      duration: Math.min(1.1, 0.35 + distance * 0.05),
      arcHeight: Math.min(1.6, distance * 0.12),
      hidden: false,
    };
  }

  /** Replace the rails the piece may move along (built from its legal moves). */
  setCorridors(corridors: Corridor[]): void {
    this.corridors = corridors;
    this.resetTraversal();
  }

  /**
   * Keep the possessed mesh reference fresh (promotion swaps the group) and
   * track eye-height changes. Call once per frame.
   */
  syncPossessed(group: THREE.Group, eyeHeight: number): void {
    if (!this.possessed || this.transition) return;
    if (group !== this.possessed.group) {
      this.possessed.group = group;
      group.visible = false;
    }
    this.possessed.eyeHeight = eyeHeight;
  }

  /** Glide back to the origin square, abandoning the move in progress. */
  cancelGlide(): void {
    if (this.active) this.returning = true;
  }

  update(delta: number): void {
    if (this.transition) {
      this.updateTransition(delta);
      return;
    }

    const possessed = this.possessed;
    if (!possessed) return;

    this.eyeHeight = THREE.MathUtils.lerp(
      this.eyeHeight,
      possessed.eyeHeight,
      Math.min(1, EYE_LERP_RATE * delta),
    );

    if (this.controls.isLocked) {
      this.updateTraversal(delta);
    } else {
      this.dwell = 0;
      this.wantCommit = false;
    }

    // Glue the piece and the camera to the spot on (or off) the corridor.
    const pos = this.active
      ? positionAt(this.active, this.dist, this.tmpPos)
      : this.tmpPos.copy(this.basePos);
    possessed.group.position.x = pos.x;
    possessed.group.position.z = pos.z;
    this.camera.position.set(pos.x, this.eyeHeight, pos.z);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.controls.dispose();
  }

  private updateTraversal(delta: number): void {
    const desired = this.desiredDirection();
    let moved = 0;

    if (this.returning && this.active) {
      const prev = this.dist;
      this.dist = Math.max(0, this.dist - RETURN_SPEED * delta);
      moved = prev - this.dist;
      if (this.dist === 0) {
        this.active = null;
        this.returning = false;
      }
    } else if (this.active) {
      // Probe the tangent just ahead and just behind so L-shaped knight
      // corridors corner correctly: advancing needs input along the next
      // segment, backing up needs input against the previous one.
      let ahead = 0;
      let aheadCorridor = this.active;
      if (desired) {
        ahead = Math.max(0, desired.dot(tangentAt(this.active, this.dist + CORNER_EPS, this.tmpDir)));

        // Several corridors can share a prefix — e.g. the knight paths
        // b8-b6-a6 and b8-b6-c6 both run through the b6 elbow. While on a
        // shared section, follow the branch that best matches the input.
        const here = positionAt(this.active, this.dist, this.tmpPos);
        for (const corridor of this.corridors) {
          if (corridor === this.active || corridor.length < this.dist - 1e-6) continue;
          if (positionAt(corridor, this.dist, this.tmpAlt).distanceToSquared(here) > 1e-6) continue;
          const dot = desired.dot(tangentAt(corridor, this.dist + CORNER_EPS, this.tmpDir));
          if (dot > ahead) {
            ahead = dot;
            aheadCorridor = corridor;
          }
        }
      }
      const behind = desired
        ? Math.min(0, desired.dot(tangentAt(this.active, this.dist - CORNER_EPS, this.tmpDir)))
        : 0;

      // Don't punish slightly misaligned input with a crawl: anything within
      // ~45 degrees of the rail glides at full speed.
      let velocity: number;
      if (ahead >= -behind) {
        this.active = aheadCorridor;
        velocity = Math.min(1, ahead / FULL_SPEED_ALIGNMENT);
      } else {
        velocity = Math.max(-1, behind / FULL_SPEED_ALIGNMENT);
      }

      const prev = this.dist;
      this.dist = THREE.MathUtils.clamp(this.dist + velocity * GLIDE_SPEED * delta, 0, this.active.length);

      // Input pointing away from this rail while still next to the origin
      // square: settle back onto it so the corridor the player actually
      // wants can take over on a following frame.
      if (velocity === 0 && desired && this.dist < HUB_SNAP_RADIUS) {
        this.dist = Math.max(0, this.dist - RETURN_SPEED * delta);
      }

      moved = Math.abs(this.dist - prev);
      if (this.dist === 0) this.active = null;
    } else if (desired) {
      // At the origin square: enter the corridor best aligned with the input.
      let best: Corridor | null = null;
      let bestDot = MIN_DIR_ALIGNMENT;
      for (const corridor of this.corridors) {
        const dot = desired.dot(tangentAt(corridor, CORNER_EPS, this.tmpDir));
        if (dot > bestDot) {
          bestDot = dot;
          best = corridor;
        }
      }
      this.active = best;
    }

    if (!this.active) {
      this.dwell = 0;
      this.wantCommit = false;
      return;
    }

    const rest = this.nearestRest(this.active, this.dist);
    const offset = rest ? Math.abs(rest.dist - this.dist) : Infinity;

    if (rest && this.wantCommit && offset <= ENTER_SNAP_RADIUS) {
      this.commit(this.active, rest);
    } else if (rest && offset <= REST_SNAP_RADIUS && moved < 1e-5) {
      // Settle onto the square center while the confirm timer runs.
      this.dist = THREE.MathUtils.lerp(this.dist, rest.dist, Math.min(1, SETTLE_RATE * delta));
      this.dwell += delta;
      if (this.dwell >= DWELL_COMMIT_SECONDS) this.commit(this.active, rest);
    } else {
      this.dwell = 0;
    }
    this.wantCommit = false;
  }

  private commit(corridor: Corridor, rest: RestPoint): void {
    positionAt(corridor, rest.dist, this.tmpPos);
    this.basePos.set(this.tmpPos.x, 0, this.tmpPos.z);
    this.possessed?.group.position.set(this.tmpPos.x, 0, this.tmpPos.z);

    this.corridors = [];
    this.resetTraversal();
    this.onCommitMove?.(rest.move);
  }

  private updateTransition(delta: number): void {
    const transition = this.transition;
    if (!transition) return;

    transition.elapsed += delta;
    const t = Math.min(1, transition.elapsed / transition.duration);
    const e = easeInOutQuad(t);

    this.camera.position.lerpVectors(transition.from, transition.to, e);
    this.camera.position.y += Math.sin(Math.PI * e) * transition.arcHeight;

    if (!transition.hidden && this.camera.position.distanceTo(transition.to) < HIDE_DISTANCE) {
      transition.target.group.visible = false;
      transition.hidden = true;
    }

    if (t >= 1) {
      this.transition = null;
      this.finalizePossess(transition.target);
    }
  }

  private finalizePossess(target: PossessTarget): void {
    this.possessed = target;
    target.group.visible = false;
    this.basePos.set(target.group.position.x, 0, target.group.position.z);
    this.eyeHeight = target.eyeHeight;
    this.camera.position.set(this.basePos.x, this.eyeHeight, this.basePos.z);
  }

  private resetTraversal(): void {
    this.active = null;
    this.dist = 0;
    this.dwell = 0;
    this.returning = false;
    this.wantCommit = false;
  }

  /** Camera-relative WASD input projected onto the board plane, or null. */
  private desiredDirection(): THREE.Vector3 | null {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (x === 0 && y === 0) return null;

    this.camera.getWorldDirection(this.tmpForward);
    this.tmpForward.y = 0;
    if (this.tmpForward.lengthSq() < 1e-6) return null;
    this.tmpForward.normalize();
    this.tmpRight.crossVectors(this.tmpForward, UP); // forward x up = right

    return this.tmpDesired
      .set(0, 0, 0)
      .addScaledVector(this.tmpForward, y)
      .addScaledVector(this.tmpRight, x)
      .normalize();
  }

  private nearestRest(corridor: Corridor, dist: number): RestPoint | null {
    let best: RestPoint | null = null;
    let bestOffset = Infinity;
    for (const rest of corridor.restPoints) {
      const offset = Math.abs(rest.dist - dist);
      if (offset < bestOffset) {
        bestOffset = offset;
        best = rest;
      }
    }
    return best;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
    if (event.code === 'Enter' && this.controls.isLocked) {
      this.wantCommit = true;
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onWindowBlur = (): void => {
    this.keys.clear();
  };
}
