import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { PLAYER_EYE_HEIGHT } from '../constants';

const WALK_SPEED = 4; // m/s
const RUN_SPEED = 8; // m/s
const ACCELERATION = 40; // how quickly we reach target speed
const DAMPING = 12; // how quickly we stop

/**
 * Pointer-lock based first person controller with WASD movement,
 * smooth acceleration/damping and a fixed eye height.
 */
export class FirstPersonController {
  private readonly controls: PointerLockControls;
  private readonly velocity = new THREE.Vector3();
  private readonly keys = new Set<string>();

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

  lock(): void {
    this.controls.lock();
  }

  addEventListener(type: 'lock' | 'unlock', listener: () => void): void {
    this.controls.addEventListener(type, listener);
  }

  update(delta: number): void {
    if (!this.controls.isLocked) {
      // Bleed off any residual velocity while unlocked.
      this.velocity.set(0, 0, 0);
      return;
    }

    const input = this.getMoveInput();
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;

    // Accelerate toward the desired velocity, damp toward zero otherwise.
    const targetX = input.x * speed;
    const targetZ = input.y * speed;
    const rate = input.lengthSq() > 0 ? ACCELERATION : DAMPING;
    const t = Math.min(1, rate * delta);

    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, targetX, t);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, targetZ, t);

    this.controls.moveRight(this.velocity.x * delta);
    this.controls.moveForward(this.velocity.z * delta);

    // Keep the player on the ground plane.
    this.camera.position.y = PLAYER_EYE_HEIGHT;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.controls.dispose();
  }

  /** Returns normalized input where x = strafe (right+), y = forward (+). */
  private getMoveInput(): THREE.Vector2 {
    const input = new THREE.Vector2();

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) input.y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) input.y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) input.x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) input.x -= 1;

    if (input.lengthSq() > 1) input.normalize();
    return input;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onWindowBlur = (): void => {
    this.keys.clear();
  };
}
