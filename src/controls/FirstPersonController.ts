import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { PLAYER_EYE_HEIGHT } from '../constants';

const WALK_SPEED = 4; // m/s
const RUN_SPEED = 8; // m/s
const CROUCH_SPEED_FACTOR = 0.5;
const ACCELERATION = 40; // how quickly we reach target speed
const DAMPING = 12; // how quickly we stop

const CROUCH_EYE_HEIGHT = 1.0;
const CROUCH_LERP_RATE = 10; // how quickly we duck/stand back up
const JUMP_SPEED = 5.2; // m/s, ~0.75m jump height
const GRAVITY = 18; // m/s^2, slightly arcade-y for a snappier jump

/**
 * Pointer-lock based first person controller with WASD movement,
 * smooth acceleration/damping, crouching (Ctrl) and jumping (Space).
 */
export class FirstPersonController {
  private readonly controls: PointerLockControls;
  private readonly velocity = new THREE.Vector3();
  private readonly keys = new Set<string>();

  private eyeHeight = PLAYER_EYE_HEIGHT; // smoothed crouch/stand height
  private jumpOffset = 0; // height above the ground due to jumping
  private verticalVelocity = 0;

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
      this.verticalVelocity = 0;
      this.jumpOffset = 0;
      return;
    }

    const input = this.getMoveInput();
    const crouching = this.keys.has('ControlLeft') || this.keys.has('ControlRight');
    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    let speed = running ? RUN_SPEED : WALK_SPEED;
    if (crouching) speed *= CROUCH_SPEED_FACTOR;

    // Accelerate toward the desired velocity, damp toward zero otherwise.
    const targetX = input.x * speed;
    const targetZ = input.y * speed;
    const rate = input.lengthSq() > 0 ? ACCELERATION : DAMPING;
    const t = Math.min(1, rate * delta);

    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, targetX, t);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, targetZ, t);

    this.controls.moveRight(this.velocity.x * delta);
    this.controls.moveForward(this.velocity.z * delta);

    // Jumping: simple vertical physics on top of the eye height.
    const grounded = this.jumpOffset === 0;
    if (grounded && !crouching && this.keys.has('Space')) {
      this.verticalVelocity = JUMP_SPEED;
      this.jumpOffset = Number.EPSILON; // leave the ground this frame
    }
    if (this.jumpOffset > 0) {
      this.verticalVelocity -= GRAVITY * delta;
      this.jumpOffset += this.verticalVelocity * delta;
      if (this.jumpOffset <= 0) {
        this.jumpOffset = 0;
        this.verticalVelocity = 0;
      }
    }

    // Crouching: smoothly duck toward the lower eye height and back.
    const targetEyeHeight = crouching ? CROUCH_EYE_HEIGHT : PLAYER_EYE_HEIGHT;
    this.eyeHeight = THREE.MathUtils.lerp(
      this.eyeHeight,
      targetEyeHeight,
      Math.min(1, CROUCH_LERP_RATE * delta),
    );

    this.camera.position.y = this.eyeHeight + this.jumpOffset;
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
