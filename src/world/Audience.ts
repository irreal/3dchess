import * as THREE from 'three';
import { BOARD_SIZE, BORDER_WIDTH, GROUND_Y } from '../constants';
import { PieceFactory, type PieceColor } from './PieceFactory';

/**
 * Looping clips bundled in `public/gifs/` that play on the crowd's billboards
 * (converted from GIFs to compressed h264 mp4 so they animate as video
 * textures). Vite serves the `public/` folder at the site root, so these are
 * referenced by relative path (URL-encoded to survive the spaces in their
 * names).
 */
const CLIP_FILES = [
  'Chess Boardgames GIF by NETFLIX.mp4',
  'Chess Gif Edit GIF.mp4',
  'Chess GIF.mp4',
  'Comedy Chess GIF.mp4',
  'Gothamchess GIF.mp4',
  'Happy Well Done GIF by Chess.com.mp4',
  'Magnus Carlsen Chess GIF by TeamLiquid.mp4',
  'Magnus Carlsen Chess GIF.mp4',
  'Smirk Chess GIF.mp4',
  'Spin Chess GIF by Feliks Tomasz Konczakowski.mp4',
  'winning independence day GIF by IFC.mp4',
];

/** Crowd layout: tiered rows of pawns down each long side of the board. */
const ROWS = 2;
const SEATS = 10;
const SEAT_SPACING = 1.7;
const TIER_STEP = 0.85; // vertical rise per row, stadium-style
const BASE_LIFT = 0.12; // keeps the lowest platform above the ground (avoids z-fighting)
const FIRST_ROW_GAP = 2.6; // distance from the board edge to the first row
const ROW_GAP = 2.4; // distance between rows

/** Billboard floating in front of each pawn's face. */
const SCREEN_W = 1.0;
const SCREEN_H = 0.75;
const SCREEN_FRAME = 0.05;
const FACE_HEIGHT = 1.05; // above the pawn's feet
const SCREEN_FORWARD = 0.5; // toward the board

const PLACEHOLDER_EMOJI = ['🎉', '🔥', '👑', '😎', '🤯', '🥳', '💥', '✨', '🏆', '♟️'];
const PLACEHOLDER_BG: [string, string][] = [
  ['#7c3aed', '#312e81'],
  ['#db2777', '#7f1d34'],
  ['#0891b2', '#0c4a6e'],
  ['#ea580c', '#7c2d12'],
  ['#16a34a', '#14532d'],
  ['#eab308', '#854d0e'],
];

interface Billboard {
  group: THREE.Group;
  material: THREE.MeshBasicMaterial;
  baseY: number;
  phase: number;
}

/**
 * A crowd of pawn spectators lining both sides of the board, each with a
 * little screen floating in front of its face — mirroring the player's own
 * face screen. The screens loop chess clips bundled in `public/gifs/` (shared
 * across the crowd from a small pool), falling back to colorful placeholders
 * until the clips start playing.
 */
export class Audience {
  readonly object = new THREE.Group();

  private readonly factory = new PieceFactory();
  private readonly billboards: Billboard[] = [];
  private readonly screenGeometry = new THREE.PlaneGeometry(SCREEN_W, SCREEN_H);
  private readonly frameGeometry = new THREE.PlaneGeometry(
    SCREEN_W + SCREEN_FRAME * 2,
    SCREEN_H + SCREEN_FRAME * 2,
  );
  private readonly videos: HTMLVideoElement[] = [];
  private elapsed = 0;

  constructor() {
    this.object.name = 'audience';

    this.buildStands();
    // Show placeholders immediately, then upgrade to clips once they load.
    this.assignScreens(this.buildPlaceholderPool());
    this.loadClipScreens();
  }

  /** Gentle floating bob so the screens feel alive. */
  update(delta: number): void {
    this.elapsed += delta;
    for (const board of this.billboards) {
      board.group.position.y = board.baseY + Math.sin(this.elapsed * 1.5 + board.phase) * 0.04;
    }
  }

