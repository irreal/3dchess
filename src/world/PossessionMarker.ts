import * as THREE from 'three';

const BOB_SPEED = 2.6; // rad/s of the hover bob
const BOB_AMPLITUDE = 0.08;
const SPIN_SPEED = 1.6; // rad/s spin around the vertical axis
const LEAP_ARC = 0.9; // extra height at the apex of a leap

interface Leap {
  from: THREE.Vector3;
  target: THREE.Object3D;
  hoverHeight: number;
  elapsed: number;
  duration: number;
  onArrive?: () => void;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Floating diamond that marks which piece the CPU's perspective currently
 * inhabits — the enemy counterpart of the player's first-person possession.
 * It hovers and bobs above the possessed piece, and can leap to another
 * piece along an arc, mirroring how the player jumps between pieces.
 */
export class PossessionMarker {
  readonly object: THREE.Group;

  private readonly gem: THREE.Mesh;
  private follow: THREE.Object3D | null = null;
  private hoverHeight = 2;
  private leap: Leap | null = null;
  private time = 0;

  private readonly tmpTo = new THREE.Vector3();

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'possession-marker';
    this.object.visible = false;

    // Downward-pointing four-sided cone, like a "you are here" gem.
    this.gem = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.38, 4),
      new THREE.MeshStandardMaterial({
        color: 0xff5544,
        emissive: 0xd92b1f,
        emissiveIntensity: 1.1,
        roughness: 0.35,
      }),
    );
    this.gem.rotation.x = Math.PI; // apex points down at the piece
    this.object.add(this.gem);
  }

  get isLeaping(): boolean {
    return this.leap !== null;
  }

  /** World position of the marker (for the off-screen HUD pointer). */
  get position(): THREE.Vector3 {
    return this.object.position;
  }

  /** Hover above a piece, tracking it as it moves. */
  setFollow(target: THREE.Object3D, hoverHeight: number): void {
    this.follow = target;
    this.hoverHeight = hoverHeight;
    if (!this.object.visible) {
      this.object.position.set(target.position.x, target.position.y + hoverHeight, target.position.z);
      this.object.visible = true;
    }
  }

  /** Fly along an arc to another piece, then follow it. */
  leapTo(target: THREE.Object3D, hoverHeight: number, onArrive?: () => void): void {
    this.follow = null;
    const from = this.object.position.clone();
    const distance = from.distanceTo(target.position);
    this.leap = {
      from,
      target,
      hoverHeight,
      elapsed: 0,
      duration: Math.min(1.1, 0.35 + distance * 0.05),
      onArrive,
    };
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
    this.follow = null;
    this.leap = null;
  }

  update(delta: number): void {
    if (!this.object.visible) return;

    this.time += delta;
    this.object.rotation.y += SPIN_SPEED * delta;
    this.gem.position.y = Math.sin(this.time * BOB_SPEED) * BOB_AMPLITUDE;

    if (this.leap) {
      const leap = this.leap;
      leap.elapsed += delta;
      const t = Math.min(1, leap.elapsed / leap.duration);
      const e = easeInOutQuad(t);

      // The destination piece may itself be drifting (crowd dodging), so the
      // landing spot is re-read every frame.
      const to = leap.target.position;
      this.tmpTo.set(to.x, to.y + leap.hoverHeight, to.z);
      this.object.position.lerpVectors(leap.from, this.tmpTo, e);
      this.object.position.y += Math.sin(Math.PI * e) * LEAP_ARC;

      if (t >= 1) {
        this.leap = null;
        this.setFollow(leap.target, leap.hoverHeight);
        leap.onArrive?.();
      }
      return;
    }

    if (this.follow) {
      const p = this.follow.position;
      this.object.position.set(p.x, p.y + this.hoverHeight, p.z);
    }
  }
}
