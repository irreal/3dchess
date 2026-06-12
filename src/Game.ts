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
import {
  createOnlineGame,
  joinOnlineGame,
  OnlineClient,
  type OnlineSession,
} from './net/OnlineClient';
import {
  PROMOTION_SYMBOLS,
  type GameSnapshot,
  type PresencePayload,
  type ServerMessage,
} from './net/protocol';
import { Chessboard } from './world/Chessboard';
import { ChessSet } from './world/ChessSet';
import { MoveHighlights } from './world/MoveHighlights';
import { PieceAntics } from './world/PieceAntics';
import { PossessionMarker } from './world/PossessionMarker';
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

/** Beat between the CPU marker landing on a piece and that piece walking. */
const CPU_LEAP_SETTLE_MS = 400;

/** Gap between a piece's head and the possession marker hovering above it. */
const MARKER_GAP = 0.65;

/** NDC margin: the off-screen pointer appears once the marker leaves this box. */
const POINTER_EDGE_NDC = 1.0;

/** Distance (px) the off-screen pointer keeps from the window edges. */
const POINTER_MARGIN_PX = 70;

/**
 * Live presence stream (online play): how often the local possession/walk
 * position is sampled and sent. ~12 Hz keeps the opponent's view lively at
 * roughly 60 bytes per message; the server caps relaying at 25 Hz anyway.
 */
const PRESENCE_INTERVAL_MS = 80;
/** Displacement from the home square (m) that counts as "walking". */
const PRESENCE_WALK_EPSILON = 0.03;
/** Walk positions are re-sent only after moving this far (m). */
const PRESENCE_MIN_DELTA = 0.02;

/** Smoothing rate pulling the remote piece toward its dead-reckoned target. */
const REMOTE_WALK_SMOOTH_RATE = 14;
/** Extrapolate at most this far (s) past the last received walk sample. */
const REMOTE_WALK_MAX_LEAD_S = 0.15;
/** Sanity cap (m/s) on the velocity inferred from walk samples. */
const REMOTE_WALK_MAX_SPEED = 10;

/** A remote piece within this distance (m) of its settle target snaps home. */
const REMOTE_WALK_SETTLE_RADIUS = 0.02;

/** No walk samples for this long (s) sends the remote piece back home. */
const REMOTE_WALK_TIMEOUT_S = 5;

/** The opponent's live walk preview of a piece on a square. */
interface RemoteWalk {
  coord: string;
  target: THREE.Vector3;
  velocity: THREE.Vector3;
  lastUpdateAt: number;
  /** True once the opponent reported the piece back at rest. */
  settling: boolean;
}

