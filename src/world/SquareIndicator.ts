import * as THREE from 'three';
import { SQUARE_SIZE } from '../constants';
import type { Piece, PieceType } from '../chess/types';

const LABEL_ANCHOR_HEIGHT = 1.0; // point above the square the label leans toward
const LABEL_DISTANCE = 2.2; // fixed distance from the camera, in meters
const LABEL_CANVAS_WIDTH = 256;
const LABEL_CANVAS_HEIGHT = 128;

/** Solid chess glyphs; we tint them with the piece color when drawing. */
const PIECE_GLYPHS: Record<PieceType, string> = {
  king: '\u265A',
  queen: '\u265B',
  rook: '\u265C',
  bishop: '\u265D',
  knight: '\u265E',
  pawn: '\u265F',
};

/**
 * Visual indicator for the square the player is looking at:
 * a translucent highlight on the square and a floating text label
 * showing its algebraic coordinate.
 */
export class SquareIndicator {
  readonly object: THREE.Group;

  private readonly highlight: THREE.Mesh;
  private readonly label: THREE.Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly labelAnchor = new THREE.Vector3();
  private currentLabelKey: string | null = null;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'square-indicator';
    this.object.visible = false;

    // Highlight plane, slightly above the board surface to avoid z-fighting.
    this.highlight = new THREE.Mesh(
      new THREE.PlaneGeometry(SQUARE_SIZE, SQUARE_SIZE),
      new THREE.MeshBasicMaterial({
        color: 0x55ff99,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    this.highlight.rotation.x = -Math.PI / 2;
    this.highlight.position.y = 0.012;
    this.object.add(this.highlight);

    // Floating text label rendered onto a canvas texture.
    this.canvas = document.createElement('canvas');
    this.canvas.width = LABEL_CANVAS_WIDTH;
    this.canvas.height = LABEL_CANVAS_HEIGHT;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create 2D canvas context for square label');
    }
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
        depthTest: false, // never obscured by world geometry
      }),
    );
    this.label.renderOrder = 999; // draw after everything else
    this.label.scale.set(0.6, 0.3, 1);
    this.object.add(this.label);
  }

  /**
   * Show the indicator over a square.
   * @param center World position of the square's center (top surface).
   * @param text Label text: a coordinate ("e4") or move notation ("Nxd5+").
   * @param camera Camera used to keep the label floating at a fixed distance.
   * @param piece Piece occupying the square, shown as a colored icon.
   */
  show(center: THREE.Vector3, text: string, camera: THREE.Camera, piece?: Piece): void {
    this.object.position.set(center.x, 0, center.z);
    this.object.visible = true;

    // Float the label a fixed distance in front of the camera, leaning toward
    // a point above the square so it stays near (but not on) the crosshair.
    this.labelAnchor.set(center.x, LABEL_ANCHOR_HEIGHT, center.z).sub(camera.position).normalize();
    this.label.position
      .copy(camera.position)
      .addScaledVector(this.labelAnchor, LABEL_DISTANCE)
      .sub(this.object.position); // to local space (group is only translated)

    const labelKey = piece ? `${text}:${piece.color}-${piece.type}` : text;
    if (labelKey !== this.currentLabelKey) {
      this.currentLabelKey = labelKey;
      this.drawLabel(text, piece);
    }
  }

  hide(): void {
    this.object.visible = false;
    this.currentLabelKey = null;
  }

  private drawLabel(text: string, piece?: Piece): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Rounded pill background.
    const radius = 28;
    ctx.fillStyle = 'rgba(20, 24, 28, 0.85)';
    ctx.beginPath();
    ctx.roundRect(8, 8, w - 16, h - 16, radius);
    ctx.fill();
    ctx.strokeStyle = 'rgba(85, 255, 153, 0.9)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Measure coordinate text and optional piece icon so the pair is centered.
    const textFont = 'bold 72px system-ui, sans-serif';
    const glyphFont = '76px serif'; // chess glyphs render best in serif fonts
    const gap = 14;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    ctx.font = textFont;
    const textWidth = ctx.measureText(text).width;

    let glyph: string | null = null;
    let glyphWidth = 0;
    if (piece) {
      glyph = PIECE_GLYPHS[piece.type];
      ctx.font = glyphFont;
      glyphWidth = ctx.measureText(glyph).width;
    }

    const totalWidth = textWidth + (glyph ? gap + glyphWidth : 0);
    let x = (w - totalWidth) / 2;

    // Coordinate text.
    ctx.font = textFont;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, h / 2 + 4);
    x += textWidth + gap;

    // Piece icon, tinted to match the piece with a contrasting outline.
    if (glyph && piece) {
      ctx.font = glyphFont;
      ctx.lineWidth = 3;
      if (piece.color === 'white') {
        ctx.fillStyle = '#f0e9dc';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      } else {
        ctx.fillStyle = '#262220';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      }
      ctx.fillText(glyph, x, h / 2 + 4);
      ctx.strokeText(glyph, x, h / 2 + 4);
    }

    this.texture.needsUpdate = true;
  }
}
