import * as THREE from 'three';
import { ChessEngine } from './chess/ChessEngine';
import { moveToSan } from './chess/notation';
import { oppositeColor, sameSquare, type Move, type Square } from './chess/types';
import { FirstPersonController } from './controls/FirstPersonController';
import { Chessboard } from './world/Chessboard';
import { ChessSet } from './world/ChessSet';
import { MoveHighlights } from './world/MoveHighlights';
import { SquareIndicator } from './world/SquareIndicator';
import { BOARD_SIZE, GROUND_Y, PLAYER_EYE_HEIGHT, squareCenter, squareCoord } from './constants';

const CROSSHAIR = new THREE.Vector2(0, 0); // center of the screen in NDC

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controller: FirstPersonController;
  private readonly clock = new THREE.Clock();

  private readonly chessboard: Chessboard;
  private readonly chessSet: ChessSet;
  private readonly squareIndicator: SquareIndicator;
  private readonly moveHighlights: MoveHighlights;
  private readonly raycaster = new THREE.Raycaster();

  private readonly engine = new ChessEngine();
  private selected: Square | null = null;
  private selectedMoves: Move[] = [];
  private sanCache: { move: Move; san: string } | null = null;
  private gameOver = false;
  private readonly hud: HTMLElement | null;

  constructor(private readonly container: HTMLElement) {
    this.renderer = this.createRenderer();
    this.scene = this.createScene();
    this.camera = this.createCamera();

    this.controller = new FirstPersonController(this.camera, this.renderer.domElement);
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
    this.updateHud();

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
    this.updateHoverIndicator();
    this.renderer.render(this.scene, this.camera);
  };

  /** The square the crosshair is pointing at (directly, or via a piece on it). */
  private pickSquare(): Square | null {
    this.raycaster.setFromCamera(CROSSHAIR, this.camera);
    const targets: THREE.Object3D[] = [...this.chessboard.squares, this.chessSet.object];
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;

    // Walk up to the first ancestor that knows its square coordinate
    // (square meshes and piece groups both carry userData.coord).
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      const coord = object.userData.coord as string | null | undefined;
      if (coord) {
        return { file: coord.charCodeAt(0) - 97, rank: Number(coord.slice(1)) - 1 };
      }
      object = object.parent;
    }
    return null;
  }

  private updateHoverIndicator(): void {
    const square = this.controller.isLocked ? this.pickSquare() : null;
    if (!square) {
      this.squareIndicator.hide();
      return;
    }

    // When a piece is selected and the crosshair targets one of its legal
    // moves, preview the move in algebraic notation (e.g. "Nf3", "exd5+").
    let text = squareCoord(square.file, square.rank);
    if (this.selected) {
      const move = this.selectedMoves.find((candidate) => sameSquare(candidate.to, square));
      if (move) {
        if (this.sanCache?.move !== move) {
          this.sanCache = { move, san: moveToSan(this.engine, move) };
        }
        text = this.sanCache.san;
      }
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
    if (event.button !== 0 || !this.controller.isLocked || this.gameOver) return;

    const square = this.pickSquare();
    if (!square) {
      this.clearSelection();
      return;
    }

    // If a piece is selected and the clicked square is a legal target, move.
    if (this.selected) {
      const move = this.selectedMoves.find((candidate) => sameSquare(candidate.to, square));
      if (move) {
        this.playMove(move);
        return;
      }
    }

    // Otherwise (re)select if it's a piece of the side to move.
    const piece = this.engine.pieceAt(square);
    if (piece && piece.color === this.engine.turn) {
      this.selected = square;
      this.selectedMoves = this.engine.legalMovesFrom(square);
      this.moveHighlights.show(square, this.selectedMoves);
    } else {
      this.clearSelection();
    }
  };

  private playMove(move: Move): void {
    this.engine.makeMove(move);
    this.chessSet.applyMove(move);
    this.clearSelection();
    this.updateHud();
  }

  private clearSelection(): void {
    this.selected = null;
    this.selectedMoves = [];
    this.sanCache = null;
    this.moveHighlights.clear();
  }

  private updateHud(): void {
    if (!this.hud) return;

    const capitalize = (s: string): string => s[0].toUpperCase() + s.slice(1);
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
    // Start just outside the board, looking toward its center.
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
