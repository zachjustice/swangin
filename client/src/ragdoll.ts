import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RagdollMotors, ChainNode, ConeNode } from './motors.ts';
import {
  ARM_HALF_LEN, ARM_SPREAD, LEG_SPREAD,
  HEAD_OFFSET_Y, HEAD_RADIUS, HIP_OFFSET_Y,
  RAGDOLL_GROUPS, PART_MASS,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SHIN_HALF_LEN, TORSO_HALF_HEIGHT, THIGH_HALF_LEN,
  MATERIAL,
  POSE_PART_ORDER, PosePart, PART_SHAPES, HAND_LOCAL_Y,
} from './ragdoll-proportions.ts';
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
      .setLinearDamping(0.05)
      .setAngularDamping(1.0);
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
    world.createCollider(
      colliderDesc
        .setMass(PART_MASS[name])
        .setFriction(0.5)
        .setCollisionGroups(RAGDOLL_GROUPS),
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
    const restRot = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, side * LEG_SPREAD);
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
      { x: 1, y: 0, z: 0 },
      -2.6, 0.05,
      0, 0.5, 0.2,
    );
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
    { body: head.body, parent: torso.body, restLocalRotation: restIdentity, kp: 6, kd: 0.10 },
  ];

  // Cone PD on shoulders + hips: limbs swing freely inside a 90° cone
  // around their rest direction, and get a soft restoring torque only when
  // pushed past it. Keeps arms hanging just outside the torso silhouette
  // instead of straight through it.
  const cones: ConeNode[] = [
    { body: armL.arm.body,   parent: torso.body, restLocalRotation: armL.restRot, coneHalfAngle: Math.PI / 2, kp: 4, kd: 0.3 },
    { body: armR.arm.body,   parent: torso.body, restLocalRotation: armR.restRot, coneHalfAngle: Math.PI / 2, kp: 4, kd: 0.3 },
    { body: legL.thigh.body, parent: torso.body, restLocalRotation: legL.restRot, coneHalfAngle: Math.PI / 2, kp: 4, kd: 0.3 },
    { body: legR.thigh.body, parent: torso.body, restLocalRotation: legR.restRot, coneHalfAngle: Math.PI / 2, kp: 4, kd: 0.3 },
  ];

  const motors = new RagdollMotors(
    torso.body,
    50,
    1.0,
    chain,
    cones,
    {
      arm: armR.arm.body,
      shoulderLocalOffset: new THREE.Vector3(SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
      kpReach: 20,
      kdReach: 0.3,
    },
  );

  console.log(
    `[ragdoll] tuning — cone kp=${cones[0].kp} half=${(cones[0].coneHalfAngle * 180 / Math.PI).toFixed(0)}°, ` +
    `knee motor stiff=0.5 damp=0.2, ` +
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
