import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RagdollMotors, ChainNode, ConeNode } from './motors.ts';
import {
  ARM_HALF_LEN, ARM_SPREAD,
  HEAD_OFFSET_Y, HEAD_RADIUS, HIP_OFFSET_Y,
  HEAD_TORSO_GROUPS, ARM_GROUPS, THIGH_GROUPS, SHIN_GROUPS, PART_MASS,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SHIN_HALF_LEN, TORSO_HALF_HEIGHT, THIGH_HALF_LEN,
  MATERIAL,
  POSE_PART_ORDER, PosePart, PART_SHAPES, HAND_LOCAL_Y,
} from './ragdoll-proportions.ts';
import {
  ARM_CONE_HALF_ANGLE, ARM_CONE_KD, ARM_CONE_KP,
  ARM_TOP_CLEARANCE,
  HIP_TOP_CLEARANCE,
  BODY_ANGULAR_DAMPING, BODY_LINEAR_DAMPING,
  COLLIDER_FRICTION,
  GRAPPLE_REACH_KD, GRAPPLE_REACH_KP,
  HEAD_PD_KD, HEAD_PD_KP,
  HIP_CONE_HALF_ANGLE, HIP_CONE_KD, HIP_CONE_KP, HIP_REST_SPREAD,
  HIP_TWIST_KD, HIP_TWIST_KP,
  KNEE_LIMIT_MAX, KNEE_LIMIT_MIN,
  KNEE_MOTOR_DAMPING, KNEE_MOTOR_STIFFNESS, KNEE_REST_ANGLE,
  SHIN_ANGULAR_DAMPING,
  THIGH_ANGULAR_DAMPING,
  TORSO_PD_KD, TORSO_PD_KP,
} from './ragdoll-tuning.ts';
import { buildPartVisual } from './ragdoll-visuals.ts';