export type GameMode = 'free' | 'cpu' | 'online';

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
  private enemyMoveTimer: number | null = null;

  /** True once the player has left the menu and entered the 3D game. */
  private inGame = false;

  private online: OnlineClient | null = null;
  private onlineSession: OnlineSession | null = null;
  private opponentJoined = false;
  /** The opponent's WebSocket is currently up. */
  private opponentPresent = false;
  private serverConnected = false;
  private resignWinner: PieceColor | null = null;
  /** Remote plies scheduled for animated playback but not yet applied. */
  private pendingRemotePlies = 0;

  /** Square whose piece the enemy's perspective (CPU or friend) inhabits. */
  private enemyPossessedCoord: string | null = null;
  private readonly enemyMarker = new PossessionMarker();

  /** Outgoing presence stream state (online play). */
  private lastPresenceSentAt = 0;
  private lastSentPresence = { coord: '', x: 0, z: 0, walking: false, duck: false, jumps: 0 };

  /** Incoming presence: the friend's piece walking live, dead-reckoned. */
  private remoteWalk: RemoteWalk | null = null;
  private readonly tmpRemoteTarget = new THREE.Vector3();

  /** Jump/duck squash-and-stretch for our piece and the friend's piece. */
  private readonly localAntics = new PieceAntics();
  private readonly remoteAntics = new PieceAntics();
  /** Friend's cumulative jump count we already replayed (null = no baseline). */
  private remoteJumpsSeen: number | null = null;
  private readonly enemyPointer: HTMLElement | null;
  private readonly enemyPointerGlyph: HTMLElement | null;
  private readonly tmpProjected = new THREE.Vector3();
  private readonly tmpPointerTarget = new THREE.Vector3();
  private readonly tmpToMarker = new THREE.Vector3();
  private readonly tmpCamForward = new THREE.Vector3();

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
    this.controller.onJump = () => {
      if (!this.controller.isTransitioning) this.localAntics.jump();
    };
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

    this.scene.add(this.enemyMarker.object);

    this.hud = document.getElementById('hud');
    this.enemyPointer = document.getElementById('enemy-pointer');
    this.enemyPointerGlyph = document.getElementById('enemy-pointer-glyph');
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
    this.playerColor = mode === 'free' ? 'white' : playerColor;
    this.inGame = true;

    // Looked up (not hardcoded) because an online game may resume mid-way.
    const king = this.engine.kingSquare(this.playerColor);
    const kingCoord = squareCoord(king.file, king.rank);
    this.possess(kingCoord, true);

    // Face the opponent's side of the board.
    const piece = this.engine.pieceAt(king);
    const center = squareCenter(king.file, king.rank);
    const forward = this.playerColor === 'white' ? 8 : -8;
    this.camera.lookAt(center.x, PIECE_EYE_HEIGHT[piece?.type ?? 'king'], center.z + forward);

    this.controller.lock();

    // The enemy's perspective starts inside its own king, mirroring the player.
    if (this.opponentColor) {
      const enemyKing = this.engine.kingSquare(this.opponentColor);
      this.enemyPossessedCoord = squareCoord(enemyKing.file, enemyKing.rank);
    } else {
      this.enemyPossessedCoord = null;
      this.enemyMarker.hide();
    }

    if (this.cpuColor === this.engine.turn) {
      this.scheduleCpuMove();
    }
  }

  /** The color the CPU plays, or null outside CPU mode. */
  private get cpuColor(): PieceColor | null {
    return this.mode === 'cpu' ? oppositeColor(this.playerColor) : null;
  }

  /** The enemy color (CPU or online friend), or null in free play. */
  private get opponentColor(): PieceColor | null {
    return this.mode === 'free' ? null : oppositeColor(this.playerColor);
  }

  /** Which color's pieces the player may possess right now. */
  private get controlledColor(): PieceColor {
    return this.mode === 'free' ? this.engine.turn : this.playerColor;
  }

  private tick = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.1);

    // Our own antics run before the controller so the camera rides the jump
    // and the crouch this same frame (and before ChessSet so committed-move
    // animations keep authority over the piece's vertical position).
    this.localAntics.attach(this.inGame ? (this.chessSet.getPiece(this.possessedCoord) ?? null) : null);
    this.localAntics.setDuck(this.controller.isLocked && this.controller.wantsDuck);
    this.localAntics.update(delta);
    this.controller.setVerticalPose(this.localAntics.height, this.localAntics.verticalScale);

    this.controller.update(delta);
    this.chessSet.setCrowd(
      this.controller.isTransitioning ? null : this.camera.position,
      this.possessedCoord,
    );
    this.chessSet.update(delta);
    this.updateRemoteWalk(delta);
    // The friend's antics run after ChessSet so the crowd system's home
    // snapping doesn't stomp their jump height.
    this.remoteAntics.update(delta);
    this.maybeSendPresence();
    this.syncPossessed();
    this.syncEnemyMarker();
    this.enemyMarker.update(delta);
    this.updateHoverIndicator();
    this.updateDwellRing();
    this.updateEnemyPointer();
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
    // Online: no walking before the friend joins or after the game ended
    // server-side (e.g. resignation), even if chess.js still offers moves.
    const frozen = this.mode === 'online' && (!this.opponentJoined || this.gameOver);
    this.possessedMoves = frozen ? [] : this.engine.legalMovesFrom(square);

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
    // Online: tell the server first (the move is locally legal, so the
    // authoritative engine accepts it; the echoed broadcast adds no plies).
    if (this.mode === 'online') {
      this.online?.send({
        type: 'move',
        move: {
          from: squareCoord(move.from.file, move.from.rank),
          to: squareCoord(move.to.file, move.to.rank),
          promotion: move.promotion ? PROMOTION_SYMBOLS[move.promotion] : undefined,
        },
      });
    }

    this.engine.makeMove(move);
    this.chessSet.applyMove(move);
    this.possessedCoord = squareCoord(move.to.file, move.to.rank);
    this.refreshMoveState();

    // We captured the piece the enemy's perspective was inside: its marker
    // bails out to the enemy king, mirroring what happens to the player.
    const capturedCoord = move.capturedSquare
      ? squareCoord(move.capturedSquare.file, move.capturedSquare.rank)
      : null;
    if (this.opponentColor && capturedCoord && capturedCoord === this.enemyPossessedCoord) {
      const king = this.engine.kingSquare(this.opponentColor);
      const kingCoord = squareCoord(king.file, king.rank);
      this.enemyPossessedCoord = kingCoord;
      const group = this.chessSet.getPiece(kingCoord);
      if (group) this.enemyMarker.leapTo(group, this.markerHeight('king'));
    }

    if (!this.gameOver && this.cpuColor === this.engine.turn) {
      this.scheduleCpuMove();
    }
  }

  private scheduleCpuMove(): void {
    if (this.enemyMoveTimer !== null) return;
    this.enemyMoveTimer = window.setTimeout(() => {
      this.enemyMoveTimer = null;
      this.playCpuMove();
    }, CPU_MOVE_DELAY_MS);
  }

  /** Placeholder "AI": plays a uniformly random legal move. */
  private playCpuMove(): void {
    if (this.gameOver || this.engine.turn !== this.cpuColor) return;

    const moves = this.engine.allLegalMoves();
    if (moves.length === 0) return;
    this.animateEnemyMove(moves[Math.floor(Math.random() * moves.length)]);
  }

  /**
   * Play an enemy move (CPU or online friend) with the full ceremony: the
   * enemy's perspective first leaps into the piece it is about to move,
   * settles for a beat, then walks it.
   */
  private animateEnemyMove(move: Move, onApplied?: () => void): void {
    const fromCoord = squareCoord(move.from.file, move.from.rank);
    const group = this.chessSet.getPiece(fromCoord);
    if (fromCoord === this.enemyPossessedCoord || !group) {
      this.applyRemoteMove(move);
      onApplied?.();
      return;
    }

    this.enemyPossessedCoord = fromCoord;
    this.enemyMarker.leapTo(group, this.markerHeight(move.piece), () => {
      this.enemyMoveTimer = window.setTimeout(() => {
        this.enemyMoveTimer = null;
        this.applyRemoteMove(move);
        onApplied?.();
      }, CPU_LEAP_SETTLE_MS);
    });
  }

  /** Apply a move the player did not make (CPU, friend, or history catch-up). */
  private applyRemoteMove(move: Move): void {
    // The real move supersedes any live walk preview; ChessSet animates the
    // mover from wherever the preview left it, so the handover is seamless.
    // Antics detach too (restoring neutral scale/height) for the same reason.
    this.clearRemoteWalk();
    this.remoteAntics.attach(null);

    this.engine.makeMove(move);

    // The enemy captured the piece we inhabit: leap into our king first, so
    // the controller releases the victim's mesh before it flies off the board.
    const capturedCoord = move.capturedSquare
      ? squareCoord(move.capturedSquare.file, move.capturedSquare.rank)
      : null;
    if (this.inGame && capturedCoord === this.possessedCoord) {
      const king = this.engine.kingSquare(this.playerColor);
      this.possess(squareCoord(king.file, king.rank), false);
      this.chessSet.applyMove(move);
    } else {
      this.chessSet.applyMove(move);
      if (this.inGame) this.refreshMoveState();
    }

    // The marker rides along as the piece walks to its destination square.
    if (move.color === this.opponentColor) {
      this.enemyPossessedCoord = squareCoord(move.to.file, move.to.rank);
    }
  }

  private markerHeight(piece: PieceType): number {
    return PIECE_EYE_HEIGHT[piece] + MARKER_GAP;
  }

  /**
   * Keep the marker glued to the live mesh on the enemy's possessed square
   * (the mover during its walk, the new queen after a promotion swap).
   */
  private syncEnemyMarker(): void {
    if (!this.enemyPossessedCoord || this.enemyMarker.isLeaping) return;
    const group = this.chessSet.getPiece(this.enemyPossessedCoord);
    const piece = this.engine.pieceAt(coordToSquare(this.enemyPossessedCoord));
    if (group && piece) {
      this.enemyMarker.setFollow(group, this.markerHeight(piece.type));
    }
  }

  // -------------------------------------------------------------------------
  // Online play
  // -------------------------------------------------------------------------

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'state':
      case 'move':
        this.applyServerState(message.state);
        break;
      case 'presence':
        this.handlePresence(message.presence);
        break;
      case 'opponent':
        this.opponentPresent = message.connected;
        if (this.inGame) this.updateHint();
        break;
      case 'error':
        // Local moves are validated before sending, so this only fires on a
        // genuine desync; the next server snapshot is the source of truth.
        console.warn('[online] server rejected an action:', message.message);
        break;
    }
  }

  private applyServerState(state: GameSnapshot): void {
    const hadJoined = this.opponentJoined;
    this.opponentJoined = state.players.white && state.players.black;
    if (state.status === 'resigned' && state.winner) {
      this.resignWinner = state.winner;
      this.gameOver = true;
    }

    this.syncToHistory(state.history);

    if (this.inGame) {
      // Unfreeze corridors the moment the friend claims their seat.
      if (!hadJoined && this.opponentJoined) this.refreshMoveState();
      this.updateHud();
      this.updateHint();
    } else {
      this.updateLobbyStatus();
    }
  }

  // --- Live presence: streaming our movements out -------------------------

  /**
   * Sample the possessed piece at ~12 Hz and stream possession jumps and
   * corridor-walk positions to the friend. Deduplicated, so a resting piece
   * costs nothing; volatile, so nothing is queued while offline.
   */
  private maybeSendPresence(): void {
    if (this.mode !== 'online' || !this.inGame || !this.online || this.gameOver) return;

    const now = performance.now();
    if (now - this.lastPresenceSentAt < PRESENCE_INTERVAL_MS) return;

    const group = this.chessSet.getPiece(this.possessedCoord);
    if (!group) return;

    const square = coordToSquare(this.possessedCoord);
    const home = squareCenter(square.file, square.rank);
    const { x, z } = group.position;
    const walking = Math.hypot(x - home.x, z - home.z) > PRESENCE_WALK_EPSILON;

    const duck = this.localAntics.isDucking;
    const jumps = this.localAntics.jumpCount;

    const last = this.lastSentPresence;
    const moved = Math.hypot(x - last.x, z - last.z) > PRESENCE_MIN_DELTA;
    if (
      this.possessedCoord === last.coord &&
      walking === last.walking &&
      (!walking || !moved) &&
      duck === last.duck &&
      jumps === last.jumps
    ) {
      return; // nothing the friend doesn't already know
    }

    this.online.send(
      {
        type: 'presence',
        presence: {
          possessed: this.possessedCoord,
          // Centimeter precision keeps the payload small.
          pos: walking
            ? { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 }
            : undefined,
          duck: duck || undefined,
          jumps: jumps || undefined,
        },
      },
      true,
    );
    this.lastPresenceSentAt = now;
    this.lastSentPresence = { coord: this.possessedCoord, x, z, walking, duck, jumps };
  }

  // --- Live presence: playing the friend's movements back ------------------

  private handlePresence(presence: PresencePayload): void {
    if (this.mode !== 'online') return;

    if (presence.possessed !== this.enemyPossessedCoord) {
      this.enemyPossessedCoord = presence.possessed;
      // The previously walked piece snaps home via the crowd system,
      // mirroring how the sender's own piece pops back when they jump away.
      this.clearRemoteWalk();

      const group = this.chessSet.getPiece(presence.possessed);
      const piece = this.engine.pieceAt(coordToSquare(presence.possessed));
      if (group && piece && this.inGame) {
        this.enemyMarker.leapTo(group, this.markerHeight(piece.type));
      }
    }

    // Antics replay: duck is held state; jumps is a cumulative counter, so a
    // growing value triggers the same take-off physics on our side. A smaller
    // value means the friend's client restarted — rebaseline without jumping.
    this.remoteAntics.attach(this.chessSet.getPiece(presence.possessed) ?? null);
    this.remoteAntics.setDuck(presence.duck === true);
    const jumps = presence.jumps ?? 0;
    if (this.remoteJumpsSeen === null || jumps < this.remoteJumpsSeen) {
      this.remoteJumpsSeen = jumps;
    } else if (jumps > this.remoteJumpsSeen) {
      this.remoteJumpsSeen = jumps;
      this.remoteAntics.jump();
    }

    if (presence.pos) {
      this.updateRemoteWalkTarget(presence.possessed, presence.pos.x, presence.pos.z);
    } else if (this.remoteWalk) {
      // Reported back at rest: ease onto the home square, then hand the
      // piece back to the crowd system.
      const square = coordToSquare(this.remoteWalk.coord);
      const home = squareCenter(square.file, square.rank);
      this.remoteWalk.target.set(home.x, 0, home.z);
      this.remoteWalk.velocity.set(0, 0, 0);
      this.remoteWalk.settling = true;
    }
  }

  private updateRemoteWalkTarget(coord: string, x: number, z: number): void {
    const now = performance.now();
    const walk = this.remoteWalk;

    if (!walk || walk.coord !== coord) {
      this.remoteWalk = {
        coord,
        target: new THREE.Vector3(x, 0, z),
        velocity: new THREE.Vector3(),
        lastUpdateAt: now,
        settling: false,
      };
      this.chessSet.setRemoteWalkExclude(coord);
      return;
    }

    // Velocity between the last two samples drives the dead reckoning.
    const dt = Math.max(0.02, (now - walk.lastUpdateAt) / 1000);
    walk.velocity.set((x - walk.target.x) / dt, 0, (z - walk.target.z) / dt);
    if (walk.velocity.length() > REMOTE_WALK_MAX_SPEED) {
      walk.velocity.setLength(REMOTE_WALK_MAX_SPEED);
    }
    walk.target.set(x, 0, z);
    walk.lastUpdateAt = now;
    walk.settling = false;
  }

  /**
   * Glide the friend's walking piece toward its dead-reckoned target each
   * frame: briefly extrapolate along the last reported velocity, then smooth
   * toward that point, so 12 Hz updates read as one continuous, personal
   * walk — hesitations, reversals and retreats included.
   */
  private updateRemoteWalk(delta: number): void {
    const walk = this.remoteWalk;
    if (!walk) return;

    const group = this.chessSet.getPiece(walk.coord);
    if (!group) {
      // The piece left the square (move applied, capture); preview is over.
      this.clearRemoteWalk();
      return;
    }

    // Stream went silent mid-walk (e.g. the friend lost connection): walk
    // the piece back onto its square instead of leaving it floating.
    const age = (performance.now() - walk.lastUpdateAt) / 1000;
    if (!walk.settling && age > REMOTE_WALK_TIMEOUT_S) {
      const square = coordToSquare(walk.coord);
      const home = squareCenter(square.file, square.rank);
      walk.target.set(home.x, 0, home.z);
      walk.velocity.set(0, 0, 0);
      walk.settling = true;
    }

    const lead = Math.min(age, REMOTE_WALK_MAX_LEAD_S);
    this.tmpRemoteTarget.copy(walk.target).addScaledVector(walk.velocity, lead);

    const t = Math.min(1, REMOTE_WALK_SMOOTH_RATE * delta);
    group.position.x = THREE.MathUtils.lerp(group.position.x, this.tmpRemoteTarget.x, t);
    group.position.z = THREE.MathUtils.lerp(group.position.z, this.tmpRemoteTarget.z, t);

    if (walk.settling) {
      const dx = group.position.x - walk.target.x;
      const dz = group.position.z - walk.target.z;
      if (dx * dx + dz * dz < REMOTE_WALK_SETTLE_RADIUS * REMOTE_WALK_SETTLE_RADIUS) {
        group.position.set(walk.target.x, 0, walk.target.z);
        this.clearRemoteWalk();
      }
    }
  }

  private clearRemoteWalk(): void {
    if (!this.remoteWalk) return;
    this.remoteWalk = null;
    this.chessSet.setRemoteWalkExclude(null);
  }

  /**
   * Replay server history the local engine is missing. A single fresh enemy
   * ply plays out with the leap-and-walk ceremony; anything else (reconnect
   * catch-up, plies of both colors) applies instantly.
   */
  private syncToHistory(history: string[]): void {
    const localPlies = this.engine.history().length + this.pendingRemotePlies;
    const pending = history.slice(localPlies);

    for (const san of pending) {
      const move = this.engine.moveFromSan(san);
      if (!move) {
        console.error(`[online] cannot replay "${san}" — client out of sync with the server`);
        return;
      }
      const animate = this.inGame && pending.length === 1 && move.color === this.opponentColor;
      if (animate) {
        this.pendingRemotePlies++;
        this.animateEnemyMove(move, () => {
          this.pendingRemotePlies--;
          this.updateHud();
          this.updateHint();
        });
      } else {
        this.applyRemoteMove(move);
      }
    }
  }

  /** " (CPU)" / " (you)" / " (friend)" suffix for a color, mode-dependent. */
  private colorTag(color: PieceColor): string {
    if (this.mode === 'cpu') return color === this.cpuColor ? ' (CPU)' : '';
    if (this.mode === 'online') return color === this.playerColor ? ' (you)' : ' (friend)';
    return '';
  }

  private updateHud(): void {
    if (!this.hud) return;

    if (this.resignWinner) {
      this.hud.textContent = `${capitalize(this.resignWinner)}${this.colorTag(this.resignWinner)} wins by resignation`;
      this.gameOver = true;
      return;
    }

    const toMove = capitalize(this.engine.turn) + this.colorTag(this.engine.turn);
    const winner =
      capitalize(oppositeColor(this.engine.turn)) + this.colorTag(oppositeColor(this.engine.turn));

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

    if (this.mode === 'online') {
      if (!this.serverConnected) {
        this.hint.textContent = 'Connection lost \u2014 reconnecting\u2026';
        return;
      }
      if (!this.opponentJoined) {
        const code = this.onlineSession?.code ?? '';
        this.hint.textContent = `Waiting for your friend to join \u2014 invite code ${code}`;
        return;
      }
      if (this.engine.turn !== this.playerColor) {
        this.hint.textContent = this.opponentPresent
          ? 'Waiting for your friend\u2019s move\u2026'
          : 'Friend disconnected \u2014 waiting for them to return\u2026';
        return;
      }
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

  /**
   * Screen-edge arrow pointing toward the enemy's possession marker whenever
   * it is outside the view, so the player can swing the camera to find it.
   */
  private updateEnemyPointer(): void {
    const pointer = this.enemyPointer;
    if (!pointer) return;

    const enemyColor = this.opponentColor;
    if (!enemyColor || !this.enemyPossessedCoord || !this.controller.isLocked) {
      pointer.classList.add('hidden');
      return;
    }

    // Aim at the middle of the piece the enemy occupies, not at the floating
    // gem above it.
    const group = this.chessSet.getPiece(this.enemyPossessedCoord);
    const occupant = this.engine.pieceAt(coordToSquare(this.enemyPossessedCoord));
    if (!group || !occupant) {
      pointer.classList.add('hidden');
      return;
    }
    const target = this.tmpPointerTarget.set(
      group.position.x,
      group.position.y + PIECE_EYE_HEIGHT[occupant.type] / 2,
      group.position.z,
    );

    // A projection alone is ambiguous: points behind the camera also land in
    // [-1, 1], mirrored. Check facing first, then flip the direction.
    this.tmpToMarker.copy(target).sub(this.camera.position);
    this.camera.getWorldDirection(this.tmpCamForward);
    const inFront = this.tmpToMarker.dot(this.tmpCamForward) > 0;

    this.tmpProjected.copy(target).project(this.camera);
    if (
      inFront &&
      Math.abs(this.tmpProjected.x) <= POINTER_EDGE_NDC &&
      Math.abs(this.tmpProjected.y) <= POINTER_EDGE_NDC
    ) {
      pointer.classList.add('hidden');
      return;
    }

    // Screen-space direction from the screen center toward the marker
    // (pixel coordinates, y grows downward).
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    let dirX = this.tmpProjected.x * halfW;
    let dirY = -this.tmpProjected.y * halfH;
    if (!inFront) {
      dirX = -dirX;
      dirY = -dirY;
    }
    const length = Math.hypot(dirX, dirY) || 1;
    dirX /= length;
    dirY /= length;

    // Pin the pointer where that direction exits the screen rectangle.
    const scale = Math.min(
      (halfW - POINTER_MARGIN_PX) / Math.max(Math.abs(dirX), 1e-6),
      (halfH - POINTER_MARGIN_PX) / Math.max(Math.abs(dirY), 1e-6),
    );
    const x = halfW + dirX * scale;
    const y = halfH + dirY * scale;
    const angle = Math.atan2(dirY, dirX);

    pointer.style.setProperty('--x', `${x.toFixed(1)}px`);
    pointer.style.setProperty('--y', `${y.toFixed(1)}px`);
    pointer.style.setProperty('--angle', `${angle.toFixed(4)}rad`);

    if (this.enemyPointerGlyph) {
      this.enemyPointerGlyph.textContent = PIECE_GLYPHS[occupant.type];
    }
    pointer.classList.toggle('white', enemyColor === 'white');
    pointer.classList.toggle('black', enemyColor === 'black');
    pointer.classList.remove('hidden');
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

    document
      .getElementById('mode-online')
      ?.addEventListener('click', () => void this.openOnlineLobby(null));

    document.getElementById('online-start')?.addEventListener('click', () => {
      if (this.onlineSession) begin('online', this.onlineSession.color);
    });

    document.getElementById('copy-link')?.addEventListener('click', (event) => {
      const input = document.getElementById('invite-link') as HTMLInputElement | null;
      const button = event.currentTarget as HTMLButtonElement;
      if (!input) return;
      void navigator.clipboard.writeText(input.value).then(() => {
        button.textContent = 'Copied!';
        window.setTimeout(() => (button.textContent = 'Copy'), 1500);
      });
    });

    // Opened via an invite link (…?join=CODE): go straight to the lobby.
    const joinCode = new URLSearchParams(window.location.search).get('join');
    if (joinCode) void this.openOnlineLobby(joinCode);
  }

  /**
   * Online lobby on the menu: create (or join) the game, connect to the
   * server, and show the invite link. The game itself starts on a click so
   * pointer lock is granted by a user gesture.
   */
  private async openOnlineLobby(joinCode: string | null): Promise<void> {
    const status = document.getElementById('online-status');
    document.querySelector('#menu .modes')?.classList.add('hidden');
    document.getElementById('online-panel')?.classList.remove('hidden');
    if (status) {
      status.textContent = joinCode
        ? `Joining game ${joinCode.toUpperCase()}\u2026`
        : 'Creating game\u2026';
    }

    let session: OnlineSession;
    try {
      session = joinCode ? await joinOnlineGame(joinCode) : await createOnlineGame();
    } catch (error) {
      if (status) {
        status.textContent = error instanceof Error ? error.message : 'Failed to reach the server';
      }
      return;
    }

    this.onlineSession = session;
    this.online = new OnlineClient(session);
    this.online.onMessage = (message) => this.handleServerMessage(message);
    this.online.onConnection = (connected) => {
      this.serverConnected = connected;
      if (this.inGame) this.updateHint();
    };
    this.online.connect();

    const inviteLink = document.getElementById('invite-link') as HTMLInputElement | null;
    if (inviteLink) {
      inviteLink.value = `${location.origin}${location.pathname}?join=${session.code}`;
    }
    document.getElementById('invite-row')?.classList.remove('hidden');
    document.getElementById('online-start')?.classList.remove('hidden');
    this.updateLobbyStatus();
  }

  private updateLobbyStatus(): void {
    if (this.inGame || !this.onlineSession) return;
    const status = document.getElementById('online-status');
    if (!status) return;
    const you = `You play ${this.onlineSession.color}.`;
    status.textContent = this.opponentJoined
      ? `Friend joined! ${you} Enter the game when ready.`
      : `${you} Send the invite link to a friend \u2014 you can enter the game while you wait.`;
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
