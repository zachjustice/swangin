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
  // Reused per-frame to avoid GC churn in the camera-ray hot path. The Ray's
  // origin/dir are mutated in place each update(); hitPointScratch holds the
  // computed hit point (referenced externally via `hitPoint`, so callers see
  // an updated value without us allocating).
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private readonly hitPointScratch = new THREE.Vector3();
  private hitTime = -1;

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
    this.ray.origin.x = camera.position.x;
    this.ray.origin.y = camera.position.y;
    this.ray.origin.z = camera.position.z;
    this.ray.dir.x = this.tmpDir.x;
    this.ray.dir.y = this.tmpDir.y;
    this.ray.dir.z = this.tmpDir.z;

    const hit = this.world.castRay(this.ray, MAX_RAY_DIST, true, undefined, QUERY_GROUPS);
    const now = Date.now();
    if (hit) {
      this.hitTime = now;

      const pos = hit.collider.translation();
      this.highlight.position.set(pos.x, pos.y, pos.z);
      this.highlight.visible = true;
      this.hitPointScratch.set(
        camera.position.x + this.tmpDir.x * hit.timeOfImpact,
        camera.position.y + this.tmpDir.y * hit.timeOfImpact,
        camera.position.z + this.tmpDir.z * hit.timeOfImpact,
      );
      this.hitPoint = this.hitPointScratch;

      return;
    } else if (!hit && (now - this.hitTime) > 1000) {
      this.highlight.visible = false;
      this.hitPoint = null;
      return;
    }
  }
}
