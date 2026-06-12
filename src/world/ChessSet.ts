import * as THREE from 'three';
import { BOARD_SIZE, BORDER_WIDTH, GROUND_Y, squareCenter, squareCoord } from '../constants';
import { PieceFactory } from './PieceFactory';
import type { Move, PieceColor, PieceType } from '../chess/types';

const BACK_RANK: PieceType[] = [
  'rook',
  'knight',
  'bishop',
  'queen',
  'king',
  'bishop',
  'knight',
  'rook',
];

/** Spacing between captured pieces lined up beside the board. */
const CAPTURED_SPACING = 1.1;
/** Gap between the board border and the first captured row. */
const CAPTURED_MARGIN = 1.2;

/** Pieces this close to the walking player step aside (crowd parting). */
const DODGE_RADIUS = 1.3;
/** How far a piece shifts when the player is right on top of it. */
const DODGE_MAX = 0.6;
/** How quickly pieces ease aside and back home. */
const DODGE_LERP_RATE = 8;

interface PieceAnimation {
  object: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  duration: number;
  elapsed: number;
  /** Extra vertical arc, used for knight hops and captured pieces flying off. */
  arcHeight: number;
  onComplete?: () => void;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * The visual chess set. Mirrors the engine state: pieces are tracked per
 * square, moves/captures/castling/promotion are animated. Captured pieces
 * fly off the board and line up on the ground beside it.
 */
export class ChessSet {
  readonly object: THREE.Group;

  private readonly factory = new PieceFactory();
  private readonly pieces = new Map<string, THREE.Group>();
  private readonly animations: PieceAnimation[] = [];
  private readonly capturedCount: Record<PieceColor, number> = { white: 0, black: 0 };

  private readonly crowdSource = new THREE.Vector3();
  private readonly crowdDir = new THREE.Vector3(); // last direction of travel
  private crowdActive = false;
  private crowdExclude: string | null = null;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'chess-set';

    for (let file = 0; file < 8; file++) {
      this.spawn(BACK_RANK[file], 'white', file, 0);
      this.spawn('pawn', 'white', file, 1);
      this.spawn('pawn', 'black', file, 6);
      this.spawn(BACK_RANK[file], 'black', file, 7);
    }
  }

  /** Animate the visual consequences of a move already validated by the engine. */
  applyMove(move: Move): void {
    const fromCoord = squareCoord(move.from.file, move.from.rank);
    const toCoord = squareCoord(move.to.file, move.to.rank);

    // Captured piece flies off to the side.
    if (move.captured && move.capturedSquare) {
      const capturedCoord = squareCoord(move.capturedSquare.file, move.capturedSquare.rank);
      const victim = this.pieces.get(capturedCoord);
      if (victim) {
        this.pieces.delete(capturedCoord);
        victim.userData.coord = null; // no longer pickable as a square
        this.flyOff(victim, move.captured.color);
      }
    }

    // The moving piece.
    const mover = this.pieces.get(fromCoord);
    if (!mover) return;

    this.pieces.delete(fromCoord);
    this.pieces.set(toCoord, mover);
    mover.userData.coord = toCoord;

    const { x, z } = squareCenter(move.to.file, move.to.rank);
    const arcHeight = move.piece === 'knight' ? 1.2 : 0; // knights hop over pieces
    this.startAnimation(mover, new THREE.Vector3(x, 0, z), arcHeight, () => {
      if (move.promotion) {
        this.replacePiece(toCoord, move.promotion, move.color);
      }
    });

    // Castling: the rook slides too.
    if (move.rookFrom && move.rookTo) {
      const rookFromCoord = squareCoord(move.rookFrom.file, move.rookFrom.rank);
      const rookToCoord = squareCoord(move.rookTo.file, move.rookTo.rank);
      const rook = this.pieces.get(rookFromCoord);
      if (rook) {
        this.pieces.delete(rookFromCoord);
        this.pieces.set(rookToCoord, rook);
        rook.userData.coord = rookToCoord;

        const rookTarget = squareCenter(move.rookTo.file, move.rookTo.rank);
        this.startAnimation(rook, new THREE.Vector3(rookTarget.x, 0, rookTarget.z), 0);
      }
    }
  }

  /** The visual piece group standing on a square, if any. */
  getPiece(coord: string): THREE.Group | undefined {
    return this.pieces.get(coord);
  }

  /**
   * Where the walking player currently is, so nearby pieces step aside.
   * Pass a null source to let every piece return home (e.g. mid-flight).
   */
  setCrowd(source: THREE.Vector3 | null, excludeCoord: string | null): void {
    if (source) {
      // Remember the direction of travel; it defines which way "aside" is.
      const dx = source.x - this.crowdSource.x;
      const dz = source.z - this.crowdSource.z;
      if (this.crowdActive && dx * dx + dz * dz > 1e-6) {
        this.crowdDir.set(dx, 0, dz).normalize();
      } else if (!this.crowdActive) {
        this.crowdDir.set(0, 0, 0);
      }
      this.crowdSource.copy(source);
      this.crowdActive = true;
    } else {
      this.crowdActive = false;
      this.crowdDir.set(0, 0, 0);
    }
    this.crowdExclude = excludeCoord;
  }

  /** Advances piece animations and crowd dodging. Call once per frame. */
  update(delta: number): void {
    for (let i = this.animations.length - 1; i >= 0; i--) {
      const animation = this.animations[i];
      animation.elapsed += delta;

      const t = Math.min(1, animation.elapsed / animation.duration);
      const e = easeInOutQuad(t);
      animation.object.position.lerpVectors(animation.from, animation.to, e);
      animation.object.position.y += Math.sin(Math.PI * e) * animation.arcHeight;

      if (t >= 1) {
        this.animations.splice(i, 1);
        animation.onComplete?.();
      }
    }

    this.updateCrowd(delta);
  }

