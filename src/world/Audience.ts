import * as THREE from 'three';
import { BOARD_SIZE, BORDER_WIDTH, GROUND_Y } from '../constants';
import { PieceFactory, type PieceColor } from './PieceFactory';

const GIPHY_API_KEY = import.meta.env.VITE_GIPHY_API_KEY as string | undefined;

/** How many GIFs to pull and share across the crowd's billboards. */
const SCREEN_POOL_SIZE = 14;

/** Search term for the crowd's GIFs, so the screens stay on theme. */
const GIPHY_QUERY = 'chess';

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
 * face screen. The screens loop random GIFs pulled from Giphy (shared across
 * the crowd from a small pool), falling back to colorful placeholders when no
 * API key is configured or the fetch fails.
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
    // Show placeholders immediately, then upgrade to GIFs once they load.
    this.assignScreens(this.buildPlaceholderPool());
    void this.loadGiphyScreens();
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

  private async loadGiphyScreens(): Promise<void> {
    const urls = await fetchGiphyMp4s(SCREEN_POOL_SIZE);
    if (urls.length === 0) return;

    const pool: THREE.Texture[] = [];
    for (const url of urls) {
      const video = document.createElement('video');
      video.src = url;
      video.crossOrigin = 'anonymous';
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      void video.play().catch(() => {});
      this.videos.push(video);

      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      pool.push(texture);
    }

    this.assignScreens(pool);
  }
}

/** Search a batch of on-theme GIFs and return their looping mp4 URLs. */
async function fetchGiphyMp4s(limit: number): Promise<string[]> {
  if (!GIPHY_API_KEY) return [];
  try {
    // A random offset varies the set across reloads instead of always
    // returning the same top "chess" results.
    const offset = Math.floor(Math.random() * 30);
    const url =
      `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}` +
      `&q=${encodeURIComponent(GIPHY_QUERY)}&limit=${limit}&offset=${offset}&rating=pg-13`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: GiphyGif[] };
    const urls: string[] = [];
    for (const gif of json.data ?? []) {
      const images = gif.images ?? {};
      const mp4 =
        images.downsized_small?.mp4 ??
        images.looping?.mp4 ??
        images.original_mp4?.mp4 ??
        images.original?.mp4;
      if (mp4) urls.push(mp4);
    }
    return urls;
  } catch {
    return [];
  }
}

interface GiphyRendition {
  mp4?: string;
}
interface GiphyGif {
  images?: {
    downsized_small?: GiphyRendition;
    looping?: GiphyRendition;
    original_mp4?: GiphyRendition;
    original?: GiphyRendition;
  };
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
