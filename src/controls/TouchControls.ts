import type { PossessionController } from './PossessionController';

const JOYSTICK_RADIUS = 52;

interface JoystickSlot {
  pointerId: number | null;
  origin: { x: number; y: number };
  base: HTMLElement;
  stick: HTMLElement;
  setInput: (x: number, y: number) => void;
}

/**
 * Twin joysticks (move + look) plus action buttons for touch play. Pointer
 * lock is unreliable on mobile, so the controller runs in touch-engaged mode
 * instead. Possessing pieces and committing moves happens through the
 * on-screen contextual action button (owned by Game), not by tapping the
 * screen — a stray tap on joystick release used to fire an unwanted action.
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly moveJoy: JoystickSlot;
  private readonly lookJoy: JoystickSlot;
  private readonly jumpBtn: HTMLButtonElement;
  private readonly duckBtn: HTMLButtonElement;
  private readonly pauseBtn: HTMLButtonElement;

  private readonly onMoveJoyDown: (event: PointerEvent) => void;
  private readonly onLookJoyDown: (event: PointerEvent) => void;

  /** Fired when the player hits pause. */
  onPause: (() => void) | null = null;

  constructor(
    private readonly controller: PossessionController,
    root: HTMLElement,
  ) {
    this.root = root;

    const moveBase = root.querySelector('#move-joystick .joystick-base') as HTMLElement;
    const moveStick = root.querySelector('#move-joystick .joystick-stick') as HTMLElement;
    const lookBase = root.querySelector('#look-joystick .joystick-base') as HTMLElement;
    const lookStick = root.querySelector('#look-joystick .joystick-stick') as HTMLElement;

    this.moveJoy = {
      pointerId: null,
      origin: { x: 0, y: 0 },
      base: moveBase,
      stick: moveStick,
      setInput: (x, y) => this.controller.setStickInput(x, y),
    };
    this.lookJoy = {
      pointerId: null,
      origin: { x: 0, y: 0 },
      base: lookBase,
      stick: lookStick,
      setInput: (x, y) => this.controller.setLookInput(x, y),
    };

    this.jumpBtn = root.querySelector('#touch-jump') as HTMLButtonElement;
    this.duckBtn = root.querySelector('#touch-duck') as HTMLButtonElement;
    this.pauseBtn = root.querySelector('#touch-pause') as HTMLButtonElement;

    this.onMoveJoyDown = (event) => this.onJoystickDown(event, this.moveJoy);
    this.onLookJoyDown = (event) => this.onJoystickDown(event, this.lookJoy);
    moveBase.addEventListener('pointerdown', this.onMoveJoyDown);
    lookBase.addEventListener('pointerdown', this.onLookJoyDown);
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
    this.resetJoystick(this.moveJoy);
    this.resetJoystick(this.lookJoy);
    this.controller.setTouchDuck(false);
  }

  dispose(): void {
    this.moveJoy.base.removeEventListener('pointerdown', this.onMoveJoyDown);
    this.lookJoy.base.removeEventListener('pointerdown', this.onLookJoyDown);
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

  private onJoystickDown(event: PointerEvent, slot: JoystickSlot): void {
    if (!this.controller.isActive) return;
    event.preventDefault();
    slot.pointerId = event.pointerId;
    const rect = slot.base.getBoundingClientRect();
    slot.origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    this.updateJoystick(event.clientX, event.clientY, slot);
    slot.base.setPointerCapture(event.pointerId);
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
    if (event.pointerId === this.moveJoy.pointerId) {
      event.preventDefault();
      this.updateJoystick(event.clientX, event.clientY, this.moveJoy);
      return;
    }
    if (event.pointerId === this.lookJoy.pointerId) {
      event.preventDefault();
      this.updateJoystick(event.clientX, event.clientY, this.lookJoy);
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.moveJoy.pointerId) {
      this.resetJoystick(this.moveJoy);
      return;
    }
    if (event.pointerId === this.lookJoy.pointerId) {
      this.resetJoystick(this.lookJoy);
    }
  };

  private onWindowBlur = (): void => {
    this.resetJoystick(this.moveJoy);
    this.resetJoystick(this.lookJoy);
    this.controller.setTouchDuck(false);
  };

  private updateJoystick(clientX: number, clientY: number, slot: JoystickSlot): void {
    const dx = clientX - slot.origin.x;
    const dy = clientY - slot.origin.y;
    const dist = Math.hypot(dx, dy);
    const clamped = dist > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / dist : 1;
    const x = dx * clamped;
    const y = dy * clamped;
    slot.stick.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    slot.setInput(x / JOYSTICK_RADIUS, -y / JOYSTICK_RADIUS);
  }

  private resetJoystick(slot: JoystickSlot): void {
    slot.pointerId = null;
    slot.stick.style.transform = 'translate(0px, 0px)';
    slot.setInput(0, 0);
  }
}