  /**
   * Pieces near the player's corridor walk lean out of the way and ease back
   * home afterwards — including the in-between squares of a knight path and
   * the neighbors of a diagonal bishop pass.
   */
  private updateCrowd(delta: number): void {
    const t = Math.min(1, DODGE_LERP_RATE * delta);
    const animating = new Set(this.animations.map((animation) => animation.object));

    for (const [coord, piece] of this.pieces) {
      if (coord === this.crowdExclude || animating.has(piece)) continue;

      const file = coord.charCodeAt(0) - 97;
      const rank = Number(coord.slice(1)) - 1;
      const home = squareCenter(file, rank);
      const dodge = (piece.userData.dodge ??= new THREE.Vector3()) as THREE.Vector3;

      let targetX = 0;
      let targetZ = 0;
      if (this.crowdActive) {
        const dx = home.x - this.crowdSource.x;
        const dz = home.z - this.crowdSource.z;
        const distance = Math.hypot(dx, dz);
        if (distance < DODGE_RADIUS) {
          const push = DODGE_MAX * (1 - distance / DODGE_RADIUS);
          let nx = 1;
          let nz = 0;

          if (this.crowdDir.lengthSq() > 0.5) {
            // Step aside perpendicular to the player's travel — pushing
            // straight away would herd pieces ahead along the corridor and
            // the player walks through them anyway. The side is wherever
            // the piece already sits relative to the path.
            const along = dx * this.crowdDir.x + dz * this.crowdDir.z;
            const latX = dx - along * this.crowdDir.x;
            const latZ = dz - along * this.crowdDir.z;
            const lateral = Math.hypot(latX, latZ);
            if (lateral > 0.03) {
              nx = latX / lateral;
              nz = latZ / lateral;
            } else {
              // Dead ahead on the path: pick a side, sticking with one the
              // piece has already chosen.
              nx = -this.crowdDir.z;
              nz = this.crowdDir.x;
              if (dodge.x * nx + dodge.z * nz < 0) {
                nx = -nx;
                nz = -nz;
              }
            }
          } else if (distance > 0.05) {
            // Player isn't moving: fall back to a radial push.
            nx = dx / distance;
            nz = dz / distance;
          } else if (dodge.lengthSq() > 1e-6) {
            // Player is standing on this square; keep the current direction
            // instead of flipping around a degenerate vector.
            const length = Math.hypot(dodge.x, dodge.z);
            nx = dodge.x / length;
            nz = dodge.z / length;
          }

          targetX = nx * push;
          targetZ = nz * push;
        }
      }

      dodge.x = THREE.MathUtils.lerp(dodge.x, targetX, t);
      dodge.z = THREE.MathUtils.lerp(dodge.z, targetZ, t);
      piece.position.set(home.x + dodge.x, 0, home.z + dodge.z);
    }
  }

  private spawn(type: PieceType, color: PieceColor, file: number, rank: number): void {
    const piece = this.factory.create(type, color);

    const { x, z } = squareCenter(file, rank);
    piece.position.set(x, 0, z);

    // Black pieces face the white side (matters for the knights).
    if (color === 'black') {
      piece.rotation.y = Math.PI;
    }

    const coord = squareCoord(file, rank);
    piece.name = `${color}-${type}`;
    piece.userData.coord = coord;

    this.pieces.set(coord, piece);
    this.object.add(piece);
  }

  /** Swap the piece on a square for a new type (pawn promotion). */
  private replacePiece(coord: string, type: PieceType, color: PieceColor): void {
    const old = this.pieces.get(coord);
    if (old) {
      this.object.remove(old);
      this.pieces.delete(coord);
    }

    const file = coord.charCodeAt(0) - 97;
    const rank = Number(coord.slice(1)) - 1;
    this.spawn(type, color, file, rank);
  }

  private flyOff(victim: THREE.Group, color: PieceColor): void {
    const slot = this.nextCapturedSlot(color);
    this.startAnimation(victim, slot, 2.5, undefined, 1.1);
  }

  /** Ground position where the next captured piece of this color lines up. */
  private nextCapturedSlot(color: PieceColor): THREE.Vector3 {
    const index = this.capturedCount[color]++;
    const row = Math.floor(index / 8);
    const column = index % 8;

    // Captured white pieces line up on +x, black on -x.
    const side = color === 'white' ? 1 : -1;
    const x = side * (BOARD_SIZE / 2 + BORDER_WIDTH + CAPTURED_MARGIN + row * CAPTURED_SPACING);
    const z = -BOARD_SIZE / 2 + column * CAPTURED_SPACING;

    return new THREE.Vector3(x, GROUND_Y, z);
  }

  private startAnimation(
    object: THREE.Object3D,
    to: THREE.Vector3,
    arcHeight: number,
    onComplete?: () => void,
    duration?: number,
  ): void {
    // Cancel any running animation on the same object.
    const existing = this.animations.findIndex((animation) => animation.object === object);
    if (existing !== -1) this.animations.splice(existing, 1);

    const from = object.position.clone();
    this.animations.push({
      object,
      from,
      to,
      duration: duration ?? Math.min(1.2, 0.35 + from.distanceTo(to) * 0.06),
      elapsed: 0,
      arcHeight,
      onComplete,
    });
  }
}
