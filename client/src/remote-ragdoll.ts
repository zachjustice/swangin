import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { GRAPPLE_COLOR, GRAPPLE_LINE_WIDTH } from './constants.ts';
import {
  ARM_UPPER_HALF_LEN, ARM_LOWER_HALF_LEN,
  HEAD_OFFSET_Y, HEAD_RADIUS, HIP_OFFSET_Y,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SHIN_HALF_LEN, THIGH_HALF_LEN, MATERIAL,
  POSE_PART_ORDER, PosePart, PART_SHAPES, REMOTE_RAGDOLL_GROUPS,
  HAND_LOCAL_Y,
} from './ragdoll-proportions.ts';
import { buildRagdollSkinnedMesh } from './ragdoll-skinned-mesh.ts';
import { POSE_FLOATS } from './pose-codec.ts';
import type { Collision } from './collision.ts';
import { createKillCounter, type KillCounter } from './kill-counter.ts';
import { SpeedTrail } from './speed-trail.ts';
import { TRAIL_ANCHOR_PARTS } from './constants.ts';

// Remote ragdoll: 10 kinematic-position bodies (no joints, no motors). Pose is
// dictated by interpolated network samples each frame. Kinematic so C11 can
// collide the local ragdoll against remotes "for free".

// Offset of the armLowerR translation/rotation block inside a pose payload.
// Precomputed so applyPose's grapple-anchor branch doesn't do an indexOf scan
// of POSE_PART_ORDER on every network frame.
const ARM_LOWER_R_POSE_OFFSET = POSE_PART_ORDER.indexOf('armLowerR') * 7;

interface RemotePart {
  name: PosePart;
  body: RAPIER.RigidBody;
}

export interface RemoteRagdoll {
  parts: RemotePart[];
  // Bodies in POSE_PART_ORDER — what applyPose() expects.
  poseBodies: RAPIER.RigidBody[];
  torso: RAPIER.RigidBody;
  grappleLine: Line2;
  label: CSS2DObject;
  mesh: THREE.SkinnedMesh;
  // Most-recent speed + vel from the pose stream. Null until first envelope
  // arrives; collision.drain skips the death check until both are populated.
  lastSpeed: number | null;
  lastVel: { x: number; y: number; z: number } | null;
  // pose: 70 floats. speed: scalar. vel: 3 floats. grap: [active, ax, ay, az].
  applyPose(
    pose: number[] | Float32Array,
    speed: number,
    vel: number[] | Float32Array,
    grap: number[] | Float32Array,
  ): void;
  setVisible(v: boolean): void;
  setKillCount(n: number): void;
  // Speed-trail visual driven by `lastSpeed`. Tick from the render loop.
  trail: SpeedTrail;
  dispose(): void;
}

