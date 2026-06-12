import * as THREE from 'three';
import {
  BOARD_SIZE,
  BOARD_SQUARES,
  BORDER_WIDTH,
  SQUARE_SIZE,
  squareCenter,
  squareCoord,
} from '../constants';

const BOARD_THICKNESS = 0.3;

export interface SquareInfo {
  /** Algebraic coordinate, e.g. "e4". */
  coord: string;
  file: number;
  rank: number;
}

/**
 * The chessboard: 8x8 alternating squares sitting on a slightly larger
 * bordered base. The top surface of the board is at y = 0.
 */
export class Chessboard {
  readonly object: THREE.Group;

  /** The 64 square meshes, used for raycasting. */
  readonly squares: THREE.Mesh[] = [];

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'chessboard';

    this.buildSquares();
    this.buildBase();
  }

  private buildSquares(): void {
    const squareGeometry = new THREE.BoxGeometry(SQUARE_SIZE, BOARD_THICKNESS, SQUARE_SIZE);

    const lightMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8d5b0,
      roughness: 0.35,
      metalness: 0.05,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x5c3a21,
      roughness: 0.4,
      metalness: 0.05,
    });

    for (let rank = 0; rank < BOARD_SQUARES; rank++) {
      for (let file = 0; file < BOARD_SQUARES; file++) {
        // a1 is a dark square in chess: (file + rank) even => dark.
        const isLight = (rank + file) % 2 === 1;
        const square = new THREE.Mesh(squareGeometry, isLight ? lightMaterial : darkMaterial);

        const { x, z } = squareCenter(file, rank);
        square.position.set(x, -BOARD_THICKNESS / 2, z);
        square.receiveShadow = true;

        const coord = squareCoord(file, rank);
        square.name = `square-${coord}`;
        square.userData = { coord, file, rank } satisfies SquareInfo;

        this.squares.push(square);
        this.object.add(square);
      }
    }
  }

  private buildBase(): void {
    const baseSize = BOARD_SIZE + BORDER_WIDTH * 2;
    const baseGeometry = new THREE.BoxGeometry(baseSize, BOARD_THICKNESS, baseSize);
    const baseMaterial = new THREE.MeshStandardMaterial({
      color: 0x2e1d12,
      roughness: 0.5,
      metalness: 0.1,
    });

    const base = new THREE.Mesh(baseGeometry, baseMaterial);
    // Slightly lower than the squares so the squares sit proud of the border.
    base.position.y = -BOARD_THICKNESS / 2 - 0.02;
    base.receiveShadow = true;
    base.name = 'board-base';

    this.object.add(base);
  }
}
