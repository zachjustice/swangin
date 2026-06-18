import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RagdollMotors } from './motors.ts';
import {
  ARM_UPPER_HALF_LEN, ARM_LOWER_HALF_LEN,
  HEAD_OFFSET_Y, HEAD_RADIUS, HIP_OFFSET_Y,
  TORSO_GROUPS, ARM_GROUPS, LEG_GROUPS, PART_MASS,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SHIN_HALF_LEN, THIGH_HALF_LEN,
  STIFFNESS_GAP,
  MATERIAL,
  POSE_PART_ORDER, PosePart, PART_SHAPES, HAND_LOCAL_Y,
  BODY_ANGULAR_DAMPING_TORSO, BODY_ANGULAR_DAMPING_LIMB, BODY_LINEAR_DAMPING,
  COLLIDER_FRICTION,
  SHOULDER_KP, SHOULDER_KD,
  ELBOW_KP, ELBOW_KD,
  HIP_KP, HIP_KD,
  KNEE_KP, KNEE_KD,
  NECK_KP, NECK_KD,
} from './ragdoll-proportions.ts';
import { buildRagdollSkinnedMesh } from './ragdoll-skinned-mesh.ts';
import type { Collision } from './collision.ts';
import { SpeedTrail } from './speed-trail.ts';
import { COLLISION_SPEED_EMA_ALPHA, TRAIL_ANCHOR_PARTS } from './constants.ts';

// 10-body humanoid skeleton, joined entirely by spherical impulse joints.
// Cuboid limbs (flat-face contact at each joint brakes long-axis twist) +
// full intra-ragdoll self-collision (the contact pairs ARE the pose-holding
// mechanism, not the spherical joints, which only constrain position). Per-
// joint PD in motors.ts pulls each child body back toward its rest-relative
// orientation against its parent — the "mannequin recovery" return-to-pose
// that makes a swing read as alive instead of as a thrown corpse.
//
// Joint list (9 total):
//   torso ↔ head                        (neck)
//   torso ↔ armUpperL / armUpperR       (shoulders)
//   armUpperL ↔ armLowerL               (elbow L)
//   armUpperR ↔ armLowerR               (elbow R)
//   torso ↔ legL_thigh / legR_thigh     (hips)
//   legL_thigh ↔ legL_shin              (knee L)
//   legR_thigh ↔ legR_shin              (knee R)

interface Part {
  name: PosePart;
  body: RAPIER.RigidBody;
  initialOffset: THREE.Vector3;
  initialRotation: THREE.Quaternion;
  // Pre-step translation/rotation cached each substep so render can lerp
  // between substep boundaries instead of sampling the post-step state raw.
  // See cachePrevForInterp / sync(alpha) below.
  prevT: { x: number; y: number; z: number };
  prevR: { x: number; y: number; z: number; w: number };
}

export interface Ragdoll {
  parts: Part[];
  // Bodies in POSE_PART_ORDER — what main.ts feeds to encodePose().
  poseBodies: RAPIER.RigidBody[];
  torso: RAPIER.RigidBody;
  grappleHand: RAPIER.RigidBody;
  handLocalOffset: THREE.Vector3;
  motors: RagdollMotors;
  material: THREE.MeshStandardMaterial;
  // Single SkinnedMesh covering torso + limb segments; the head sphere and
  // foot meshes are non-skinned children parented to their bones.
  mesh: THREE.SkinnedMesh;
  // EMA-smoothed |torso.linvel()|, updated each physics substep. Drives
  // both the local collision-rule check and the value shipped on the wire
  // for remote-side rule comparison.
  smoothedSpeed: number;
  // Snapshot current body translation/rotation into each part's prev cache.
  // Call once per physics substep, immediately before world.step().
  cachePrevForInterp(): void;
  // Drive bones from a lerp(prev, current, alpha) where alpha is the
  // leftover-accumulator fraction of FIXED_DT. Call once per render frame.
  sync(alpha: number): void;
  // Lerp helper for callers that need the interpolated world position of a
  // single body (e.g. camera target). Writes into `out` and returns it.
  getInterpolatedTranslation(name: PosePart, alpha: number, out: THREE.Vector3): THREE.Vector3;
  respawn(spawn: THREE.Vector3): void;
  updateSpeed(dt: number): void;
  setVisible(v: boolean): void;
  setKillCount(n: number): void;
  linvel(): { x: number; y: number; z: number };
  // Pale-white "air lines" trailing limb extremities above kill speed.
  // Tick from the render loop with seconds-since-last-frame.
  trail: SpeedTrail;
  dispose(): void;
}