  private buildStands(): void {
    const halfBoard = BOARD_SIZE / 2 + BORDER_WIDTH;
    const riserMaterial = new THREE.MeshStandardMaterial({
      color: 0x3a4252,
      roughness: 0.9,
      metalness: 0.0,
    });

    for (const side of [-1, 1]) {
      for (let row = 0; row < ROWS; row++) {
        const rowX = side * (halfBoard + FIRST_ROW_GAP + row * ROW_GAP);
        const tierY = GROUND_Y + BASE_LIFT + row * TIER_STEP;

        this.buildRiser(rowX, tierY, riserMaterial);

        for (let seat = 0; seat < SEATS; seat++) {
          const z = (seat - (SEATS - 1) / 2) * SEAT_SPACING + (Math.random() - 0.5) * 0.25;
          const x = rowX + (Math.random() - 0.5) * 0.3;
          this.spawnSpectator(x, tierY, z);
        }
      }
    }
  }

  private buildRiser(rowX: number, tierY: number, material: THREE.MeshStandardMaterial): void {
    const length = SEATS * SEAT_SPACING + 1.0;
    const bottom = GROUND_Y - 0.6;
    const height = tierY - bottom;
    const riser = new THREE.Mesh(new THREE.BoxGeometry(ROW_GAP * 0.95, height, length), material);
    riser.position.set(rowX, bottom + height / 2, 0);
    riser.castShadow = true;
    riser.receiveShadow = true;
    this.object.add(riser);
  }

  private spawnSpectator(x: number, feetY: number, z: number): void {
    const color: PieceColor = Math.random() < 0.5 ? 'white' : 'black';
    const pawn = this.factory.create('pawn', color);
    const scale = 0.9 + Math.random() * 0.25;
    pawn.scale.setScalar(scale);
    pawn.position.set(x, feetY, z);
    pawn.rotation.y = Math.random() * Math.PI * 2; // pawns are radially symmetric
    this.object.add(pawn);

    // Direction from this seat toward the board, flattened to the ground plane.
    const dir = new THREE.Vector3(-x, 0, -z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();

    const group = new THREE.Group();
    const baseY = feetY + FACE_HEIGHT * scale;
    group.position.set(
      x + dir.x * SCREEN_FORWARD,
      baseY,
      z + dir.z * SCREEN_FORWARD,
    );
    group.rotation.y = Math.atan2(dir.x, dir.z);

    const frame = new THREE.Mesh(
      this.frameGeometry,
      new THREE.MeshBasicMaterial({ color: 0x10151a, side: THREE.DoubleSide }),
    );
    frame.position.z = -0.01;

    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    material.toneMapped = false;
    const screen = new THREE.Mesh(this.screenGeometry, material);

    group.add(frame, screen);
    this.object.add(group);

    this.billboards.push({ group, material, baseY, phase: Math.random() * Math.PI * 2 });
  }

  /** Spread a texture pool across the crowd, picking randomly per screen. */
  private assignScreens(pool: THREE.Texture[]): void {
    if (pool.length === 0) return;
    for (const board of this.billboards) {
      board.material.map = pool[Math.floor(Math.random() * pool.length)];
      board.material.needsUpdate = true;
    }
  }

  private buildPlaceholderPool(): THREE.Texture[] {
    return PLACEHOLDER_BG.map((bg, i) => createPlaceholderTexture(bg, PLACEHOLDER_EMOJI[i]));
  }

  /**
   * Load each bundled clip into a muted, looping `<video>` and wrap it in a
   * `VideoTexture` that animates automatically. Screens are upgraded to clips
   * as each one starts playing.
   */
  private loadClipScreens(): void {
    const pool: THREE.Texture[] = [];
    for (const file of CLIP_FILES) {
      const video = document.createElement('video');
      video.src = `gifs/${encodeURIComponent(file)}`;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.preload = 'auto';
      void video.play().catch(() => {});
      this.videos.push(video);

      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      pool.push(texture);
    }

    this.assignScreens(pool);
  }
}

function createPlaceholderTexture(
  [from, to]: [string, string],
  emoji: string,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;

  const backdrop = ctx.createLinearGradient(0, 0, 0, canvas.height);
  backdrop.addColorStop(0, from);
  backdrop.addColorStop(1, to);
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = '96px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, canvas.width / 2, canvas.height / 2 + 6);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
