import * as THREE from 'three';
import { SQUARE_SIZE, squareCenter } from '../constants';
import type { Square } from '../chess/types';

const SHAFT_WIDTH = SQUARE_SIZE * 0.18;
const HEAD_WIDTH = SQUARE_SIZE * 0.46;
const HEAD_LENGTH = SQUARE_SIZE * 0.42;
/** The tip stops short of the destination center so the head isn't buried under the piece. */
const TIP_PULLBACK = SQUARE_SIZE * 0.3;
/** Above the move highlights (dots at 0.03) so the arrow always reads on top. */
const ARROW_Y = 0.035;

/**
 * A flat arrow lying on the board from the origin square of the opponent's
 * last move to its destination, so the player can spot what just happened
 * even if they were looking elsewhere when the piece walked.
 */
export class LastMoveArrow {
  readonly object: THREE.Group;

  private readonly mesh: THREE.Mesh;
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xff8c2e,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'last-move-arrow';
    this.object.visible = false;

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    // Lay the shape flat: its local +y (arrow forward) maps to the group's -z.
    this.mesh.rotation.x = -Math.PI / 2;
    this.object.add(this.mesh);
  }

  show(from: Square, to: Square): void {
    const a = squareCenter(from.file, from.rank);
    const b = squareCenter(to.file, to.rank);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) - TIP_PULLBACK;
    if (length <= 0) return;

    // Keep some shaft visible even on the shortest (one-square) arrows.
    const headLength = Math.min(HEAD_LENGTH, length * 0.55);

    const shape = new THREE.Shape();
    shape.moveTo(-SHAFT_WIDTH / 2, 0);
    shape.lineTo(-SHAFT_WIDTH / 2, length - headLength);
    shape.lineTo(-HEAD_WIDTH / 2, length - headLength);
    shape.lineTo(0, length);
    shape.lineTo(HEAD_WIDTH / 2, length - headLength);
    shape.lineTo(SHAFT_WIDTH / 2, length - headLength);
    shape.lineTo(SHAFT_WIDTH / 2, 0);
    shape.closePath();

    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.ShapeGeometry(shape);

    this.object.position.set(a.x, ARROW_Y, a.z);
    // Yaw that points the group's local -z (the arrow's forward) at `to`.
    this.object.rotation.y = Math.atan2(-dx, -dz);
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
  }
}
