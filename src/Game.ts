import * as THREE from 'three';
import { ChessEngine } from './chess/ChessEngine';
import {
  oppositeColor,
  sameSquare,
  type Move,
  type PieceColor,
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

/** Pause before the CPU answers, so its reply doesn't feel instantaneous. */
const CPU_MOVE_DELAY_MS = 900;

export type GameMode = 'free' | 'cpu';

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
  private gameOver = false;

  private mode: GameMode = 'free';
  private playerColor: PieceColor = 'white';
  private cpuMoveTimer: number | null = null;

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
    this.setupMenu();
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

    window.addEventListener('resize', this.onResize);
    window.addEventListener('mousedown', this.onMouseDown);
  }

  start(): void {
    this.renderer.setAnimationLoop(this.tick);
  }

  /** Begin a game in the chosen mode. The player starts inside their king. */
  startGame(mode: GameMode, playerColor: PieceColor): void {
    this.mode = mode;
    this.playerColor = mode === 'cpu' ? playerColor : 'white';

    const kingCoord = this.playerColor === 'white' ? 'e1' : 'e8';
    this.possess(kingCoord, true);

    // Face the opponent's side of the board.
    const king = coordToSquare(kingCoord);
    const center = squareCenter(king.file, king.rank);
    const forward = this.playerColor === 'white' ? 8 : -8;
    this.camera.lookAt(center.x, PIECE_EYE_HEIGHT.king, center.z + forward);

    this.controller.lock();

    if (this.cpuColor === this.engine.turn) {
      this.scheduleCpuMove();
    }
  }

  /** The color the CPU plays, or null in free play. */
  private get cpuColor(): PieceColor | null {
    return this.mode === 'cpu' ? oppositeColor(this.playerColor) : null;
  }

  /** Which color's pieces the player may possess right now. */
  private get controlledColor(): PieceColor {
    return this.mode === 'cpu' ? this.playerColor : this.engine.turn;
  }

  private tick = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    this.controller.update(delta);
    this.chessSet.setCrowd(
      this.controller.isTransitioning ? null : this.camera.position,
      this.possessedCoord,
    );
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
      text = move.san;
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
    if (piece && piece.color === this.controlledColor && coord !== this.possessedCoord) {
      this.possess(coord, false);
    }
  };

  private playMove(move: Move): void {
    this.engine.makeMove(move);
    this.chessSet.applyMove(move);
    this.possessedCoord = squareCoord(move.to.file, move.to.rank);
    this.refreshMoveState();

    if (!this.gameOver && this.cpuColor === this.engine.turn) {
      this.scheduleCpuMove();
    }
  }

  private scheduleCpuMove(): void {
    if (this.cpuMoveTimer !== null) return;
    this.cpuMoveTimer = window.setTimeout(() => {
      this.cpuMoveTimer = null;
      this.playCpuMove();
    }, CPU_MOVE_DELAY_MS);
  }

  /** Placeholder "AI": plays a uniformly random legal move. */
  private playCpuMove(): void {
    if (this.gameOver || this.engine.turn !== this.cpuColor) return;

    const moves = this.engine.allLegalMoves();
    if (moves.length === 0) return;
    const move = moves[Math.floor(Math.random() * moves.length)];
    this.engine.makeMove(move);

    // The CPU captured the piece we inhabit: leap into our king first, so the
    // controller releases the victim's mesh before it flies off the board.
    const capturedCoord = move.capturedSquare
      ? squareCoord(move.capturedSquare.file, move.capturedSquare.rank)
      : null;
    if (capturedCoord === this.possessedCoord) {
      const king = this.engine.kingSquare(this.playerColor);
      this.possess(squareCoord(king.file, king.rank), false);
      this.chessSet.applyMove(move);
    } else {
      this.chessSet.applyMove(move);
      this.refreshMoveState();
    }
  }

  private updateHud(): void {
    if (!this.hud) return;

    const cpuTag = (color: PieceColor) => (color === this.cpuColor ? ' (CPU)' : '');
    const toMove = capitalize(this.engine.turn) + cpuTag(this.engine.turn);
    const winner =
      capitalize(oppositeColor(this.engine.turn)) + cpuTag(oppositeColor(this.engine.turn));

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
      case 'draw':
        this.hud.textContent = 'Draw \u2014 by repetition, fifty-move rule or insufficient material';
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

    if (this.cpuColor === this.engine.turn) {
      this.hint.textContent = 'CPU is thinking\u2026';
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

  private setupMenu(): void {
    const menu = document.getElementById('menu');
    const begin = (mode: GameMode, color: PieceColor) => {
      menu?.classList.add('hidden');
      this.startGame(mode, color);
    };

    document.getElementById('mode-free')?.addEventListener('click', () => begin('free', 'white'));
    document
      .getElementById('mode-cpu-white')
      ?.addEventListener('click', () => begin('cpu', 'white'));
    document
      .getElementById('mode-cpu-black')
      ?.addEventListener('click', () => begin('cpu', 'black'));
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