export function createRagdoll(
  scene: THREE.Scene,
  world: RAPIER.World,
  spawn: THREE.Vector3,
  collision: Collision,
  color = 0xff7a55,
): Ragdoll {
  const mat = new THREE.MeshStandardMaterial({ color, ...MATERIAL });
  const parts: Part[] = [];
  const colliderHandles: number[] = [];

  function makePart(
    name: PosePart,
    centerWorld: THREE.Vector3,
    initialRotation?: THREE.Quaternion,
  ): Part {
    const shape = PART_SHAPES[name];
    const isTorsoOrHead = name === 'torso' || name === 'head';
    const angularDamping = isTorsoOrHead ? BODY_ANGULAR_DAMPING_TORSO : BODY_ANGULAR_DAMPING_LIMB;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(centerWorld.x, centerWorld.y, centerWorld.z)
      .setLinearDamping(BODY_LINEAR_DAMPING)
      .setAngularDamping(angularDamping);
    if (initialRotation) {
      desc.setRotation({
        x: initialRotation.x, y: initialRotation.y,
        z: initialRotation.z, w: initialRotation.w,
      });
    }
    const body = world.createRigidBody(desc);
    const colliderDesc = shape.kind === 'ball'
      ? RAPIER.ColliderDesc.ball(shape.r)
      : RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz);
    const groups = isTorsoOrHead
      ? TORSO_GROUPS
      : (name === 'armUpperL' || name === 'armUpperR'
          || name === 'armLowerL' || name === 'armLowerR')
        ? ARM_GROUPS
        : LEG_GROUPS;
    const collider = world.createCollider(
      colliderDesc
        .setMass(PART_MASS[name])
        .setFriction(COLLIDER_FRICTION)
        .setCollisionGroups(groups),
      body,
    );
    // Register for cross-player collision lookup. sessionId stays null —
    // null literally means "this is the local player" everywhere downstream,
    // so we don't have to backfill when Colyseus resolves.
    collision.registerCollider(collider.handle, { kind: 'local', sessionId: null, part: name });
    colliderHandles.push(collider.handle);
    const part: Part = {
      name, body,
      initialOffset: centerWorld.clone().sub(spawn),
      initialRotation: (initialRotation ?? new THREE.Quaternion()).clone(),
      prevT: { x: centerWorld.x, y: centerWorld.y, z: centerWorld.z },
      prevR: initialRotation
        ? { x: initialRotation.x, y: initialRotation.y, z: initialRotation.z, w: initialRotation.w }
        : { x: 0, y: 0, z: 0, w: 1 },
    };
    parts.push(part);
    return part;
  }

  function spherical(
    a: Part,
    b: Part,
    anchorA: { x: number; y: number; z: number },
    anchorB: { x: number; y: number; z: number },
  ) {
    const params = RAPIER.JointData.spherical(anchorA, anchorB);
    world.createImpulseJoint(params, a.body, b.body, true);
  }

  const torsoC = spawn.clone();
  const torso = makePart('torso', torsoC);

  // Head: torso-side anchor at the top cap + STIFFNESS_GAP; head-side
  // anchor at its bottom − STIFFNESS_GAP. Spawn the head at HEAD_OFFSET_Y
  // above the torso center (configured to leave a small gap to the cap).
  // Head ball spawns at HEAD_OFFSET_Y above torso center; the joint anchors
  // are derived from that actual spawn geometry rather than from a
  // STIFFNESS_GAP-based formula, so head_anchor_world coincides with
  // torso_anchor_world at t=0 and the solver applies no startup correction.
  // (HEAD_OFFSET_Y in the config was authored independently of STIFFNESS_GAP;
  // matching them with the gap-based offsets would re-introduce the 0.06 m
  // joint violation that throws the chain at spawn.)
  const headC = torsoC.clone().add(new THREE.Vector3(0, HEAD_OFFSET_Y, 0));
  const head = makePart('head', headC);
  spherical(
    torso, head,
    { x: 0, y: HEAD_OFFSET_Y - HEAD_RADIUS, z: 0 },
    { x: 0, y: -HEAD_RADIUS, z: 0 },
  );

  // Arms and legs both hang straight down at rest (body-local −Y). The PD
  // motors added in motors.ts capture parent-relative rotations at construction
  // time, so the spawn pose IS the PD target — anything other than identity
  // here would make PD permanently fight gravity to maintain that offset.

  function buildArm(side: -1 | 1, prefix: 'L' | 'R'): { upper: Part; lower: Part; restRot: THREE.Quaternion } {
    const restRot = new THREE.Quaternion();
    const downRot = new THREE.Vector3(0, -1, 0).applyQuaternion(restRot);

    // Upper arm: hangs from the shoulder + a small stiffness inset so the
    // shoulder-end of the box sits clear of the torso surface.
    const shoulderW = torsoC.clone().add(
      new THREE.Vector3(side * SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
    );
    const upperTop = shoulderW.clone().addScaledVector(downRot, STIFFNESS_GAP);
    const upperC = upperTop.clone().addScaledVector(downRot, ARM_UPPER_HALF_LEN);
    const upperName: PosePart = prefix === 'L' ? 'armUpperL' : 'armUpperR';
    const upper = makePart(upperName, upperC, restRot);

    spherical(
      torso, upper,
      { x: side * SHOULDER_OFFSET_X, y: SHOULDER_OFFSET_Y, z: 0 },
      { x: 0, y: ARM_UPPER_HALF_LEN + STIFFNESS_GAP, z: 0 },
    );

    // Forearm: shares restRot, hangs straight off the elbow.
    const elbowW = upperC.clone().addScaledVector(downRot, ARM_UPPER_HALF_LEN);
    const lowerTop = elbowW.clone().addScaledVector(downRot, STIFFNESS_GAP * 2);
    const lowerC = lowerTop.clone().addScaledVector(downRot, ARM_LOWER_HALF_LEN);
    const lowerName: PosePart = prefix === 'L' ? 'armLowerL' : 'armLowerR';
    const lower = makePart(lowerName, lowerC, restRot);

    spherical(
      upper, lower,
      { x: 0, y: -ARM_UPPER_HALF_LEN - STIFFNESS_GAP, z: 0 },
      { x: 0, y:  ARM_LOWER_HALF_LEN + STIFFNESS_GAP, z: 0 },
    );

    return { upper, lower, restRot };
  }

  function buildLeg(side: -1 | 1, prefix: 'legL' | 'legR'): { thigh: Part; shin: Part; restRot: THREE.Quaternion } {
    const restRot = new THREE.Quaternion();  // legs hang straight down at rest
    const downRot = new THREE.Vector3(0, -1, 0).applyQuaternion(restRot);

    const hipW = torsoC.clone().add(new THREE.Vector3(side * HIP_OFFSET_X, HIP_OFFSET_Y, 0));
    const thighTop = hipW.clone().addScaledVector(downRot, STIFFNESS_GAP);
    const thighC = thighTop.clone().addScaledVector(downRot, THIGH_HALF_LEN);
    const thigh = makePart(`${prefix}_thigh` as PosePart, thighC, restRot);

    const kneeW = thighC.clone().addScaledVector(downRot, THIGH_HALF_LEN);
    const shinTop = kneeW.clone().addScaledVector(downRot, STIFFNESS_GAP * 2);
    const shinC = shinTop.clone().addScaledVector(downRot, SHIN_HALF_LEN);
    const shin = makePart(`${prefix}_shin` as PosePart, shinC, restRot);

    spherical(
      torso, thigh,
      { x: side * HIP_OFFSET_X, y: HIP_OFFSET_Y, z: 0 },
      { x: 0, y: THIGH_HALF_LEN + STIFFNESS_GAP, z: 0 },
    );
    // Knee: now spherical (was a revolute hinge with a motor). Free
    // articulation in every direction — matches mattvb91's setup.
    spherical(
      thigh, shin,
      { x: 0, y: -THIGH_HALF_LEN - STIFFNESS_GAP, z: 0 },
      { x: 0, y:  SHIN_HALF_LEN  + STIFFNESS_GAP, z: 0 },
    );
    return { thigh, shin, restRot };
  }

  const armL = buildArm(-1, 'L');
  const armR = buildArm(1, 'R');
  const legL = buildLeg(-1, 'legL');
  const legR = buildLeg(1, 'legR');

  // Index map for POSE_PART_ORDER — keep in sync with that array.
  const partsByName: Record<PosePart, Part> = {
    torso: torso,
    head: head,
    armUpperL: armL.upper,
    armLowerL: armL.lower,
    armUpperR: armR.upper,
    armLowerR: armR.lower,
    legL_thigh: legL.thigh,
    legL_shin: legL.shin,
    legR_thigh: legR.thigh,
    legR_shin: legR.shin,
  };
  const poseBodies = POSE_PART_ORDER.map((n) => partsByName[n].body);

  // Build the single SkinnedMesh that covers all 10 bones. The bones'
  // rest-world transforms are derived from `spawn` and match the bodies'
  // spawn-time positions; sync() then drives bone transforms from the
  // bodies each frame.
  const skinned = buildRagdollSkinnedMesh(mat, spawn);
  scene.add(skinned.mesh);

  // EMA-smoothed |torso linvel|. Updated each physics substep. Used for the
  // collision threshold check and broadcast on the wire.
  const speedState = { value: 0 };

  // Speed-trail visual — pale "air lines" from extremities when moving fast.
  const trailBodies = TRAIL_ANCHOR_PARTS.map((n) => {
    const part = parts.find((p) => p.name === n);
    if (!part) throw new Error(`[ragdoll] missing trail anchor part: ${n}`);
    return part.body;
  });
  const trail = new SpeedTrail(scene, trailBodies, () => speedState.value);

  // Scratch quaternions reused across sync() calls to avoid per-frame allocation.
  const scratchPrevQ = new THREE.Quaternion();
  const scratchCurrQ = new THREE.Quaternion();

  function cachePrevForInterp() {
    for (const part of parts) {
      const t = part.body.translation();
      const r = part.body.rotation();
      part.prevT.x = t.x; part.prevT.y = t.y; part.prevT.z = t.z;
      part.prevR.x = r.x; part.prevR.y = r.y; part.prevR.z = r.z; part.prevR.w = r.w;
    }
  }

  function sync(alpha: number) {
    for (const part of parts) {
      const t = part.body.translation();
      const r = part.body.rotation();
      const bone = skinned.bones[part.name];
      bone.position.set(
        part.prevT.x + (t.x - part.prevT.x) * alpha,
        part.prevT.y + (t.y - part.prevT.y) * alpha,
        part.prevT.z + (t.z - part.prevT.z) * alpha,
      );
      scratchPrevQ.set(part.prevR.x, part.prevR.y, part.prevR.z, part.prevR.w);
      scratchCurrQ.set(r.x, r.y, r.z, r.w);
      scratchPrevQ.slerp(scratchCurrQ, alpha);
      bone.quaternion.copy(scratchPrevQ);
      bone.updateMatrixWorld(true);
    }
  }

  function getInterpolatedTranslation(name: PosePart, alpha: number, out: THREE.Vector3): THREE.Vector3 {
    const part = partsByName[name];
    const t = part.body.translation();
    out.set(
      part.prevT.x + (t.x - part.prevT.x) * alpha,
      part.prevT.y + (t.y - part.prevT.y) * alpha,
      part.prevT.z + (t.z - part.prevT.z) * alpha,
    );
    return out;
  }

  function respawn(newSpawn: THREE.Vector3) {
    for (const part of parts) {
      const p = part.initialOffset;
      const q = part.initialRotation;
      part.body.setTranslation({ x: newSpawn.x + p.x, y: newSpawn.y + p.y, z: newSpawn.z + p.z }, true);
      part.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      part.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      part.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    speedState.value = 0;
    trail.clearAll();
    // After respawn, prev would still be the pre-respawn pose — lerping from
    // there would slide the body across the world. Re-cache so prev = current,
    // then sync at any alpha (0 and 1 are identical when prev == current).
    cachePrevForInterp();
    sync(0);
  }

  function updateSpeed(_dt: number) {
    // α is per-substep (60 Hz). _dt is informational — keeping the param
    // makes the call site read consistently with motor.update(dt) etc.
    const v = torso.body.linvel();
    const raw = Math.hypot(v.x, v.y, v.z);
    speedState.value += COLLISION_SPEED_EMA_ALPHA * (raw - speedState.value);
  }

  function setVisible(v: boolean) {
    skinned.mesh.visible = v;
    trail.setVisible(v);
  }

  function setKillCount(_n: number) {}

  function linvel() {
    return torso.body.linvel();
  }

  cachePrevForInterp();
  sync(0);

  // Active control:
  //   - Grapple reach impulse on the right forearm toward the anchor.
  //   - Per-joint PD (shoulders / elbows / hips / knees / neck) pulling each
  //     child body back toward its rest-relative orientation against its
  //     parent. PD captures the rest pose at registration time, so the spawn
  //     pose IS the recovery target (legs hanging, arms at sides).
  const motors = new RagdollMotors(
    torso.body,
    armR.lower.body,
    new THREE.Vector3(SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
  );

  motors.addJointPD(torso.body,      head.body,       NECK_KP,     NECK_KD);
  motors.addJointPD(torso.body,      armL.upper.body, SHOULDER_KP, SHOULDER_KD);
  motors.addJointPD(torso.body,      armR.upper.body, SHOULDER_KP, SHOULDER_KD);
  motors.addJointPD(armL.upper.body, armL.lower.body, ELBOW_KP,    ELBOW_KD);
  motors.addJointPD(armR.upper.body, armR.lower.body, ELBOW_KP,    ELBOW_KD);
  motors.addJointPD(torso.body,      legL.thigh.body, HIP_KP,      HIP_KD);
  motors.addJointPD(torso.body,      legR.thigh.body, HIP_KP,      HIP_KD);
  motors.addJointPD(legL.thigh.body, legL.shin.body,  KNEE_KP,     KNEE_KD);
  motors.addJointPD(legR.thigh.body, legR.shin.body,  KNEE_KP,     KNEE_KD);

  console.log(
    `[ragdoll] 10 bodies, 9 spherical joints, cuboid limbs, full self-collision. ` +
    `mass torso=${PART_MASS.torso}kg head=${PART_MASS.head}kg ` +
    `armUpper=${PART_MASS.armUpperL}kg armLower=${PART_MASS.armLowerL}kg ` +
    `thigh=${PART_MASS.legL_thigh}kg shin=${PART_MASS.legL_shin}kg, ` +
    `damping linear=${BODY_LINEAR_DAMPING} angular(torso/head)=${BODY_ANGULAR_DAMPING_TORSO} angular(limb)=${BODY_ANGULAR_DAMPING_LIMB}, ` +
    `stiffness gap=${STIFFNESS_GAP}m`,
  );

  function dispose() {
    for (const h of colliderHandles) collision.unregisterCollider(h);
    trail.dispose();
    scene.remove(skinned.mesh);
    skinned.dispose();
    mat.dispose();
  }

  return {
    parts,
    poseBodies,
    torso: torso.body,
    grappleHand: armR.lower.body,
    handLocalOffset: new THREE.Vector3(0, HAND_LOCAL_Y, 0),
    motors,
    material: mat,
    mesh: skinned.mesh,
    get smoothedSpeed() { return speedState.value; },
    cachePrevForInterp,
    sync,
    getInterpolatedTranslation,
    respawn,
    updateSpeed,
    setVisible,
    setKillCount,
    linvel,
    trail,
    dispose,
  };
}
