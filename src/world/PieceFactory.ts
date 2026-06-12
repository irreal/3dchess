import * as THREE from 'three';
import type { PieceColor, PieceType } from '../chess/types';

export type { PieceColor, PieceType };

const LATHE_SEGMENTS = 48;

type ProfilePoint = [radius: number, y: number];

/** Generate points along a circular arc for lathe profiles (sphere sections). */
function arc(
  centerY: number,
  radius: number,
  fromT: number,
  toT: number,
  segments = 12,
): ProfilePoint[] {
  // t = 0 is the bottom of the sphere, t = PI is the top.
  const points: ProfilePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = THREE.MathUtils.lerp(fromT, toT, i / segments);
    points.push([radius * Math.sin(t), centerY - radius * Math.cos(t)]);
  }
  return points;
}

function latheMesh(profile: ProfilePoint[]): THREE.Mesh {
  const points = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  const geometry = new THREE.LatheGeometry(points, LATHE_SEGMENTS);
  return new THREE.Mesh(geometry);
}

/**
 * Builds human-sized procedural chess pieces. Geometry is created once per
 * piece type and shared between all instances via clone().
 *
 * All pieces stand on y = 0. Approximate heights: pawn 1.1m up to king 1.85m,
 * so they are roughly as tall as the player (eye height 1.7m).
 */
export class PieceFactory {
  private readonly templates = new Map<PieceType, THREE.Group>();

