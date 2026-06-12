import * as THREE from 'three';
import { ChessEngine } from './chess/ChessEngine';
import { moveToSan } from './chess/notation';
import {
  oppositeColor,
  sameSquare,
  type Move,
  type PieceType,
  type Square,
} from './chess/types';
import { PossessionController } from './controls/PossessionController';
import { buildCorridors } from './controls/corridors';
import { Chessboard } from './world/Chessboard';
import { ChessSet } from './world/ChessSet';
import { MoveHighlights } from './world/MoveHighlights';
import { SquareIndicator } from './world/SquareIndicator';
import {
  BOARD_SIZE,
  GROUND_Y,
  PIECE_EYE_HEIGHT,
  PLAYER_EYE_HEIGHT,
  squareCenter,
  squareCoord,
} from './constants';

const CROSSHAIR = new THREE.Vector2(0, 0); // center of the screen in NDC

const PIECE_GLYPHS: Record<PieceType, string> = {
  king: '\u265A',
  queen: '\u265B',
  rook: '\u265C',
  bishop: '\u265D',
  knight: '\u265E',
  pawn: '\u265F',
};

const PIECE_NAMES: Record<PieceType, string> = {
  king: 'King',
  queen: 'Queen',
  rook: 'Rook',
  bishop: 'Bishop',
  knight: 'Knight',
  pawn: 'Pawn',
};

