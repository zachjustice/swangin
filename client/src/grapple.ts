import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { GRAPPLE_COLOR, GRAPPLE_LINE_WIDTH } from './constants.ts';

// Rigid fixed-length grapple: a rope joint between the hand and a one-off fixed
// body parked at the surface hit point. Rope acts rigid when taut, so a slack
// factor of 1.0 starts taut (full pendulum). >1.0 leaves some give.

export class Grapple {
  slackFactor = 1.0;

  private joint: RAPIER.ImpulseJoint | null = null;
  private anchorBody: RAPIER.RigidBody | null = null;
  private readonly line: Line2;
  private readonly lineGeom: LineGeometry;
  private readonly tmpHandWorld = new THREE.Vector3();
  private readonly tmpHandQuat = new THREE.Quaternion();

  constructor(
    scene: THREE.Scene,
    private readonly world: RAPIER.World,
    private readonly hand: RAPIER.RigidBody,
    private readonly handLocal: THREE.Vector3,
  ) {
    this.lineGeom = new LineGeometry();
    this.lineGeom.setPositions([0, 0, 0, 0, 0, 0]);
    // worldUnits → linewidth is in world units, so perspective tapers the far
    // end naturally. HDR color punches through the bloom threshold for a slight
    // halo via the existing UnrealBloomPass.
    const mat = new LineMaterial({
      color: GRAPPLE_COLOR,
      linewidth: GRAPPLE_LINE_WIDTH,
      worldUnits: true,
      transparent: true,
    });
    this.line = new Line2(this.lineGeom, mat);
    this.line.visible = false;
    // Endpoints span the whole world; skip culling to avoid pops.
    this.line.frustumCulled = false;
    scene.add(this.line);
  }

  get isActive(): boolean {
    return this.joint !== null;
  }

  // World-space position of the anchor body, or null if no grapple is active.
  // Re-uses an internal vector — callers should treat it as read-only per call.
  private readonly tmpAnchor = new THREE.Vector3();
  get anchorPos(): THREE.Vector3 | null {
    if (!this.anchorBody) return null;
    const t = this.anchorBody.translation();
    return this.tmpAnchor.set(t.x, t.y, t.z);
  }

  fire(anchorWorld: THREE.Vector3): void {
    this.release();

    this.handWorldPos(this.tmpHandWorld);
    const length = this.tmpHandWorld.distanceTo(anchorWorld) * this.slackFactor;

    this.anchorBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(anchorWorld.x, anchorWorld.y, anchorWorld.z),
    );
    const params = RAPIER.JointData.rope(
      length,
      { x: this.handLocal.x, y: this.handLocal.y, z: this.handLocal.z },
      { x: 0, y: 0, z: 0 },
    );
    this.joint = this.world.createImpulseJoint(params, this.hand, this.anchorBody, true);
    this.line.visible = true;
  }

  release(): void {
    if (this.joint) {
      this.world.removeImpulseJoint(this.joint, true);
      this.joint = null;
    }
    if (this.anchorBody) {
      this.world.removeRigidBody(this.anchorBody);
      this.anchorBody = null;
    }
    this.line.visible = false;
  }

  update(): void {
    if (!this.anchorBody) return;
    this.handWorldPos(this.tmpHandWorld);
    const a = this.anchorBody.translation();
    this.lineGeom.setPositions([
      this.tmpHandWorld.x, this.tmpHandWorld.y, this.tmpHandWorld.z,
      a.x, a.y, a.z,
    ]);
  }

  private handWorldPos(out: THREE.Vector3): void {
    const t = this.hand.translation();
    const r = this.hand.rotation();
    this.tmpHandQuat.set(r.x, r.y, r.z, r.w);
    out.copy(this.handLocal).applyQuaternion(this.tmpHandQuat);
    out.x += t.x;
    out.y += t.y;
    out.z += t.z;
  }
}
