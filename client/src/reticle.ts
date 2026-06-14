import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CUBE_SIZE } from './world.ts';
import { ALL_RAGDOLL_BITS } from './ragdoll-proportions.ts';

// InteractionGroups filter: query interacts with everyone except any bit
// a ragdoll part carries (base + role bits — see ALL_RAGDOLL_BITS).
// Cube colliders use default membership 0xFFFF, so they pass.
const QUERY_GROUPS = (0xffff << 16) | (0xffff & ~ALL_RAGDOLL_BITS);
const MAX_RAY_DIST = 200;

export class CubeReticle {
  // World-space hit point of the last raycast, or null if the reticle missed.
  hitPoint: THREE.Vector3 | null = null;

  private readonly highlight: THREE.LineSegments;
  private readonly tmpDir = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly world: RAPIER.World) {
    const box = new THREE.BoxGeometry(CUBE_SIZE * 1.04, CUBE_SIZE * 1.04, CUBE_SIZE * 1.04);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x9fffe6 }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);
  }

  // Cast forward from the camera (screen center) and highlight the cube hit.
  update(camera: THREE.PerspectiveCamera): void {
    camera.getWorldDirection(this.tmpDir);
    const ray = new RAPIER.Ray(
      { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      { x: this.tmpDir.x, y: this.tmpDir.y, z: this.tmpDir.z },
    );
    const hit = this.world.castRay(ray, MAX_RAY_DIST, true, undefined, QUERY_GROUPS);
    if (!hit) {
      this.highlight.visible = false;
      this.hitPoint = null;
      return;
    }
    const pos = hit.collider.translation();
    this.highlight.position.set(pos.x, pos.y, pos.z);
    this.highlight.visible = true;
    this.hitPoint = new THREE.Vector3(
      camera.position.x + this.tmpDir.x * hit.timeOfImpact,
      camera.position.y + this.tmpDir.y * hit.timeOfImpact,
      camera.position.z + this.tmpDir.z * hit.timeOfImpact,
    );
  }
}