export function createRemoteRagdoll(
  scene: THREE.Scene,
  world: RAPIER.World,
  sessionId: string,
  color: number,
  name: string,
  spawnHint: THREE.Vector3,
  collision: Collision,
): RemoteRagdoll {
  const mat = new THREE.MeshStandardMaterial({ color, ...MATERIAL });
  const parts: RemotePart[] = [];
  const colliderHandles: number[] = [];

  function kinematicBody(at: THREE.Vector3): RAPIER.RigidBody {
    return world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(at.x, at.y, at.z),
    );
  }

  function buildPart(name: PosePart, center: THREE.Vector3): RemotePart {
    const shape = PART_SHAPES[name];
    const body = kinematicBody(center);
    const colliderDesc = shape.kind === 'ball'
      ? RAPIER.ColliderDesc.ball(shape.r)
      : RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz);
    // Active events on the REMOTE side only — the cross-player pair lights
    // up the event queue as long as at least one collider in the pair has
    // them on. Remote set is smaller and never self-collides, so this is
    // cheaper than blanketing the dynamic local ragdoll.
    colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = world.createCollider(
      colliderDesc.setCollisionGroups(REMOTE_RAGDOLL_GROUPS),
      body,
    );
    collision.registerCollider(collider.handle, { kind: 'remote', sessionId, part: name });
    colliderHandles.push(collider.handle);
    return { name, body };
  }

  // Approximate per-part offsets from the torso center for the initial layout
  // (pose snaps to real values on the first applyPose). Just so kinematic
  // bodies don't all start at the origin.
  const armUpperY = SHOULDER_OFFSET_Y - ARM_UPPER_HALF_LEN;
  const armLowerY = SHOULDER_OFFSET_Y - 2 * ARM_UPPER_HALF_LEN - ARM_LOWER_HALF_LEN;
  const offsets: Record<PosePart, THREE.Vector3> = {
    torso: new THREE.Vector3(0, 0, 0),
    head: new THREE.Vector3(0, HEAD_OFFSET_Y, 0),
    armUpperL: new THREE.Vector3(-SHOULDER_OFFSET_X, armUpperY, 0),
    armLowerL: new THREE.Vector3(-SHOULDER_OFFSET_X, armLowerY, 0),
    armUpperR: new THREE.Vector3(SHOULDER_OFFSET_X, armUpperY, 0),
    armLowerR: new THREE.Vector3(SHOULDER_OFFSET_X, armLowerY, 0),
    legL_thigh: new THREE.Vector3(-HIP_OFFSET_X, HIP_OFFSET_Y - THIGH_HALF_LEN, 0),
    legL_shin: new THREE.Vector3(-HIP_OFFSET_X, HIP_OFFSET_Y - 2 * THIGH_HALF_LEN - SHIN_HALF_LEN, 0),
    legR_thigh: new THREE.Vector3(HIP_OFFSET_X, HIP_OFFSET_Y - THIGH_HALF_LEN, 0),
    legR_shin: new THREE.Vector3(HIP_OFFSET_X, HIP_OFFSET_Y - 2 * THIGH_HALF_LEN - SHIN_HALF_LEN, 0),
  };

  const partsByName = {} as Record<PosePart, RemotePart>;
  for (const name of POSE_PART_ORDER) {
    const center = spawnHint.clone().add(offsets[name]);
    const part = buildPart(name, center);
    partsByName[name] = part;
    parts.push(part);
  }

  // Single SkinnedMesh covering the whole ragdoll. Bones start at the
  // spawnHint-derived rest positions; applyPose() rewrites them to whatever
  // the wire pose says each frame.
  const skinned = buildRagdollSkinnedMesh(mat, spawnHint);
  scene.add(skinned.mesh);

  const killCounter: KillCounter = createKillCounter();
  skinned.bones.torso.add(killCounter.sprite);

  // Speed-trail driven by the most-recent broadcast speed (already EMA
  // smoothed on the sender). lastSpeed is null until the first pose arrives —
  // SpeedTrail treats that as 0, which keeps the line group hidden.
  const trailBodies = TRAIL_ANCHOR_PARTS.map((n) => {
    const part = partsByName[n];
    if (!part) throw new Error(`[remote-ragdoll] missing trail anchor part: ${n}`);
    return part.body;
  });
  const trail = new SpeedTrail(scene, trailBodies, () => state.lastSpeed ?? 0);

  // Grapple line — remote endpoint comes from grap message. Matches local
  // player's grapple rendering: world-unit thickness for perspective taper,
  // HDR-boosted color so the existing bloom pass produces a slight glow.
  const lineGeom = new LineGeometry();
  lineGeom.setPositions([0, 0, 0, 0, 0, 0]);
  const grappleLine = new Line2(
    lineGeom,
    new LineMaterial({
      color: GRAPPLE_COLOR,
      linewidth: GRAPPLE_LINE_WIDTH,
      worldUnits: true,
      transparent: true,
    }),
  );
  grappleLine.visible = false;
  grappleLine.frustumCulled = false;
  scene.add(grappleLine);

  // CSS2D name label parented to the head group so it floats with the head.
  const labelDiv = document.createElement('div');
  labelDiv.className = 'name-label';
  labelDiv.textContent = name;
  labelDiv.style.cssText = [
    'padding: 2px 6px',
    'font-size: 11px',
    'font-family: ui-sans-serif, system-ui, sans-serif',
    'color: #e6ecff',
    'background: rgba(10, 20, 56, 0.55)',
    'border: 1px solid rgba(180, 200, 255, 0.25)',
    'border-radius: 4px',
    'white-space: nowrap',
    'pointer-events: none',
  ].join(';');
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, HEAD_RADIUS + 0.25, 0);
  skinned.bones.head.add(label);

  const tmpHandWorld = new THREE.Vector3();
  const tmpHandQuat = new THREE.Quaternion();
  // Held across applyPose() calls so collision.drain (which runs on the
  // local physics substep) can read the most-recent broadcast values.
  const state: { lastSpeed: number | null; lastVel: { x: number; y: number; z: number } | null } = {
    lastSpeed: null,
    lastVel: null,
  };

  function applyPose(
    pose: number[] | Float32Array,
    speed: number,
    vel: number[] | Float32Array,
    grap: number[] | Float32Array,
  ): void {
    if (pose.length < POSE_FLOATS) return;
    state.lastSpeed = speed;
    if (vel.length >= 3) {
      state.lastVel = { x: vel[0], y: vel[1], z: vel[2] };
    }
    for (let i = 0; i < POSE_PART_ORDER.length; i++) {
      const o = i * 7;
      const part = parts[i];
      const body = part.body;
      body.setNextKinematicTranslation({ x: pose[o + 0], y: pose[o + 1], z: pose[o + 2] });
      body.setNextKinematicRotation({ x: pose[o + 3], y: pose[o + 4], z: pose[o + 5], w: pose[o + 6] });
      // Drive the bone directly so the SkinnedMesh updates this frame instead
      // of waiting a physics step for the kinematic body to settle.
      const bone = skinned.bones[part.name];
      bone.position.set(pose[o + 0], pose[o + 1], pose[o + 2]);
      bone.quaternion.set(pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]);
      bone.updateMatrixWorld(true);
    }

    const active = grap[0] > 0.5;
    if (active) {
      // Hand world position from right forearm transform + HAND_LOCAL_Y offset
      // (HAND_LOCAL_Y is the wrist, i.e. the bottom of the forearm box).
      const ro = ARM_LOWER_R_POSE_OFFSET;
      tmpHandQuat.set(pose[ro + 3], pose[ro + 4], pose[ro + 5], pose[ro + 6]);
      tmpHandWorld.set(0, HAND_LOCAL_Y, 0).applyQuaternion(tmpHandQuat);
      tmpHandWorld.x += pose[ro + 0];
      tmpHandWorld.y += pose[ro + 1];
      tmpHandWorld.z += pose[ro + 2];

      lineGeom.setPositions([
        tmpHandWorld.x, tmpHandWorld.y, tmpHandWorld.z,
        grap[1], grap[2], grap[3],
      ]);
      grappleLine.visible = true;
    } else {
      grappleLine.visible = false;
    }
  }

  function setVisible(v: boolean): void {
    skinned.mesh.visible = v;
    trail.setVisible(v);
  }

  function setKillCount(n: number): void {
    killCounter.setCount(n);
  }

  function dispose(): void {
    for (const h of colliderHandles) collision.unregisterCollider(h);
    for (const p of parts) world.removeRigidBody(p.body);
    killCounter.dispose();
    trail.dispose();
    scene.remove(skinned.mesh);
    skinned.dispose();
    scene.remove(grappleLine);
    lineGeom.dispose();
    (grappleLine.material as THREE.Material).dispose();
    // CSS2DObject removes its DOM node when its parent is removed from the scene.
    labelDiv.remove();
    mat.dispose();
  }

  return {
    parts,
    poseBodies: parts.map((p) => p.body),
    torso: parts[0].body,
    grappleLine,
    label,
    mesh: skinned.mesh,
    get lastSpeed() { return state.lastSpeed; },
    get lastVel() { return state.lastVel; },
    applyPose,
    setVisible,
    setKillCount,
    trail,
    dispose,
  };
}
