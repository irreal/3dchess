import * as THREE from 'three';
import { squareCenter } from '../constants';
import type { Move, Square } from '../chess/types';

/** A legal landing square along a corridor. */
export interface RestPoint {
  /** Distance along the corridor at which this square's center sits. */
  dist: number;
  move: Move;
}

/**
 * A walkable rail built from a piece's legal moves. The possessed piece can
 * only ever stand somewhere on one of these polylines, so it never visits an
 * illegal square.
 */
export interface Corridor {
  /** Polyline through square centers (y = 0), starting at the piece's square. */
  points: THREE.Vector3[];
  /** Cumulative distance at each polyline point. */
  cumulative: number[];
  length: number;
  /** Legal landing squares along the corridor, sorted near to far. */
  restPoints: RestPoint[];
}

function center(square: Square): THREE.Vector3 {
  const { x, z } = squareCenter(square.file, square.rank);
  return new THREE.Vector3(x, 0, z);
}

function steps(move: Move): number {
  return Math.max(
    Math.abs(move.to.file - move.from.file),
    Math.abs(move.to.rank - move.from.rank),
  );
}

function makeCorridor(points: THREE.Vector3[], restPoints: RestPoint[]): Corridor {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + points[i].distanceTo(points[i - 1]));
  }
  restPoints.sort((a, b) => a.dist - b.dist);
  return { points, cumulative, length: cumulative[cumulative.length - 1], restPoints };
}

/**
 * Build corridors from a piece's legal moves. Straight-line moves sharing a
 * direction merge into a single ray with one rest point per legal square
 * (so a rook ray covers e.g. e2/e3/e4 in one corridor). Knight moves become
 * L-shaped paths — long leg first — whose only rest point is the destination,
 * since the in-between squares are not legal landing spots.
 */
export function buildCorridors(moves: Move[]): Corridor[] {
  const corridors: Corridor[] = [];
  const rays = new Map<string, Move[]>();

  for (const move of moves) {
    const df = move.to.file - move.from.file;
    const dr = move.to.rank - move.from.rank;

    if (move.piece === 'knight') {
      const elbow: Square =
        Math.abs(df) === 2
          ? { file: move.to.file, rank: move.from.rank }
          : { file: move.from.file, rank: move.to.rank };
      const corridor = makeCorridor([center(move.from), center(elbow), center(move.to)], []);
      corridor.restPoints.push({ dist: corridor.length, move });
      corridors.push(corridor);
    } else {
      const key = `${Math.sign(df)},${Math.sign(dr)}`;
      const ray = rays.get(key);
      if (ray) {
        ray.push(move);
      } else {
        rays.set(key, [move]);
      }
    }
  }

  for (const ray of rays.values()) {
    let furthest = ray[0];
    for (const move of ray) {
      if (steps(move) > steps(furthest)) furthest = move;
    }

    const origin = center(furthest.from);
    const end = center(furthest.to);
    const stepLength = origin.distanceTo(end) / steps(furthest);

    corridors.push(
      makeCorridor(
        [origin, end],
        ray.map((move) => ({ dist: steps(move) * stepLength, move })),
      ),
    );
  }

  return corridors;
}

/** World position at a distance along the corridor. */
export function positionAt(corridor: Corridor, dist: number, out: THREE.Vector3): THREE.Vector3 {
  const d = THREE.MathUtils.clamp(dist, 0, corridor.length);
  for (let i = 1; i < corridor.points.length; i++) {
    if (d <= corridor.cumulative[i] || i === corridor.points.length - 1) {
      const segStart = corridor.cumulative[i - 1];
      const segLength = corridor.cumulative[i] - segStart;
      const t = segLength > 0 ? (d - segStart) / segLength : 0;
      return out.lerpVectors(corridor.points[i - 1], corridor.points[i], t);
    }
  }
  return out.copy(corridor.points[0]);
}

/**
 * Unit tangent at a distance along the corridor. Exactly at a corner the
 * *next* segment's tangent is returned, so callers probing with a small
 * +/- epsilon get the correct direction on either side of the corner.
 */
export function tangentAt(corridor: Corridor, dist: number, out: THREE.Vector3): THREE.Vector3 {
  const d = THREE.MathUtils.clamp(dist, 0, corridor.length);
  for (let i = 1; i < corridor.points.length; i++) {
    if (d < corridor.cumulative[i] || i === corridor.points.length - 1) {
      return out.subVectors(corridor.points[i], corridor.points[i - 1]).normalize();
    }
  }
  return out.set(0, 0, 1);
}