  private readonly materials: Record<PieceColor, THREE.MeshStandardMaterial> = {
    white: new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.3, metalness: 0.05 }),
    black: new THREE.MeshStandardMaterial({ color: 0x262220, roughness: 0.35, metalness: 0.15 }),
  };

  create(type: PieceType, color: PieceColor): THREE.Group {
    let template = this.templates.get(type);
    if (!template) {
      template = this.build(type);
      this.templates.set(type, template);
    }

    const piece = template.clone(true);
    const material = this.materials[color];
    piece.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = material;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return piece;
  }

  private build(type: PieceType): THREE.Group {
    switch (type) {
      case 'pawn':
        return this.buildPawn();
      case 'rook':
        return this.buildRook();
      case 'knight':
        return this.buildKnight();
      case 'bishop':
        return this.buildBishop();
      case 'queen':
        return this.buildQueen();
      case 'king':
        return this.buildKing();
    }
  }

  private buildPawn(): THREE.Group {
    const group = new THREE.Group();
    group.add(
      latheMesh([
        [0, 0],
        [0.34, 0],
        [0.36, 0.05],
        [0.32, 0.12],
        [0.2, 0.2],
        [0.14, 0.45],
        [0.115, 0.62],
        [0.2, 0.66],
        [0.21, 0.7],
        [0.13, 0.74],
        ...arc(0.92, 0.19, 0.6, Math.PI),
      ]),
    );
    return group;
  }

  private buildRook(): THREE.Group {
    const group = new THREE.Group();
    group.add(
      latheMesh([
        [0, 0],
        [0.36, 0],
        [0.38, 0.05],
        [0.34, 0.14],
        [0.24, 0.22],
        [0.2, 0.6],
        [0.19, 0.95],
        [0.26, 1.02],
        [0.27, 1.08],
        [0.27, 1.22],
        [0.18, 1.22],
        [0.18, 1.12],
        [0, 1.12],
      ]),
    );

    // Battlements around the top rim.
    const merlonGeometry = new THREE.BoxGeometry(0.13, 0.14, 0.08);
    const merlonCount = 6;
    for (let i = 0; i < merlonCount; i++) {
      const angle = (i / merlonCount) * Math.PI * 2;
      const merlon = new THREE.Mesh(merlonGeometry);
      merlon.position.set(Math.sin(angle) * 0.215, 1.28, Math.cos(angle) * 0.215);
      merlon.rotation.y = angle;
      group.add(merlon);
    }
    return group;
  }

  private buildKnight(): THREE.Group {
    const group = new THREE.Group();

    // Pedestal base.
    group.add(
      latheMesh([
        [0, 0],
        [0.36, 0],
        [0.38, 0.05],
        [0.33, 0.14],
        [0.22, 0.2],
        [0.18, 0.45],
        [0.22, 0.55],
        [0.26, 0.62],
        [0.24, 0.66],
        [0, 0.66],
      ]),
    );

    // Stylized horse head, extruded from a 2D outline. +x is the muzzle
    // direction in the shape; we rotate so the piece faces +z.
    const outline: [number, number][] = [
      [-0.2, 0],
      [-0.24, 0.3],
      [-0.17, 0.52],
      [-0.06, 0.6],
      [-0.02, 0.72],
      [0.04, 0.78],
      [0.07, 0.62],
      [0.2, 0.55],
      [0.3, 0.42],
      [0.31, 0.32],
      [0.2, 0.26],
      [0.12, 0.14],
      [0.16, 0],
    ];
    const shape = new THREE.Shape();
    shape.moveTo(outline[0][0], outline[0][1]);
    for (const [x, y] of outline.slice(1)) {
      shape.lineTo(x, y);
    }
    shape.closePath();

    const headGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.18,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 3,
    });
    headGeometry.translate(0, 0, -0.09); // center the extrusion depth

    const head = new THREE.Mesh(headGeometry);
    head.position.y = 0.64;
    head.rotation.y = -Math.PI / 2; // muzzle points toward +z
    group.add(head);

    return group;
  }

  private buildBishop(): THREE.Group {
    const group = new THREE.Group();
    group.add(
      latheMesh([
        [0, 0],
        [0.35, 0],
        [0.37, 0.05],
        [0.32, 0.14],
        [0.2, 0.2],
        [0.13, 0.6],
        [0.11, 0.9],
        [0.18, 0.95],
        [0.19, 1.0],
        [0.12, 1.05],
        [0.17, 1.15],
        [0.19, 1.28],
        [0.12, 1.42],
        [0.05, 1.47],
        ...arc(1.51, 0.055, 0.8, Math.PI),
      ]),
    );
    return group;
  }

  private buildQueen(): THREE.Group {
    const group = new THREE.Group();
    group.add(
      latheMesh([
        [0, 0],
        [0.38, 0],
        [0.4, 0.05],
        [0.35, 0.15],
        [0.22, 0.22],
        [0.15, 0.7],
        [0.12, 1.05],
        [0.19, 1.1],
        [0.2, 1.16],
        [0.13, 1.2],
        [0.22, 1.38],
        [0.25, 1.5],
        [0.17, 1.5],
        ...arc(1.48, 0.17, Math.PI * 0.5, Math.PI),
        ...arc(1.67, 0.05, 0.5, Math.PI),
      ]),
    );

    // Crown points.
    const pointGeometry = new THREE.SphereGeometry(0.045, 12, 8);
    const pointCount = 8;
    for (let i = 0; i < pointCount; i++) {
      const angle = (i / pointCount) * Math.PI * 2;
      const crownPoint = new THREE.Mesh(pointGeometry);
      crownPoint.position.set(Math.sin(angle) * 0.22, 1.54, Math.cos(angle) * 0.22);
      group.add(crownPoint);
    }
    return group;
  }

  private buildKing(): THREE.Group {
    const group = new THREE.Group();
    group.add(
      latheMesh([
        [0, 0],
        [0.4, 0],
        [0.42, 0.05],
        [0.37, 0.15],
        [0.23, 0.22],
        [0.16, 0.75],
        [0.13, 1.12],
        [0.2, 1.18],
        [0.21, 1.24],
        [0.14, 1.28],
        [0.22, 1.45],
        [0.24, 1.55],
        [0.16, 1.55],
        ...arc(1.53, 0.16, Math.PI * 0.5, Math.PI),
      ]),
    );

    // Cross on top.
    const vertical = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.22, 0.055));
    vertical.position.y = 1.76;
    const horizontal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.055, 0.055));
    horizontal.position.y = 1.78;
    group.add(vertical, horizontal);

    return group;
  }
}
