import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RagdollMotors } from './motors.ts';
import {
  ARM_UPPER_HALF_LEN, ARM_LOWER_HALF_LEN, ARM_SPREAD,
  HEAD_OFFSET_Y, HEAD_RADIUS, HIP_OFFSET_Y,
  HEAD_TORSO_GROUPS, ARM_GROUPS, THIGH_GROUPS, SHIN_GROUPS, PART_MASS,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SHIN_HALF_LEN, TORSO_HALF_HEIGHT, THIGH_HALF_LEN,
  STIFFNESS_GAP,
  MATERIAL,
  POSE_PART_ORDER, PosePart, PART_SHAPES, HAND_LOCAL_Y,
} from './ragdoll-proportions.ts';
import {
  BODY_ANGULAR_DAMPING, BODY_LINEAR_DAMPING,
  COLLIDER_FRICTION,
} from './ragdoll-tuning.ts';
import { buildPartVisual } from './ragdoll-visuals.ts';

// 10-body humanoid skeleton, joined entirely by spherical impulse joints
// (mirror of mattvb91/rapierjs-ragdoll). No motors, no joint limits, no PD.
// The "good feel" comes from gravity + selected mass ratios + STIFFNESS_GAP
// at every joint anchor so parented colliders don't fight the contact solver
// at rest.
//
// Joint list (9 total):
//   torso ↔ head                        (neck)
//   torso ↔ armUpperL / armUpperR       (shoulders)
//   armUpperL ↔ armLowerL               (elbow L)
//   armUpperR ↔ armLowerR               (elbow R)
//   torso ↔ legL_thigh / legR_thigh     (hips)
//   legL_thigh ↔ legL_shin              (knee L, now spherical not hinge)
//   legR_thigh ↔ legR_shin              (knee R, now spherical not hinge)

interface Part {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  initialOffset: THREE.Vector3;
  initialRotation: THREE.Quaternion;
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
  sync(): void;
  respawn(spawn: THREE.Vector3): void;
}

export function createRagdoll(
  scene: THREE.Scene,
  world: RAPIER.World,
  spawn: THREE.Vector3,
  color = 0xff7a55,
): Ragdoll {
  const mat = new THREE.MeshStandardMaterial({ color, ...MATERIAL });
  const parts: Part[] = [];

  function makePart(
    name: PosePart,
    centerWorld: THREE.Vector3,
    initialRotation?: THREE.Quaternion,
  ): Part {
    const shape = PART_SHAPES[name];
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(centerWorld.x, centerWorld.y, centerWorld.z)
      .setLinearDamping(BODY_LINEAR_DAMPING)
      .setAngularDamping(BODY_ANGULAR_DAMPING);
    if (initialRotation) {
      desc.setRotation({
        x: initialRotation.x, y: initialRotation.y,
        z: initialRotation.z, w: initialRotation.w,
      });
    }
    const body = world.createRigidBody(desc);
    const colliderDesc = shape.kind === 'capsule'
      ? RAPIER.ColliderDesc.capsule(shape.halfH, shape.r)
      : RAPIER.ColliderDesc.ball(shape.r);
    const groups =
      name === 'torso' || name === 'head' ? HEAD_TORSO_GROUPS :
        name === 'armUpperL' || name === 'armUpperR' ||
          name === 'armLowerL' || name === 'armLowerR' ? ARM_GROUPS :
          name === 'legL_thigh' || name === 'legR_thigh' ? THIGH_GROUPS :
            SHIN_GROUPS;
    world.createCollider(
      colliderDesc
        .setMass(PART_MASS[name])
        .setFriction(COLLIDER_FRICTION)
        .setCollisionGroups(groups),
      body,
    );
    const mesh = buildPartVisual(name, mat);
    scene.add(mesh);
    const part: Part = {
      body, mesh,
      initialOffset: centerWorld.clone().sub(spawn),
      initialRotation: (initialRotation ?? new THREE.Quaternion()).clone(),
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
  const headC = torsoC.clone().add(new THREE.Vector3(0, HEAD_OFFSET_Y, 0));
  const head = makePart('head', headC);
  spherical(
    torso, head,
    { x: 0, y: TORSO_HALF_HEIGHT + STIFFNESS_GAP, z: 0 },
    { x: 0, y: -HEAD_RADIUS - STIFFNESS_GAP, z: 0 },
  );

  // Spread the arm/leg outward by `spread` radians around Z. The segment hangs
  // along its body-local −Y, so rotating the body by R(Z, sign·spread) makes
  // its length axis point in the corresponding outward direction.
  const Z_AXIS = new THREE.Vector3(0, 0, 1);

  function buildArm(side: -1 | 1, prefix: 'L' | 'R'): { upper: Part; lower: Part; restRot: THREE.Quaternion } {
    const restRot = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, side * ARM_SPREAD);
    const downRot = new THREE.Vector3(0, -1, 0).applyQuaternion(restRot);

    // Upper arm: hangs from the shoulder + a small stiffness inset so the
    // shoulder-end of the capsule sits clear of the torso surface.
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

  function sync() {
    for (const { body, mesh } of parts) {
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
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
    sync();
  }

  sync();

  // Grapple reach impulse is the only "active" control now: it nudges the
  // right forearm toward the anchor while a grapple is active.
  const motors = new RagdollMotors(
    torso.body,
    armR.lower.body,
    new THREE.Vector3(SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
  );

  console.log(
    `[ragdoll] passive skeleton — 10 bodies, 9 spherical joints, no motors. ` +
    `mass torso=${PART_MASS.torso}kg head=${PART_MASS.head}kg ` +
    `armUpper=${PART_MASS.armUpperL}kg armLower=${PART_MASS.armLowerL}kg ` +
    `thigh=${PART_MASS.legL_thigh}kg shin=${PART_MASS.legL_shin}kg, ` +
    `damping linear=${BODY_LINEAR_DAMPING} angular=${BODY_ANGULAR_DAMPING}, ` +
    `stiffness gap=${STIFFNESS_GAP}m`,
  );

  return {
    parts,
    poseBodies,
    torso: torso.body,
    grappleHand: armR.lower.body,
    handLocalOffset: new THREE.Vector3(0, HAND_LOCAL_Y, 0),
    motors,
    material: mat,
    sync,
    respawn,
  };
}
