import type { PossessionController } from './PossessionController';

const JOYSTICK_RADIUS = 52;
const LOOK_SENSITIVITY = 0.0028;
/** Movement below this (px) on the look zone counts as a tap-to-possess. */
const TAP_SLOP_PX = 14;

/**
 * On-screen joystick, look zone, jump/duck buttons and pause for touch play.
 * Pointer lock is unreliable on mobile, so the controller runs in touch-engaged
 * mode instead.
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly lookZone: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly jumpBtn: HTMLButtonElement;
  private readonly duckBtn: HTMLButtonElement;
  private readonly pauseBtn: HTMLButtonElement;

  private joystickPointerId: number | null = null;
  private joystickOrigin = { x: 0, y: 0 };
  private lookPointerId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookMoved = false;

  /** Fired on a short tap in the look zone (possess a piece under the crosshair). */
  onTap: (() => void) | null = null;

  /** Fired when the player hits pause. */
  onPause: (() => void) | null = null;

  constructor(
    private readonly controller: PossessionController,
    root: HTMLElement,
  ) {
    this.root = root;
    this.lookZone = root.querySelector('#look-zone') as HTMLElement;
    this.stick = root.querySelector('#joystick-stick') as HTMLElement;
    this.jumpBtn = root.querySelector('#touch-jump') as HTMLButtonElement;
    this.duckBtn = root.querySelector('#touch-duck') as HTMLButtonElement;
    this.pauseBtn = root.querySelector('#touch-pause') as HTMLButtonElement;

    const joystickBase = root.querySelector('#joystick-base') as HTMLElement;

    joystickBase.addEventListener('pointerdown', this.onJoystickDown);
    this.lookZone.addEventListener('pointerdown', this.onLookDown);
    this.jumpBtn.addEventListener('pointerdown', this.onJump);
    this.duckBtn.addEventListener('pointerdown', this.onDuckDown);
    this.duckBtn.addEventListener('pointerup', this.onDuckUp);
    this.duckBtn.addEventListener('pointercancel', this.onDuckUp);
    this.pauseBtn.addEventListener('pointerdown', this.onPauseDown);

    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('blur', this.onWindowBlur);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.resetJoystick();
    this.controller.setTouchDuck(false);
  }

  dispose(): void {
    const joystickBase = this.root.querySelector('#joystick-base') as HTMLElement;
    joystickBase.removeEventListener('pointerdown', this.onJoystickDown);
    this.lookZone.removeEventListener('pointerdown', this.onLookDown);
    this.jumpBtn.removeEventListener('pointerdown', this.onJump);
    this.duckBtn.removeEventListener('pointerdown', this.onDuckDown);
    this.duckBtn.removeEventListener('pointerup', this.onDuckUp);
    this.duckBtn.removeEventListener('pointercancel', this.onDuckUp);
    this.pauseBtn.removeEventListener('pointerdown', this.onPauseDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('blur', this.onWindowBlur);
  }

  private onJoystickDown = (event: PointerEvent): void => {
    if (!this.controller.isActive) return;
    event.preventDefault();
    this.joystickPointerId = event.pointerId;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.joystickOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    this.updateJoystick(event.clientX, event.clientY);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  private onLookDown = (event: PointerEvent): void => {
    if (!this.controller.isActive) return;
    event.preventDefault();
    this.lookPointerId = event.pointerId;
    this.lookLast = { x: event.clientX, y: event.clientY };
    this.lookMoved = false;
    this.lookZone.setPointerCapture(event.pointerId);
  };

  private onJump = (event: PointerEvent): void => {
    if (!this.controller.isActive) return;
    event.preventDefault();
    this.controller.requestJump();
  };

  private onDuckDown = (event: PointerEvent): void => {
    if (!this.controller.isActive) return;
    event.preventDefault();
    this.controller.setTouchDuck(true);
  };

  private onDuckUp = (): void => {
    this.controller.setTouchDuck(false);
  };

  private onPauseDown = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.onPause?.();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId === this.joystickPointerId) {
      event.preventDefault();
      this.updateJoystick(event.clientX, event.clientY);
      return;
    }
    if (event.pointerId === this.lookPointerId) {
      event.preventDefault();
      const dx = event.clientX - this.lookLast.x;
      const dy = event.clientY - this.lookLast.y;
      if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) {
        this.lookMoved = true;
      }
      this.lookLast = { x: event.clientX, y: event.clientY };
      if (this.lookMoved) {
        this.controller.rotateLook(dx * LOOK_SENSITIVITY, dy * LOOK_SENSITIVITY);
      }
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.joystickPointerId) {
      this.resetJoystick();
      return;
    }
    if (event.pointerId === this.lookPointerId) {
      if (!this.lookMoved) this.onTap?.();
      this.lookPointerId = null;
      this.lookMoved = false;
    }
  };

  private onWindowBlur = (): void => {
    this.resetJoystick();
    this.controller.setTouchDuck(false);
    this.lookPointerId = null;
  };

  private updateJoystick(clientX: number, clientY: number): void {
    const dx = clientX - this.joystickOrigin.x;
    const dy = clientY - this.joystickOrigin.y;
    const dist = Math.hypot(dx, dy);
    const clamped = dist > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / dist : 1;
    const x = dx * clamped;
    const y = dy * clamped;
    this.stick.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    this.controller.setStickInput(x / JOYSTICK_RADIUS, -y / JOYSTICK_RADIUS);
  }

  private resetJoystick(): void {
    this.joystickPointerId = null;
    this.stick.style.transform = 'translate(0px, 0px)';
    this.controller.setStickInput(0, 0);
  }
}
