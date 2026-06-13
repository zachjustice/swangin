import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RagdollMotors, ChainNode } from './motors.ts';
import {
  FA, HR, NECK_GAP, RAGDOLL_GROUPS, DENSITY,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SN, TH, TT, UA,
  POSE_PART_ORDER, PosePart, PART_SHAPES, HAND_LOCAL_Y,
} from './ragdoll-proportions.ts';
import { buildPartVisual } from './ragdoll-visuals.ts';

// 10-body skeleton joined by spherical joints (C5) + manual PD motors (C8).
// Parts get an InteractionGroups filter so they don't collide with each other.

interface Part {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  initialOffset: THREE.Vector3;
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
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
  const parts: Part[] = [];

  function makePart(name: PosePart, centerWorld: THREE.Vector3): Part {
    const shape = PART_SHAPES[name];
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(centerWorld.x, centerWorld.y, centerWorld.z)
        .setLinearDamping(0.05)
        .setAngularDamping(1.0),
    );
    const colliderDesc = shape.kind === 'capsule'
      ? RAPIER.ColliderDesc.capsule(shape.halfH, shape.r)
      : RAPIER.ColliderDesc.ball(shape.r);
    world.createCollider(
      colliderDesc.setDensity(DENSITY).setCollisionGroups(RAGDOLL_GROUPS),
      body,
    );
    const mesh = buildPartVisual(name, mat);
    scene.add(mesh);
    const part: Part = { body, mesh, initialOffset: centerWorld.clone().sub(spawn) };
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

  const headC = torsoC.clone().add(new THREE.Vector3(0, TH + NECK_GAP + HR, 0));
  const head = makePart('head', headC);

  spherical(torso, head, { x: 0, y: TH, z: 0 }, { x: 0, y: -HR, z: 0 });

  function buildArm(side: -1 | 1, prefix: 'armL' | 'armR'): { upper: Part; forearm: Part } {
    const shoulderW = torsoC.clone().add(
      new THREE.Vector3(side * SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
    );
    const upperC = shoulderW.clone().add(new THREE.Vector3(0, -UA, 0));
    const upper = makePart(`${prefix}_upper` as PosePart, upperC);

    const elbowW = upperC.clone().add(new THREE.Vector3(0, -UA, 0));
    const forearmC = elbowW.clone().add(new THREE.Vector3(0, -FA, 0));
    const forearm = makePart(`${prefix}_forearm` as PosePart, forearmC);

    spherical(
      torso, upper,
      { x: side * SHOULDER_OFFSET_X, y: SHOULDER_OFFSET_Y, z: 0 },
      { x: 0, y: UA, z: 0 },
    );
    spherical(
      upper, forearm,
      { x: 0, y: -UA, z: 0 },
      { x: 0, y: FA, z: 0 },
    );
    return { upper, forearm };
  }

  function buildLeg(side: -1 | 1, prefix: 'legL' | 'legR'): { thigh: Part; shin: Part } {
    const hipW = torsoC.clone().add(new THREE.Vector3(side * HIP_OFFSET_X, -TH, 0));
    const thighC = hipW.clone().add(new THREE.Vector3(0, -TT, 0));
    const thigh = makePart(`${prefix}_thigh` as PosePart, thighC);

    const kneeW = thighC.clone().add(new THREE.Vector3(0, -TT, 0));
    const shinC = kneeW.clone().add(new THREE.Vector3(0, -SN, 0));
    const shin = makePart(`${prefix}_shin` as PosePart, shinC);

    spherical(
      torso, thigh,
      { x: side * HIP_OFFSET_X, y: -TH, z: 0 },
      { x: 0, y: TT, z: 0 },
    );
    spherical(
      thigh, shin,
      { x: 0, y: -TT, z: 0 },
      { x: 0, y: SN, z: 0 },
    );
    return { thigh, shin };
  }

  const armL = buildArm(-1, 'armL');
  const armR = buildArm(1, 'armR');
  const legL = buildLeg(-1, 'legL');
  const legR = buildLeg(1, 'legR');

  // Index map for POSE_PART_ORDER — keep in sync with that array.
  const partsByName: Record<PosePart, Part> = {
    torso: torso,
    head: head,
    armL_upper: armL.upper,
    armL_forearm: armL.forearm,
    armR_upper: armR.upper,
    armR_forearm: armR.forearm,
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
      part.body.setTranslation({ x: newSpawn.x + p.x, y: newSpawn.y + p.y, z: newSpawn.z + p.z }, true);
      part.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      part.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      part.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    sync();
  }

  sync();

  const restIdentity = new THREE.Quaternion();
  const chain: ChainNode[] = [
    { body: head.body,         parent: torso.body,      restLocalRotation: restIdentity, kp: 6, kd: 0.10 },
    { body: armL.upper.body,   parent: torso.body,      restLocalRotation: restIdentity, kp: 5, kd: 0.02 },
    { body: armL.forearm.body, parent: armL.upper.body, restLocalRotation: restIdentity, kp: 3, kd: 0.01 },
    { body: armR.upper.body,   parent: torso.body,      restLocalRotation: restIdentity, kp: 5, kd: 0.02 },
    { body: armR.forearm.body, parent: armR.upper.body, restLocalRotation: restIdentity, kp: 3, kd: 0.01 },
    { body: legL.thigh.body,   parent: torso.body,      restLocalRotation: restIdentity, kp: 5, kd: 0.05 },
    { body: legL.shin.body,    parent: legL.thigh.body, restLocalRotation: restIdentity, kp: 3, kd: 0.02 },
    { body: legR.thigh.body,   parent: torso.body,      restLocalRotation: restIdentity, kp: 5, kd: 0.05 },
    { body: legR.shin.body,    parent: legR.thigh.body, restLocalRotation: restIdentity, kp: 3, kd: 0.02 },
  ];

  const motors = new RagdollMotors(
    torso.body,
    50,
    1.0,
    chain,
    {
      upperArm: armR.upper.body,
      forearm: armR.forearm.body,
      shoulderLocalOffset: new THREE.Vector3(SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, 0),
      kpReach: 20,
      kdReach: 0.3,
    },
  );

  return {
    parts,
    poseBodies,
    torso: torso.body,
    grappleHand: armR.forearm.body,
    handLocalOffset: new THREE.Vector3(0, HAND_LOCAL_Y, 0),
    motors,
    material: mat,
    sync,
    respawn,
  };
}
