import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  TORSO_RIGHTING_ENABLED, TORSO_RIGHTING_KP, TORSO_RIGHTING_KD,
  GRAPPLE_REACH_IMPULSE_ENABLED, GRAPPLE_REACH_IMPULSE_STRENGTH,
} from './ragdoll-tuning.ts';

// Mannequin-recovery PD: each registered joint pulls a child body toward
// a rest-relative orientation against its parent (captured at construction
// time, so respawn lands at zero error). Weak enough that gravity wins on
// swings; strong enough to drift limbs back to a hanging pose between hits.
// Plus the legacy bits:
//   - optional torso uprightness assist (flag in ragdoll-tuning).
//   - per-substep impulse on the grapple-side forearm toward the anchor.

interface JointPD {
  parent: RAPIER.RigidBody;
  child: RAPIER.RigidBody;
  // Child's orientation expressed in the parent's frame at construction.
  // PD target each substep is `parent.rot · restRelRot`.
  restRelRot: THREE.Quaternion;
  kp: number;
  kd: number;
}

export class RagdollMotors {
  // Toggleable from main.ts (M key) for A/B comparison. When false, all
  // assists are skipped — pure passive ragdoll. Default off so the
  // character lands in a stable passive state on first load; toggle on
  // once you've verified the geometry/joints aren't fighting.
  enabled = false;
  // Scales the torso righting torque, the grapple reach impulse, and every
  // per-joint PD.
  globalMultiplier = 1.0;
  // Set by the host each substep: where the grapple is anchored, or null.
  grappleAnchor: THREE.Vector3 | null = null;

  private readonly joints: JointPD[] = [];

  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuatInv = new THREE.Quaternion();
  private readonly tmpReach = new THREE.Vector3();
  private readonly tmpShoulder = new THREE.Vector3();
  private readonly identity = new THREE.Quaternion();
  private readonly tmpParentRot = new THREE.Quaternion();
  private readonly tmpChildRot = new THREE.Quaternion();
  private readonly tmpTargetWorld = new THREE.Quaternion();
  private readonly tmpErr = new THREE.Quaternion();

  constructor(
    public torso: RAPIER.RigidBody,
    public grappleArm: RAPIER.RigidBody,
    // Shoulder offset in torso-local space — used to compute the reach
    // direction (anchor − shoulderWorld).
    public shoulderLocalOffset: THREE.Vector3,
  ) {}

  // Register a parent→child PD. Capture the rest-relative rotation NOW
  // (call after the skeleton is constructed at its spawn pose) — that
  // becomes the PD target. respawn() restores both bodies to their spawn
  // rotations, so post-respawn PD error is zero.
  addJointPD(
    parent: RAPIER.RigidBody,
    child: RAPIER.RigidBody,
    kp: number,
    kd: number,
  ): void {
    const pr = parent.rotation();
    const cr = child.rotation();
    this.tmpParentRot.set(pr.x, pr.y, pr.z, pr.w);
    this.tmpChildRot.set(cr.x, cr.y, cr.z, cr.w);
    const restRel = this.tmpParentRot.clone().invert().multiply(this.tmpChildRot);
    this.joints.push({ parent, child, restRelRot: restRel, kp, kd });
  }

  // Call this each physics substep, BEFORE world.step().
  update(dt: number): void {
    if (!this.enabled) return;
    const g = this.globalMultiplier;

    if (TORSO_RIGHTING_ENABLED) {
      this.applyTorsoRighting(g, dt);
    }

    if (this.joints.length) {
      this.applyJointPDs(g, dt);
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

  // Per-joint PD. Same shortest-path quaternion-to-rotvec math as
  // applyTorsoRighting, but the target is parent-relative (so child
  // tracks parent's rotation with a fixed rest-rel offset, instead of
  // tracking world-vertical). Reaction torque on the parent conserves
  // angular momentum — a trailing limb tugs the body, which is what
  // makes the swing read as weighted instead of decorated.
  private applyJointPDs(g: number, dt: number): void {
    for (const j of this.joints) {
      const pr = j.parent.rotation();
      const cr = j.child.rotation();
      this.tmpParentRot.set(pr.x, pr.y, pr.z, pr.w);
      this.tmpChildRot.set(cr.x, cr.y, cr.z, cr.w);

      // targetWorld = parentRot · restRelRot
      this.tmpTargetWorld.copy(this.tmpParentRot).multiply(j.restRelRot);

      // err = targetWorld · childRot.invert()
      this.tmpQuatInv.copy(this.tmpChildRot).invert();
      this.tmpErr.copy(this.tmpTargetWorld).multiply(this.tmpQuatInv);

      let x = this.tmpErr.x, y = this.tmpErr.y, z = this.tmpErr.z, w = this.tmpErr.w;
      if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
      const s = Math.sqrt(x * x + y * y + z * z);
      let rx = 0, ry = 0, rz = 0;
      if (s > 1e-6) {
        const angle = 2 * Math.atan2(s, w);
        const k = angle / s;
        rx = x * k; ry = y * k; rz = z * k;
      }

      const ca = j.child.angvel();
      const pa = j.parent.angvel();
      const dax = ca.x - pa.x;
      const day = ca.y - pa.y;
      const daz = ca.z - pa.z;

      const kp = j.kp * g;
      const kd = j.kd * g;
      const tx = (kp * rx - kd * dax) * dt;
      const ty = (kp * ry - kd * day) * dt;
      const tz = (kp * rz - kd * daz) * dt;

      j.child.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true);
      j.parent.applyTorqueImpulse({ x: -tx, y: -ty, z: -tz }, true);
    }
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
