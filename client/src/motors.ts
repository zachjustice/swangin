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

// Cone PD: soft swing-only restoring torque applied when the limb's length
// axis leaves a cone around its rest direction. Inside the cone, the limb
// is fully passive (sack-of-potatoes feel preserved); outside, torque
// ramps with (θ − coneHalfAngle). Twist around the length axis is never
// constrained — only swing.
//
// Optional twist PD: applies a separate restoring torque *along* the
// limb's length axis to keep its local +Z aligned with the parent's
// local +Z (rotated by restLocalRotation). Orthogonal to the cone PD's
// swing torque — the two don't interact. Set kpTwist > 0 to enable.
export interface ConeNode {
  body: RAPIER.RigidBody;
  parent: RAPIER.RigidBody;
  // Limb's rest orientation in parent-local space. The cone is centered on
  // restDir = parent.rotation × restLocalRotation × (0,-1,0).
  restLocalRotation: THREE.Quaternion;
  coneHalfAngle: number;
  kp: number;
  kd: number;
  kpTwist?: number;
  kdTwist?: number;
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
  // Cone PD scratch — separate from the chain pool so the two loops can't
  // stomp on each other's intermediates.
  private readonly tmpRestDir = new THREE.Vector3();
  private readonly tmpCurrDir = new THREE.Vector3();
  private readonly tmpAxis = new THREE.Vector3();
  private readonly tmpConeQuat = new THREE.Quaternion();
  private readonly tmpFallback = new THREE.Vector3();
  private static readonly DOWN_LOCAL = new THREE.Vector3(0, -1, 0);

  constructor(
    public torso: RAPIER.RigidBody,
    public torsoKp: number,
    public torsoKd: number,
    public chain: ChainNode[],
    public cones: ConeNode[],
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

    for (const node of this.cones) {
      if (reachActive && node.body === arm) continue;
      this.applyConePd(node, g, dt);
    }

    for (const node of this.cones) {
      if (reachActive && node.body === arm) continue;
      if (!node.kpTwist || node.kpTwist <= 0) continue;
      this.applyTwistPd(node, g, dt);
    }

    if (reachActive) {
      const target = this.buildReachQuat();
      const { kpReach, kdReach } = this.grappleArm;
      this.applyPd(arm, target, kpReach * g, kdReach * g, dt);
    }
  }

  // Swing-only restoring torque: if the limb's length axis is outside the
  // rest-direction cone, apply torque along (currDir × restDir) — twist
  // around the limb's length axis is left fully free.
  private applyConePd(node: ConeNode, g: number, dt: number): void {
    const parentRot = this.readRotation(node.parent, this.tmpQuat);
    const bodyRot = this.readRotation(node.body, this.tmpConeQuat);

    // restDir = parent.rotation × restLocalRotation × (0,-1,0)
    this.tmpQuat2.copy(parentRot).multiply(node.restLocalRotation);
    this.tmpRestDir.copy(RagdollMotors.DOWN_LOCAL).applyQuaternion(this.tmpQuat2);

    // currDir = body.rotation × (0,-1,0)
    this.tmpCurrDir.copy(RagdollMotors.DOWN_LOCAL).applyQuaternion(bodyRot);

    const cosTheta = Math.max(-1, Math.min(1, this.tmpRestDir.dot(this.tmpCurrDir)));
    const theta = Math.acos(cosTheta);
    if (theta <= node.coneHalfAngle) return;

    // Swing axis: currDir × restDir (perpendicular to both, points the way
    // currDir needs to rotate to reach restDir).
    this.tmpAxis.copy(this.tmpCurrDir).cross(this.tmpRestDir);
    let axisLenSq = this.tmpAxis.lengthSq();
    if (axisLenSq < 1e-6) {
      // θ ≈ π — currDir is antiparallel to restDir, axis is degenerate.
      // Pick any vector perpendicular to currDir (parent's +X projected).
      this.tmpFallback.set(1, 0, 0).applyQuaternion(parentRot);
      const dot = this.tmpFallback.dot(this.tmpCurrDir);
      this.tmpFallback.addScaledVector(this.tmpCurrDir, -dot);
      if (this.tmpFallback.lengthSq() < 1e-6) {
        this.tmpFallback.set(0, 0, 1).applyQuaternion(parentRot);
        const d2 = this.tmpFallback.dot(this.tmpCurrDir);
        this.tmpFallback.addScaledVector(this.tmpCurrDir, -d2);
      }
      this.tmpAxis.copy(this.tmpFallback);
      axisLenSq = this.tmpAxis.lengthSq();
      if (axisLenSq < 1e-6) return;
    }
    this.tmpAxis.multiplyScalar(1 / Math.sqrt(axisLenSq));

    const swingAng = theta - node.coneHalfAngle;
    const ang = node.body.angvel();
    const omegaSwing =
      ang.x * this.tmpAxis.x + ang.y * this.tmpAxis.y + ang.z * this.tmpAxis.z;
    const tauMag = (node.kp * g) * swingAng - (node.kd * g) * omegaSwing;
    const impulse = tauMag * dt;

    node.body.applyTorqueImpulse(
      { x: this.tmpAxis.x * impulse, y: this.tmpAxis.y * impulse, z: this.tmpAxis.z * impulse },
      true,
    );
  }

