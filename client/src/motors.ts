import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  TORSO_RIGHTING_ENABLED, TORSO_RIGHTING_KP, TORSO_RIGHTING_KD,
  GRAPPLE_REACH_IMPULSE_ENABLED, GRAPPLE_REACH_IMPULSE_STRENGTH,
} from './ragdoll-tuning.ts';

// After mirroring mattvb91/rapierjs-ragdoll the skeleton is fully passive
// (spherical joints, no motors, no PD). This file used to be a 350-line
// stack of PD / cone PD / chain controllers; it now only does two
// optional things, both gated by ragdoll-tuning flags:
//
//   1. (off by default) A *very* weak torso-uprightness assist so the
//      character can eventually right itself after a hard fall.
//   2. (on by default) A small per-substep impulse on the forearm toward
//      the grapple anchor — same pattern mattvb91 uses for user-driven
//      force (body.applyImpulse).

export class RagdollMotors {
  // Toggleable from main.ts (M key) for A/B comparison. When false, all
  // assists are skipped — pure passive ragdoll.
  enabled = true;
  // Scales both the torso righting torque and the grapple reach impulse.
  globalMultiplier = 1.0;
  // Set by the host each substep: where the grapple is anchored, or null.
  grappleAnchor: THREE.Vector3 | null = null;

  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuatInv = new THREE.Quaternion();
  private readonly tmpReach = new THREE.Vector3();
  private readonly tmpShoulder = new THREE.Vector3();
  private readonly identity = new THREE.Quaternion();

  constructor(
    public torso: RAPIER.RigidBody,
    public grappleArm: RAPIER.RigidBody,
    // Shoulder offset in torso-local space — used to compute the reach
    // direction (anchor − shoulderWorld).
    public shoulderLocalOffset: THREE.Vector3,
  ) {}

  // Call this each physics substep, BEFORE world.step().
  update(dt: number): void {
    if (!this.enabled) return;
    const g = this.globalMultiplier;

    if (TORSO_RIGHTING_ENABLED) {
      this.applyTorsoRighting(g, dt);
    }

    if (GRAPPLE_REACH_IMPULSE_ENABLED && this.grappleAnchor) {
      this.applyGrappleReachImpulse(g);
    }
  }

  // Weak PD pulling the torso toward world-vertical (identity rotation).
  // Same shortest-path quaternion-to-rotvec scheme as the old PD code, but
  // with Kp/Kd an order of magnitude weaker than the prior controller.
  private applyTorsoRighting(g: number, dt: number): void {
    const r = this.torso.rotation();
    this.tmpQuatInv.set(r.x, r.y, r.z, r.w).invert();
    this.tmpQuat.copy(this.identity).multiply(this.tmpQuatInv);

    let x = this.tmpQuat.x, y = this.tmpQuat.y, z = this.tmpQuat.z, w = this.tmpQuat.w;
    if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const s = Math.sqrt(x * x + y * y + z * z);
    let rx = 0, ry = 0, rz = 0;
    if (s > 1e-6) {
      const angle = 2 * Math.atan2(s, w);
      const k = angle / s;
      rx = x * k; ry = y * k; rz = z * k;
    }

    const ang = this.torso.angvel();
    const kp = TORSO_RIGHTING_KP * g;
    const kd = TORSO_RIGHTING_KD * g;
    const tx = (kp * rx - kd * ang.x) * dt;
    const ty = (kp * ry - kd * ang.y) * dt;
    const tz = (kp * rz - kd * ang.z) * dt;
    this.torso.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true);
  }

  // Apply a small impulse to the forearm toward the grapple anchor each
  // substep. Direction = (anchor − shoulderWorld).normalize(); magnitude
  // scales by forearm mass so the felt acceleration is consistent across
  // mass tuning.
  private applyGrappleReachImpulse(g: number): void {
    const anchor = this.grappleAnchor!;
    const torsoTrans = this.torso.translation();
    const torsoRot = this.torso.rotation();

    // shoulderWorld = torso.pos + torsoRot · shoulderLocal
    this.tmpShoulder
      .copy(this.shoulderLocalOffset)
      .applyQuaternion(this.tmpQuat.set(torsoRot.x, torsoRot.y, torsoRot.z, torsoRot.w));
    this.tmpShoulder.x += torsoTrans.x;
    this.tmpShoulder.y += torsoTrans.y;
    this.tmpShoulder.z += torsoTrans.z;

    this.tmpReach.copy(anchor).sub(this.tmpShoulder);
    const lenSq = this.tmpReach.lengthSq();
    if (lenSq < 1e-6) return;
    this.tmpReach.multiplyScalar(1 / Math.sqrt(lenSq));

    const m = this.grappleArm.mass();
    const k = GRAPPLE_REACH_IMPULSE_STRENGTH * g * m;
    this.grappleArm.applyImpulse(
      { x: this.tmpReach.x * k, y: this.tmpReach.y * k, z: this.tmpReach.z * k },
      true,
    );
  }
}
