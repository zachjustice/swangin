import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { GRAPPLE_COLOR, GRAPPLE_LINE_WIDTH } from './constants.ts';
import {
  FA, HR, NECK_GAP,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SN, TH, TT, UA,
  POSE_PART_ORDER, PosePart, PART_SHAPES, REMOTE_RAGDOLL_GROUPS,
  HAND_LOCAL_Y,
} from './ragdoll-proportions.ts';
import { buildPartVisual } from './ragdoll-visuals.ts';
import { POSE_FLOATS } from './pose-codec.ts';

// Remote ragdoll: 10 kinematic-position bodies (no joints, no motors). Pose is
// dictated by interpolated network samples each frame. Kinematic so C11 can
// collide the local ragdoll against remotes "for free".

interface RemotePart {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
}

export interface RemoteRagdoll {
  parts: RemotePart[];
  // Bodies in POSE_PART_ORDER — what applyPose() expects.
  poseBodies: RAPIER.RigidBody[];
  headMesh: THREE.Object3D;
  grappleLine: Line2;
  label: CSS2DObject;
  // pose: 70 floats. grap: [active, ax, ay, az].
  applyPose(pose: number[] | Float32Array, grap: number[] | Float32Array): void;
  dispose(): void;
}

export function createRemoteRagdoll(
  scene: THREE.Scene,
  world: RAPIER.World,
  color: number,
  name: string,
  spawnHint: THREE.Vector3,
): RemoteRagdoll {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
  const parts: RemotePart[] = [];

  function kinematicBody(at: THREE.Vector3): RAPIER.RigidBody {
    return world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(at.x, at.y, at.z),
    );
  }

  function buildPart(name: PosePart, center: THREE.Vector3): RemotePart {
    const shape = PART_SHAPES[name];
    const body = kinematicBody(center);
    const colliderDesc = shape.kind === 'capsule'
      ? RAPIER.ColliderDesc.capsule(shape.halfH, shape.r)
      : RAPIER.ColliderDesc.ball(shape.r);
    world.createCollider(
      colliderDesc.setCollisionGroups(REMOTE_RAGDOLL_GROUPS),
      body,
    );
    const mesh = buildPartVisual(name, mat);
    scene.add(mesh);
    return { body, mesh };
  }

  // Approximate per-part offsets from the torso center for the initial layout
  // (pose snaps to real values on the first applyPose). Just so kinematic
  // bodies don't all start at the origin.
  const offsets: Record<PosePart, THREE.Vector3> = {
    torso: new THREE.Vector3(0, 0, 0),
    head: new THREE.Vector3(0, TH + NECK_GAP + HR, 0),
    armL_upper: new THREE.Vector3(-SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y - UA, 0),
    armL_forearm: new THREE.Vector3(-SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y - 2 * UA - FA, 0),
    armR_upper: new THREE.Vector3(SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y - UA, 0),
    armR_forearm: new THREE.Vector3(SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y - 2 * UA - FA, 0),
    legL_thigh: new THREE.Vector3(-HIP_OFFSET_X, -TH - TT, 0),
    legL_shin: new THREE.Vector3(-HIP_OFFSET_X, -TH - 2 * TT - SN, 0),
    legR_thigh: new THREE.Vector3(HIP_OFFSET_X, -TH - TT, 0),
    legR_shin: new THREE.Vector3(HIP_OFFSET_X, -TH - 2 * TT - SN, 0),
  };

  const partsByName = {} as Record<PosePart, RemotePart>;
  for (const name of POSE_PART_ORDER) {
    const center = spawnHint.clone().add(offsets[name]);
    const part = buildPart(name, center);
    partsByName[name] = part;
    parts.push(part);
  }

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
  label.position.set(0, HR + 0.25, 0);
  partsByName.head.mesh.add(label);

  const tmpHandWorld = new THREE.Vector3();
  const tmpHandQuat = new THREE.Quaternion();

  function applyPose(pose: number[] | Float32Array, grap: number[] | Float32Array): void {
    if (pose.length < POSE_FLOATS) return;
    for (let i = 0; i < POSE_PART_ORDER.length; i++) {
      const o = i * 7;
      const body = parts[i].body;
      body.setNextKinematicTranslation({ x: pose[o + 0], y: pose[o + 1], z: pose[o + 2] });
      body.setNextKinematicRotation({ x: pose[o + 3], y: pose[o + 4], z: pose[o + 5], w: pose[o + 6] });
      // Sync the visual mesh immediately so we don't wait a physics step.
      parts[i].mesh.position.set(pose[o + 0], pose[o + 1], pose[o + 2]);
      parts[i].mesh.quaternion.set(pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]);
    }

    const active = grap[0] > 0.5;
    if (active) {
      // Hand world position from right forearm transform + HAND_LOCAL_Y offset.
      const ro = POSE_PART_ORDER.indexOf('armR_forearm') * 7;
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

  function dispose(): void {
    for (const p of parts) {
      scene.remove(p.mesh);
      world.removeRigidBody(p.body);
    }
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
    headMesh: partsByName.head.mesh,
    grappleLine,
    label,
    applyPose,
    dispose,
  };
}
