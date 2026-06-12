import * as THREE from 'three';

/** Screen size (m); 4:3 like most webcams. */
const SCREEN_WIDTH = 0.84;
const SCREEN_HEIGHT = 0.63;
const FRAME_PADDING = 0.05;

/** How far in front of the possessed piece the screen floats. */
const FORWARD_OFFSET = 0.62;
/** Lift above the piece's eye height, so it reads as a floating projection. */
const LIFT = 0.28;

/**
 * The friendly cartoon face shown while the friend's camera is off or the
 * call never connected, so the screen stays expressive instead of going dark.
 */
function createPlaceholderTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 384; // matches the screen's 4:3
  const ctx = canvas.getContext('2d')!;

  const backdrop = ctx.createLinearGradient(0, 0, 0, canvas.height);
  backdrop.addColorStop(0, '#2b3440');
  backdrop.addColorStop(1, '#181f27');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Head
  ctx.fillStyle = '#ffd166';
  ctx.strokeStyle = '#e0a33c';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Eyes with glints
  for (const dx of [-45, 45]) {
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath();
    ctx.ellipse(cx + dx, cy - 28, 13, 19, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx + dx + 4, cy - 34, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Blush
  ctx.fillStyle = 'rgba(235, 110, 80, 0.35)';
  for (const dx of [-72, 72]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx, cy + 20, 18, 11, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Smile
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy + 14, 58, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The online friend's webcam, projected on a small screen floating in front
 * of the piece they possess. The screen orbits the piece following their
 * streamed look yaw, so when their face is pointing at you, they are
 * actually looking at you in their game. Without a video stream the screen
 * shows a cartoon face instead, so the friend stays embodied either way.
 */
export class FaceScreen {
  readonly object = new THREE.Group();

  private readonly video: HTMLVideoElement;
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private readonly placeholder: THREE.CanvasTexture;
  private texture: THREE.VideoTexture | null = null;
  private stream: MediaStream | null = null;

  constructor() {
    this.object.name = 'face-screen';
    this.object.visible = false;

    const frame = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN_WIDTH + FRAME_PADDING * 2, SCREEN_HEIGHT + FRAME_PADDING * 2),
      new THREE.MeshBasicMaterial({ color: 0x10151a, side: THREE.DoubleSide }),
    );
    frame.position.z = -0.012; // sits just behind the screen, doubles as its back

    this.placeholder = createPlaceholderTexture();
    this.screenMaterial = new THREE.MeshBasicMaterial({ map: this.placeholder });
    this.screenMaterial.toneMapped = false; // keep the video's true colors
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN_WIDTH, SCREEN_HEIGHT),
      this.screenMaterial,
    );

    this.object.add(frame, screen);

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  setStream(stream: MediaStream | null): void {
    if (stream === this.stream) return;
    this.stream = stream;

    this.texture?.dispose();
    this.texture = null;

    if (stream) {
      this.video.srcObject = stream;
      void this.video.play().catch(() => {});
      this.texture = new THREE.VideoTexture(this.video);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.screenMaterial.map = this.texture;
    } else {
      this.video.srcObject = null;
      this.screenMaterial.map = this.placeholder;
    }
    this.screenMaterial.needsUpdate = true;
  }

  /**
   * Park the screen in front of the piece, orbited to the given yaw and
   * facing the same way, riding the piece's jumps via its live position.
   */
  updatePose(piecePosition: THREE.Vector3, eyeHeight: number, yaw: number): void {
    this.object.position.set(
      piecePosition.x + Math.sin(yaw) * FORWARD_OFFSET,
      piecePosition.y + eyeHeight + LIFT,
      piecePosition.z + Math.cos(yaw) * FORWARD_OFFSET,
    );
    this.object.rotation.y = yaw;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }
}
