import * as THREE from 'three';
import { SQUARE_SIZE, squareCenter } from '../constants';
import type { Move, Square } from '../chess/types';

/**
 * Highlights for the currently selected piece: a yellow plane under the
 * selected square, green dots on quiet target squares and red rings on
 * capture squares. Marker meshes are pooled and reused.
 */
export class MoveHighlights {
  readonly object: THREE.Group;

  private readonly selectedMesh: THREE.Mesh;
  private readonly dotPool: THREE.Mesh[] = [];
  private readonly ringPool: THREE.Mesh[] = [];

  private readonly dotGeometry = new THREE.CircleGeometry(SQUARE_SIZE * 0.18, 24);
  private readonly ringGeometry = new THREE.RingGeometry(SQUARE_SIZE * 0.34, SQUARE_SIZE * 0.44, 32);
  private readonly dotMaterial = new THREE.MeshBasicMaterial({
    color: 0x33dd77,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });
  private readonly ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xee4444,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'move-highlights';

    this.selectedMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(SQUARE_SIZE, SQUARE_SIZE),
      new THREE.MeshBasicMaterial({
        color: 0xffcc33,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    this.selectedMesh.rotation.x = -Math.PI / 2;
    this.selectedMesh.visible = false;
    this.object.add(this.selectedMesh);
  }

  show(selected: Square, moves: Move[]): void {
    this.hideMarkers();

    const { x, z } = squareCenter(selected.file, selected.rank);
    this.selectedMesh.position.set(x, 0.02, z);
    this.selectedMesh.visible = true;

    let dots = 0;
    let rings = 0;
    for (const move of moves) {
      const marker = move.captured
        ? this.getMarker(this.ringPool, this.ringGeometry, this.ringMaterial, rings++)
        : this.getMarker(this.dotPool, this.dotGeometry, this.dotMaterial, dots++);

      const target = squareCenter(move.to.file, move.to.rank);
      marker.position.set(target.x, 0.03, target.z);
      marker.visible = true;
    }
  }

  clear(): void {
    this.selectedMesh.visible = false;
    this.hideMarkers();
  }

  private hideMarkers(): void {
    for (const marker of this.dotPool) marker.visible = false;
    for (const marker of this.ringPool) marker.visible = false;
  }

  private getMarker(
    pool: THREE.Mesh[],
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    index: number,
  ): THREE.Mesh {
    let marker = pool[index];
    if (!marker) {
      marker = new THREE.Mesh(geometry, material);
      marker.rotation.x = -Math.PI / 2;
      pool.push(marker);
      this.object.add(marker);
    }
    return marker;
  }
}