function coordToSquare(coord: string): Square {
  return { file: coord.charCodeAt(0) - 97, rank: Number(coord.slice(1)) - 1 };
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controller: PossessionController;
  private readonly clock = new THREE.Clock();

  private readonly chessboard: Chessboard;
  private readonly chessSet: ChessSet;
  private readonly squareIndicator: SquareIndicator;
  private readonly moveHighlights: MoveHighlights;
  private readonly raycaster = new THREE.Raycaster();

  private readonly engine = new ChessEngine();
  private possessedCoord = 'e1';
  private possessedMoves: Move[] = [];
  private sanCache: { move: Move; san: string } | null = null;
  private gameOver = false;

  private readonly hud: HTMLElement | null;
  private readonly badge: HTMLElement | null;
  private readonly badgeGlyph: HTMLElement | null;
  private readonly badgeName: HTMLElement | null;
  private readonly badgeSquare: HTMLElement | null;
  private readonly hint: HTMLElement | null;
  private readonly dwellRing: HTMLElement | null;

  constructor(private readonly container: HTMLElement) {
    this.renderer = this.createRenderer();
    this.scene = this.createScene();
    this.camera = this.createCamera();

    this.controller = new PossessionController(this.camera, this.renderer.domElement);
    this.controller.onCommitMove = (move) => this.playMove(move);
    this.setupOverlay();

    this.addLights();
    this.addGround();

    this.chessboard = new Chessboard();
    this.scene.add(this.chessboard.object);

    this.chessSet = new ChessSet();
    this.scene.add(this.chessSet.object);

    this.squareIndicator = new SquareIndicator();
    this.scene.add(this.squareIndicator.object);

    this.moveHighlights = new MoveHighlights();
    this.scene.add(this.moveHighlights.object);

    this.hud = document.getElementById('hud');
    this.badge = document.getElementById('piece-badge');
    this.badgeGlyph = document.getElementById('badge-glyph');
    this.badgeName = document.getElementById('badge-name');
    this.badgeSquare = document.getElementById('badge-square');
    this.hint = document.getElementById('hint');
    this.dwellRing = document.getElementById('dwell-ring');

    // The game starts with the player inside the white king, facing black.
    this.possess('e1', true);
    const kingCenter = squareCenter(4, 0);
    this.camera.lookAt(kingCenter.x, PIECE_EYE_HEIGHT.king, kingCenter.z + 8);

    window.addEventListener('resize', this.onResize);
    window.addEventListener('mousedown', this.onMouseDown);
  }

  start(): void {
    this.renderer.setAnimationLoop(this.tick);
  }

  private tick = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    this.controller.update(delta);
    this.chessSet.update(delta);
    this.syncPossessed();
    this.updateHoverIndicator();
    this.updateDwellRing();
    this.renderer.render(this.scene, this.camera);
  };

  /** Take control of the piece on a square (instantly, or by leaping to it). */
  private possess(coord: string, instant: boolean): void {
    const piece = this.engine.pieceAt(coordToSquare(coord));
    const group = this.chessSet.getPiece(coord);
    if (!piece || !group) return;

    this.possessedCoord = coord;
    this.controller.possess({ coord, group, eyeHeight: PIECE_EYE_HEIGHT[piece.type] }, instant);
    this.refreshMoveState();
  }

  /**
   * Recompute everything derived from the possessed piece and the turn:
   * legal moves, walkable corridors, highlights and HUD.
   */
  private refreshMoveState(): void {
    const square = coordToSquare(this.possessedCoord);
    this.possessedMoves = this.engine.legalMovesFrom(square);
    this.sanCache = null;

    const corridors = buildCorridors(this.possessedMoves);
    if (this.possessedMoves.length > 0) {
      this.moveHighlights.show(square, this.possessedMoves, corridors);
    } else {
      this.moveHighlights.clear();
    }
    this.controller.setCorridors(corridors);

    this.updateHud();
    this.updateBadge();
    this.updateHint();
  }

  /** Keep the controller pointed at the live mesh (promotion swaps it). */
  private syncPossessed(): void {
    if (this.controller.isTransitioning) return;
    const group = this.chessSet.getPiece(this.possessedCoord);
    const piece = this.engine.pieceAt(coordToSquare(this.possessedCoord));
    if (group && piece) {
      this.controller.syncPossessed(group, PIECE_EYE_HEIGHT[piece.type]);
    }
  }

  /**
   * The square the crosshair is pointing at (directly, or via a piece on it).
   * Hits belonging to the possessed piece itself are ignored.
   */
  private pickSquare(): Square | null {
    this.raycaster.setFromCamera(CROSSHAIR, this.camera);
    const targets: THREE.Object3D[] = [...this.chessboard.squares, this.chessSet.object];
    const hits = this.raycaster.intersectObjects(targets, true);

    for (const hit of hits) {
      // Walk up to the first ancestor that knows its square coordinate
      // (square meshes and piece groups both carry userData.coord).
      let object: THREE.Object3D | null = hit.object;
      let coord: string | null = null;
      while (object && !coord) {
        coord = (object.userData.coord as string | null | undefined) ?? null;
        object = object.parent;
      }
      if (!coord) continue; // e.g. a captured piece flying off the board
      if (coord === this.possessedCoord) continue; // the piece we are inside
      return coordToSquare(coord);
    }
    return null;
  }

  private updateHoverIndicator(): void {
    const square = this.controller.isLocked ? this.pickSquare() : null;
    if (!square) {
      this.squareIndicator.hide();
      return;
    }

    // When the crosshair targets a legal destination of the possessed piece,
    // preview the move in algebraic notation (e.g. "Nf3", "exd5+").
    let text = squareCoord(square.file, square.rank);
    const move = this.possessedMoves.find((candidate) => sameSquare(candidate.to, square));
    if (move) {
      if (this.sanCache?.move !== move) {
        this.sanCache = { move, san: moveToSan(this.engine, move) };
      }
      text = this.sanCache.san;
    }

    const { x, z } = squareCenter(square.file, square.rank);
    this.squareIndicator.show(
      new THREE.Vector3(x, 0, z),
      text,
      this.camera,
      this.engine.pieceAt(square) ?? undefined,
    );
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.controller.isLocked) return;

    // Right click: retreat to the origin square, abandoning the walk.
    if (event.button === 2) {
      this.controller.cancelGlide();
      return;
    }
    if (event.button !== 0 || this.gameOver) return;

    // Left click on a friendly piece: leap into it.
    const square = this.pickSquare();
    if (!square) return;

    const piece = this.engine.pieceAt(square);
    const coord = squareCoord(square.file, square.rank);
    if (piece && piece.color === this.engine.turn && coord !== this.possessedCoord) {
      this.possess(coord, false);
    }
  };

  private playMove(move: Move): void {
    this.engine.makeMove(move);
    this.chessSet.applyMove(move);
    this.possessedCoord = squareCoord(move.to.file, move.to.rank);
    this.refreshMoveState();
  }

  private updateHud(): void {
    if (!this.hud) return;

    const toMove = capitalize(this.engine.turn);
    const winner = capitalize(oppositeColor(this.engine.turn));

    switch (this.engine.getStatus()) {
      case 'playing':
        this.hud.textContent = `${toMove} to move`;
        break;
      case 'check':
        this.hud.textContent = `${toMove} to move \u2014 check!`;
        break;
      case 'checkmate':
        this.hud.textContent = `Checkmate! ${winner} wins`;
        this.gameOver = true;
        break;
      case 'stalemate':
        this.hud.textContent = 'Stalemate \u2014 draw';
        this.gameOver = true;
        break;
    }
  }

  private updateBadge(): void {
    const piece = this.engine.pieceAt(coordToSquare(this.possessedCoord));
    if (!this.badge || !piece) return;

    this.badge.classList.toggle('white', piece.color === 'white');
    this.badge.classList.toggle('black', piece.color === 'black');
    if (this.badgeGlyph) this.badgeGlyph.textContent = PIECE_GLYPHS[piece.type];
    if (this.badgeName) this.badgeName.textContent = PIECE_NAMES[piece.type];
    if (this.badgeSquare) this.badgeSquare.textContent = this.possessedCoord;
  }

  private updateHint(): void {
    if (!this.hint) return;

    if (this.gameOver) {
      this.hint.textContent = 'Game over \u2014 reload to play again';
      return;
    }

    const piece = this.engine.pieceAt(coordToSquare(this.possessedCoord));
    const toMove = this.engine.turn;

    if (this.possessedMoves.length > 0) {
      this.hint.textContent =
        'WASD \u2014 walk a legal path \u00b7 rest or Enter \u2014 confirm \u00b7 right-click \u2014 retreat';
    } else if (piece && piece.color === toMove) {
      this.hint.textContent = `No legal moves from here \u2014 click another ${toMove} piece to jump into it`;
    } else {
      this.hint.textContent = `${capitalize(toMove)} to move \u2014 click a ${toMove} piece to take control`;
    }
  }

  private updateDwellRing(): void {
    if (!this.dwellRing) return;
    const progress = this.controller.dwellProgress;
    this.dwellRing.classList.toggle('active', progress > 0);
    this.dwellRing.style.setProperty('--p', progress.toFixed(3));
  }

  private createRenderer(): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.container.appendChild(renderer.domElement);
    return renderer;
  }

  private createScene(): THREE.Scene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87b5d9);
    scene.fog = new THREE.Fog(0x87b5d9, 30, 120);
    return scene;
  }

  private createCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      200,
    );
    // Placeholder pose; the constructor immediately possesses the white king.
    camera.position.set(0, PLAYER_EYE_HEIGHT, BOARD_SIZE / 2 + 4);
    camera.lookAt(0, 0.5, 0);
    return camera;
  }

  private addLights(): void {
    const ambient = new THREE.HemisphereLight(0xbfd6e8, 0x4a3b2a, 0.7);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(15, 25, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    this.scene.add(sun);
  }

  private addGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 300),
      new THREE.MeshStandardMaterial({ color: 0x4f7a4a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private setupOverlay(): void {
    const overlay = document.getElementById('overlay');
    if (!overlay) return;

    overlay.addEventListener('click', () => this.controller.lock());
    this.controller.addEventListener('lock', () => overlay.classList.add('hidden'));
    this.controller.addEventListener('unlock', () => overlay.classList.remove('hidden'));
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };
}
