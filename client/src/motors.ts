import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

// Manual PD-controller motors for the ragdoll. Rapier's spherical joints don't
// expose motor controllers in the JS build (issue dimforge/rapier.js#287), so
// we drive each body toward a target orientation by hand.
//
// Per substep:
//   1. Compute child target = parent.currentWorldRotation × restLocalRotation
//   2. err = target × current⁻¹ → axis-angle (shortest-path)
//   3. τ = Kp · rotvec − Kd · ω
//   4. body.applyTorqueImpulse(τ · dt) — per-step impulse, no persistence
//
// Driving children off the parent's CURRENT rotation (not the torso's) keeps
// serial chains from oscillating; the natural lag becomes Gang-Beasts swing.

export interface ChainNode {
  body: RAPIER.RigidBody;
  parent: RAPIER.RigidBody;
  restLocalRotation: THREE.Quaternion;
  kp: number;
  kd: number;
}

export interface GrappleArmConfig {
  // The grapple arm is a single rigid body (no elbow). PD pulls it to reach
  // toward the anchor while grappling.
  arm: RAPIER.RigidBody;
  // Where the shoulder sits in torso-local space; used to compute the reach
  // direction (anchor − shoulderWorld).
  shoulderLocalOffset: THREE.Vector3;
  kpReach: number;
  kdReach: number;
}

export class RagdollMotors {
  enabled = true;
  globalMultiplier = 1.0;
  // Set by the host each frame: where the grapple is anchored, or null.
  grappleAnchor: THREE.Vector3 | null = null;

  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuat2 = new THREE.Quaternion();
  private readonly tmpQuatInv = new THREE.Quaternion();
  private readonly tmpQuatTarget = new THREE.Quaternion();
  private readonly tmpReachQuat = new THREE.Quaternion();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpX = new THREE.Vector3();
  private readonly tmpY = new THREE.Vector3();
  private readonly tmpZ = new THREE.Vector3();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly identity = new THREE.Quaternion();

  constructor(
    public torso: RAPIER.RigidBody,
    public torsoKp: number,
    public torsoKd: number,
    public chain: ChainNode[],
    public grappleArm: GrappleArmConfig,
  ) {}

  // Call this each physics substep, BEFORE world.step(), with the substep dt.
  update(dt: number): void {
    if (!this.enabled) return;
    const g = this.globalMultiplier;

    // Torso: target = identity (upright in world frame).
    this.applyPd(this.torso, this.identity, this.torsoKp * g, this.torsoKd * g, dt);

    const reachActive = this.grappleAnchor !== null;
    const { arm } = this.grappleArm;

    for (const node of this.chain) {
      if (reachActive && node.body === arm) continue;

      const parentRot = this.readRotation(node.parent, this.tmpQuat);
      this.tmpQuatTarget.copy(parentRot).multiply(node.restLocalRotation);
      this.applyPd(node.body, this.tmpQuatTarget, node.kp * g, node.kd * g, dt);
    }

    if (reachActive) {
      const target = this.buildReachQuat();
      const { kpReach, kdReach } = this.grappleArm;
      this.applyPd(arm, target, kpReach * g, kdReach * g, dt);
    }
  }

  // Build a full-basis target quaternion for the grapple arm. Without an
  // explicit twist reference, setFromUnitVectors gives a noisy shortest-arc
  // rotation that lets the arm spin freely around its length axis.
  private buildReachQuat(): THREE.Quaternion {
    const anchor = this.grappleAnchor!;
    const torsoRot = this.readRotation(this.torso, this.tmpQuat2);
    const torsoTrans = this.torso.translation();

    // Shoulder world position = torso pos + torsoRot · shoulderLocal
    this.tmpVec
      .copy(this.grappleArm.shoulderLocalOffset)
      .applyQuaternion(torsoRot);
    this.tmpVec.x += torsoTrans.x;
    this.tmpVec.y += torsoTrans.y;
    this.tmpVec.z += torsoTrans.z;

    // reachDir = (anchor − shoulder).normalize() — arm's local −Y in world.
    this.tmpVec2.copy(anchor).sub(this.tmpVec).normalize();

    // Arm's local +Y in world = -reachDir.
    this.tmpY.copy(this.tmpVec2).multiplyScalar(-1);

    // Reference X axis: torso's local +X (right) projected perpendicular to Y.
    this.tmpX.set(1, 0, 0).applyQuaternion(torsoRot);
    const dot = this.tmpX.dot(this.tmpY);
    this.tmpX.sub(this.tmpVec.copy(this.tmpY).multiplyScalar(dot));

    // Fallback if torso right is parallel to Y (reaching straight along it).
    if (this.tmpX.lengthSq() < 1e-4) {
      this.tmpX.set(0, 0, 1).applyQuaternion(torsoRot);
      const d2 = this.tmpX.dot(this.tmpY);
      this.tmpX.sub(this.tmpVec.copy(this.tmpY).multiplyScalar(d2));
    }
    this.tmpX.normalize();

    // Z = X × Y for a right-handed basis.
    this.tmpZ.copy(this.tmpX).cross(this.tmpY);

    this.tmpMatrix.makeBasis(this.tmpX, this.tmpY, this.tmpZ);
    this.tmpReachQuat.setFromRotationMatrix(this.tmpMatrix);
    return this.tmpReachQuat;
  }

  private readRotation(body: RAPIER.RigidBody, out: THREE.Quaternion): THREE.Quaternion {
    const r = body.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  private applyPd(
    body: RAPIER.RigidBody,
    targetWorldRot: THREE.Quaternion,
    kp: number,
    kd: number,
    dt: number,
  ): void {
    // err = target × current⁻¹  (rotation that takes current → target)
    const r = body.rotation();
    this.tmpQuatInv.set(r.x, r.y, r.z, r.w).invert();
    this.tmpQuat.copy(targetWorldRot).multiply(this.tmpQuatInv);

    // Shortest-path: negate q if w < 0 so axis-angle is in [0, π].
    let x = this.tmpQuat.x;
    let y = this.tmpQuat.y;
    let z = this.tmpQuat.z;
    let w = this.tmpQuat.w;
    if (w < 0) {
      x = -x;
      y = -y;
      z = -z;
      w = -w;
    }
    const s = Math.sqrt(x * x + y * y + z * z);
    let rx = 0;
    let ry = 0;
    let rz = 0;
    if (s > 1e-6) {
      const angle = 2 * Math.atan2(s, w);
      const k = angle / s;
      rx = x * k;
      ry = y * k;
      rz = z * k;
    }

    const ang = body.angvel();
    let tx = (kp * rx - kd * ang.x) * dt;
    let ty = (kp * ry - kd * ang.y) * dt;
    let tz = (kp * rz - kd * ang.z) * dt;

    // Safety: cap angular-impulse magnitude per substep. If PD tuning ever
    // pushes Δω past stability for one body's smallest moment of inertia,
    // this prevents a numerical explosion from yeeting bodies into the
    // distance via constraint forces.
    const MAX_IMPULSE = 1.5;
    const mag = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (mag > MAX_IMPULSE) {
      const s = MAX_IMPULSE / mag;
      tx *= s;
      ty *= s;
      tz *= s;
    }

    body.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true);
  }
}