  // Twist-only restoring torque around the limb's length axis. Uses the
  // body's local +Z as a "facing" reference and pulls it toward the
  // parent's rotated +Z (same restLocalRotation as the cone's rest dir),
  // projected into the plane perpendicular to the limb's length axis.
  // Torque is parallel to lengthAxis, so it never contributes to swing.
  private applyTwistPd(node: ConeNode, g: number, dt: number): void {
    const parentRot = this.readRotation(node.parent, this.tmpQuat);
    const bodyRot = this.readRotation(node.body, this.tmpConeQuat);

    // lengthAxis = body.rotation × (0, -1, 0) — points hip → foot.
    this.tmpCurrDir.copy(RagdollMotors.DOWN_LOCAL).applyQuaternion(bodyRot);

    // bodyFront = body.rotation × (0, 0, 1), projected ⟂ lengthAxis.
    this.tmpVec.set(0, 0, 1).applyQuaternion(bodyRot);
    let dot = this.tmpVec.dot(this.tmpCurrDir);
    this.tmpVec.addScaledVector(this.tmpCurrDir, -dot);
    const bodyFrontLenSq = this.tmpVec.lengthSq();
    if (bodyFrontLenSq < 1e-6) return; // body +Z parallel to length axis — degenerate
    this.tmpVec.multiplyScalar(1 / Math.sqrt(bodyFrontLenSq));

    // targetFront = parent.rotation × restLocalRotation × (0, 0, 1),
    // projected ⟂ lengthAxis. lengthAxis itself comes from the live body
    // pose, NOT the rest pose, so the projection plane is correct even
    // when the leg has swung away from its rest direction.
    this.tmpQuat2.copy(parentRot).multiply(node.restLocalRotation);
    this.tmpVec2.set(0, 0, 1).applyQuaternion(this.tmpQuat2);
    dot = this.tmpVec2.dot(this.tmpCurrDir);
    this.tmpVec2.addScaledVector(this.tmpCurrDir, -dot);
    const targetFrontLenSq = this.tmpVec2.lengthSq();
    if (targetFrontLenSq < 1e-6) return;
    this.tmpVec2.multiplyScalar(1 / Math.sqrt(targetFrontLenSq));

    // Signed twist angle around lengthAxis: atan2(sin, cos) where
    // sin = lengthAxis · (bodyFrontPerp × targetFrontPerp) and
    // cos = bodyFrontPerp · targetFrontPerp.
    this.tmpAxis.copy(this.tmpVec).cross(this.tmpVec2);
    const sinT = this.tmpAxis.dot(this.tmpCurrDir);
    const cosT = this.tmpVec.dot(this.tmpVec2);
    const twistAng = Math.atan2(sinT, cosT);

    const ang = node.body.angvel();
    const omegaTwist =
      ang.x * this.tmpCurrDir.x +
      ang.y * this.tmpCurrDir.y +
      ang.z * this.tmpCurrDir.z;

    const kpT = (node.kpTwist ?? 0) * g;
    const kdT = (node.kdTwist ?? 0) * g;
    const tau = kpT * twistAng - kdT * omegaTwist;
    const impulse = tau * dt;

    node.body.applyTorqueImpulse(
      {
        x: this.tmpCurrDir.x * impulse,
        y: this.tmpCurrDir.y * impulse,
        z: this.tmpCurrDir.z * impulse,
      },
      true,
    );
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