// 10-body skeleton joined by spherical joints (C5) + manual PD motors (C8).
// Parts get an InteractionGroups filter so they don't collide with each other.

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
    let colliderDesc = shape.kind === 'capsule'
      ? RAPIER.ColliderDesc.capsule(shape.halfH, shape.r)
      : RAPIER.ColliderDesc.ball(shape.r);
    if (name === 'armL' || name === 'armR') {
      // Truncate the top of the arm collider so the shoulder anchor sits
      // clear of the torso surface (see ARM_TOP_CLEARANCE comment).
      const halfH = shape.kind === 'capsule'
        ? shape.halfH - ARM_TOP_CLEARANCE / 2
        : shape.r;
      colliderDesc = RAPIER.ColliderDesc.capsule(halfH, shape.r as number)
        .setTranslation(0, -ARM_TOP_CLEARANCE / 2, 0);
    } else if (name === 'legL_thigh' || name === 'legR_thigh') {
      // Same trick at the hip: trim the thigh collider's top so the
      // spherical hip joint anchor sits clear of the torso surface.
      const halfH = shape.kind === 'capsule'
        ? shape.halfH - HIP_TOP_CLEARANCE / 2
        : shape.r;
      colliderDesc = RAPIER.ColliderDesc.capsule(halfH, shape.r as number)
        .setTranslation(0, -HIP_TOP_CLEARANCE / 2, 0);
    }
    const groups =
      name === 'torso' || name === 'head' ? HEAD_TORSO_GROUPS :
        name === 'armL' || name === 'armR' ? ARM_GROUPS :
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

  function revolute(
    a: Part,
    b: Part,
    anchorA: { x: number; y: number; z: number },
    anchorB: { x: number; y: number; z: number },
    axisLocal: { x: number; y: number; z: number },
    limitMin: number,
    limitMax: number,
    motorTarget: number,
    motorStiffness: number,
    motorDamping: number,
  ) {
    const params = RAPIER.JointData.revolute(anchorA, anchorB, axisLocal);
    const j = world.createImpulseJoint(params, a.body, b.body, true);
    // createImpulseJoint() returns the base ImpulseJoint type; the runtime
    // instance for a revolute joint exposes setLimits / motor configuration.
    const rj = j as unknown as RAPIER.RevoluteImpulseJoint;
    rj.setLimits(limitMin, limitMax);
    rj.configureMotorModel(RAPIER.MotorModel.ForceBased);
    rj.configureMotorPosition(motorTarget, motorStiffness, motorDamping);
  }

  const torsoC = spawn.clone();
  const torso = makePart('torso', torsoC);

  // Head anchors on the torso side at the torso cap (TORSO_HALF_HEIGHT) and on
  // the head side at its bottom (-HEAD_RADIUS). The spawn height uses the
  // explicit HEAD_OFFSET_Y so head/torso sizing can be tuned independently.
  const headC = torsoC.clone().add(new THREE.Vector3(0, HEAD_OFFSET_Y, 0));
  const head = makePart('head', headC);
  spherical(torso, head, { x: 0, y: TORSO_HALF_HEIGHT, z: 0 }, { x: 0, y: -HEAD_RADIUS, z: 0 });

  // Spread the arm/leg outward by `spread` radians around Z. The segment hangs
  // along its body-local −Y, so rotating the body by R(Z, sign·spread) makes
  // its length axis point in the corresponding outward direction.
  const Z_AXIS = new THREE.Vector3(0, 0, 1);

  function buildArm(side: -1 | 1, prefix: 'armL' | 'armR'): { arm: Part; restRot: THREE.Quaternion } {
    const restRot = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, side * ARM_SPREAD);
    const downRot = new THREE.Vector3(0, -1, 0).applyQuaternion(restRot);

    const shoulderW = torsoC.clone().add(
      new THREE.Vector3(side * SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
    );
    const armC = shoulderW.clone().addScaledVector(downRot, ARM_HALF_LEN);
    const arm = makePart(prefix as PosePart, armC, restRot);

    spherical(
      torso, arm,
      { x: side * SHOULDER_OFFSET_X, y: SHOULDER_OFFSET_Y, z: 0 },
      { x: 0, y: ARM_HALF_LEN, z: 0 },
    );
    return { arm, restRot };
  }

  function buildLeg(side: -1 | 1, prefix: 'legL' | 'legR'): { thigh: Part; shin: Part; restRot: THREE.Quaternion } {
    const restRot = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, side * HIP_REST_SPREAD);
    const downRot = new THREE.Vector3(0, -1, 0).applyQuaternion(restRot);

    // Hip anchor uses the explicit HIP_OFFSET_Y so leg-top placement is no
    // longer coupled to torsoHalfHeight.
    const hipW = torsoC.clone().add(new THREE.Vector3(side * HIP_OFFSET_X, HIP_OFFSET_Y, 0));
    const thighC = hipW.clone().addScaledVector(downRot, THIGH_HALF_LEN);
    const thigh = makePart(`${prefix}_thigh` as PosePart, thighC, restRot);

    const kneeW = thighC.clone().addScaledVector(downRot, THIGH_HALF_LEN);
    const shinC = kneeW.clone().addScaledVector(downRot, SHIN_HALF_LEN);
    const shin = makePart(`${prefix}_shin` as PosePart, shinC, restRot);

    spherical(
      torso, thigh,
      { x: side * HIP_OFFSET_X, y: HIP_OFFSET_Y, z: 0 },
      { x: 0, y: THIGH_HALF_LEN, z: 0 },
    );
    thigh.body.setAngularDamping(THIGH_ANGULAR_DAMPING);
    // Knee: revolute hinge with limits + soft motor. Both thigh and shin
    // share restRot, so their local +X axes coincide in world space; the
    // hinge bends in the plane that contains the leg's length axis (i.e.
    // forward/back, like a real knee). Limits: ~[-150°, +3°] — heel toward
    // butt under impact, tiny slack past straight so the constraint isn't
    // constantly active. Soft motor: gentle re-extension.
    revolute(
      thigh, shin,
      { x: 0, y: -THIGH_HALF_LEN, z: 0 },
      { x: 0, y: SHIN_HALF_LEN, z: 0 },
      { x: -1, y: 0, z: 0 },
      KNEE_LIMIT_MIN, KNEE_LIMIT_MAX,
      KNEE_REST_ANGLE, KNEE_MOTOR_STIFFNESS, KNEE_MOTOR_DAMPING,
    );
    shin.body.setAngularDamping(SHIN_ANGULAR_DAMPING);
    return { thigh, shin, restRot };
  }

  const armL = buildArm(-1, 'armL');
  const armR = buildArm(1, 'armR');
  const legL = buildLeg(-1, 'legL');
  const legR = buildLeg(1, 'legR');

  // Index map for POSE_PART_ORDER — keep in sync with that array.
  const partsByName: Record<PosePart, Part> = {
    torso: torso,
    head: head,
    armL: armL.arm,
    armR: armR.arm,
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

  const restIdentity = new THREE.Quaternion();
  // Sack of potatoes: only the torso and head are PD-driven. Arms and legs
  // hang freely from their spherical joints — gravity + angular damping is
  // the entire feel. The grapple-arm PD layered on top still steers the
  // right arm toward an anchor while the player is holding the grapple.
  const chain: ChainNode[] = [
    { body: head.body, parent: torso.body, restLocalRotation: restIdentity, kp: HEAD_PD_KP, kd: HEAD_PD_KD },
  ];

  // Cone PD on shoulders + hips: limbs swing freely inside a cone around
  // their rest direction, and get a soft restoring torque only when
  // pushed past it. Arm cone wide so grappling can reach across the body;
  // hip cone tight + with a twist constraint so feet stay forward.
  // All gains live in ragdoll-tuning.ts.
  const cones: ConeNode[] = [
    { body: armL.arm.body, parent: torso.body, restLocalRotation: armL.restRot, coneHalfAngle: ARM_CONE_HALF_ANGLE, kp: ARM_CONE_KP, kd: ARM_CONE_KD },
    { body: armR.arm.body, parent: torso.body, restLocalRotation: armR.restRot, coneHalfAngle: ARM_CONE_HALF_ANGLE, kp: ARM_CONE_KP, kd: ARM_CONE_KD },
    { body: legL.thigh.body, parent: torso.body, restLocalRotation: legL.restRot, coneHalfAngle: HIP_CONE_HALF_ANGLE, kp: HIP_CONE_KP, kd: HIP_CONE_KD, kpTwist: HIP_TWIST_KP, kdTwist: HIP_TWIST_KD },
    { body: legR.thigh.body, parent: torso.body, restLocalRotation: legR.restRot, coneHalfAngle: HIP_CONE_HALF_ANGLE, kp: HIP_CONE_KP, kd: HIP_CONE_KD, kpTwist: HIP_TWIST_KP, kdTwist: HIP_TWIST_KD },
  ];

  const motors = new RagdollMotors(
    torso.body,
    TORSO_PD_KP,
    TORSO_PD_KD,
    chain,
    cones,
    {
      arm: armR.arm.body,
      shoulderLocalOffset: new THREE.Vector3(SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
      kpReach: GRAPPLE_REACH_KP,
      kdReach: GRAPPLE_REACH_KD,
    },
  );

  console.log(
    `[ragdoll] tuning — arm cone kp=${ARM_CONE_KP} half=${(ARM_CONE_HALF_ANGLE * 180 / Math.PI).toFixed(0)}°, ` +
    `hip cone kp=${HIP_CONE_KP} half=${(HIP_CONE_HALF_ANGLE * 180 / Math.PI).toFixed(0)}° twist kp=${HIP_TWIST_KP}, ` +
    `knee limits [${KNEE_LIMIT_MIN}, ${KNEE_LIMIT_MAX}] motor stiff=${KNEE_MOTOR_STIFFNESS}, ` +
    `clearance arm=${ARM_TOP_CLEARANCE} hip=${HIP_TOP_CLEARANCE} (leg-vs-torso + leg-vs-leg colliders enabled), ` +
    `damping shin=${SHIN_ANGULAR_DAMPING} thigh=${THIGH_ANGULAR_DAMPING} body=${BODY_ANGULAR_DAMPING}, ` +
    `mass torso=${PART_MASS.torso}kg arm=${PART_MASS.armL}kg head=${PART_MASS.head}kg`,
  );

  return {
    parts,
    poseBodies,
    torso: torso.body,
    grappleHand: armR.arm.body,
    handLocalOffset: new THREE.Vector3(0, HAND_LOCAL_Y, 0),
    motors,
    material: mat,
    sync,
    respawn,
  };
}
