import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  GRAPPLE_COLOR, GRAPPLE_LINE_WIDTH,
  GRAPPLE_MAX_LENGTH, GRAPPLE_MIN_LENGTH,
  GRAPPLE_REEL_SPEED, GRAPPLE_DASH_REEL_SPEED,
} from './constants.ts';

// Rigid grapple: a rope joint between the hand and a fixed anchor body.
// Supports reel-in (Space) and reel-out (Shift) by recreating the joint each
// frame with the updated length. Rapier's RopeImpulseJoint doesn't expose a
// setLength setter, so remove+create is the cheapest correct path.

interface ReelMode {
  direction: 'in' | 'out' | null;
  dash: boolean;
}

const NO_REEL: ReelMode = { direction: null, dash: false };
const JOINT_RECREATE_EPSILON = 0.01; // metres; skip recreate below this delta

export class Grapple {

  private joint: RAPIER.ImpulseJoint | null = null;
  private anchorBody: RAPIER.RigidBody | null = null;
  private readonly line: Line2;
  private readonly lineGeom: LineGeometry;
  private readonly tmpHandWorld = new THREE.Vector3();
  private readonly tmpHandQuat = new THREE.Quaternion();
  private currentLength = 0;
  private jointLength = 0; // length the live joint was created with
  private mode: ReelMode = NO_REEL;

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
    const length = Math.min(this.tmpHandWorld.distanceTo(anchorWorld), GRAPPLE_MAX_LENGTH);
    this.currentLength = length;

    this.anchorBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(anchorWorld.x, anchorWorld.y, anchorWorld.z),
    );
    this.joint = this.createJoint(length);
    this.jointLength = length;
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
    this.mode = NO_REEL;
    this.line.visible = false;
  }

  setReelMode(mode: ReelMode): void {
    this.mode = mode;
  }

  update(dtSec: number): void {
    if (!this.anchorBody || !this.joint) return;

    if (this.mode.direction !== null) {
      const rate = this.mode.direction === 'in'
        ? (this.mode.dash ? GRAPPLE_DASH_REEL_SPEED : GRAPPLE_REEL_SPEED)
        : GRAPPLE_REEL_SPEED;

      if (this.mode.direction === 'in') {
        this.currentLength = Math.max(GRAPPLE_MIN_LENGTH, this.currentLength - rate * dtSec);
        if (this.currentLength <= GRAPPLE_MIN_LENGTH) {
          this.release();
          return;
        }
      } else {
        this.currentLength = Math.min(GRAPPLE_MAX_LENGTH, this.currentLength + rate * dtSec);
      }

      // Recreate the joint with the updated length (Rapier has no setLength on RopeJoint).
      // Skip when the delta is sub-centimetre to avoid thrashing WASM at render rate.
      if (Math.abs(this.currentLength - this.jointLength) >= JOINT_RECREATE_EPSILON) {
        this.world.removeImpulseJoint(this.joint, true);
        this.joint = this.createJoint(this.currentLength);
        this.jointLength = this.currentLength;
      }
    }

    this.syncLine();
  }

  // Update rope line geometry to match current hand and anchor positions.
  // Call once per frame AFTER world.step() so endpoints track post-step bodies.
  syncLine(): void {
    if (!this.anchorBody) return;
    this.handWorldPos(this.tmpHandWorld);
    const a = this.anchorBody.translation();
    this.lineGeom.setPositions([
      this.tmpHandWorld.x, this.tmpHandWorld.y, this.tmpHandWorld.z,
      a.x, a.y, a.z,
    ]);
  }

  private createJoint(length: number): RAPIER.ImpulseJoint {
    const params = RAPIER.JointData.rope(
      length,
      { x: this.handLocal.x, y: this.handLocal.y, z: this.handLocal.z },
      { x: 0, y: 0, z: 0 },
    );
    return this.world.createImpulseJoint(params, this.hand, this.anchorBody!, true);
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
