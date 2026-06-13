import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  AR, FA, HR, LR, NECK_GAP,
  SHOULDER_OFFSET_X, SHOULDER_OFFSET_Y, HIP_OFFSET_X,
  SN, TH, TT, UA,
  POSE_PART_ORDER, PosePart, PART_SHAPES, REMOTE_RAGDOLL_GROUPS,
  HAND_LOCAL_Y, FOOT_LOCAL_Y, FOOT_LOCAL_Z,
} from './ragdoll-proportions.ts';
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
  grappleLine: THREE.Line;
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

  function buildPart(name: PosePart, center: THREE.Vector3, isHead: boolean): RemotePart {
    const shape = PART_SHAPES[name];
    const body = kinematicBody(center);
    if (shape.kind === 'capsule') {
      world.createCollider(
        RAPIER.ColliderDesc.capsule(shape.halfH, shape.r)
          .setCollisionGroups(REMOTE_RAGDOLL_GROUPS),
        body,
      );
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(shape.r, shape.halfH * 2, 6, 12),
        mat,
      );
      scene.add(mesh);
      return { body, mesh };
    } else {
      world.createCollider(
        RAPIER.ColliderDesc.ball(shape.r)
          .setCollisionGroups(REMOTE_RAGDOLL_GROUPS),
        body,
      );
      const group = new THREE.Group();
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(shape.r, 18, 14), mat);
      group.add(sphere);
      if (isHead) {
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0f24 });
        const eyeR = HR * 0.13;
        for (const side of [-1, 1] as const) {
          const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeR, 8, 6), eyeMat);
          eye.position.set(side * HR * 0.4, HR * 0.18, HR * 0.86);
          group.add(eye);
        }
      }
      scene.add(group);
      return { body, mesh: group };
    }
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
    const part = buildPart(name, center, name === 'head');
    partsByName[name] = part;
    parts.push(part);
  }

  // Ornaments parented to forearms / shins so they ride along.
  const handR = new THREE.Mesh(new THREE.SphereGeometry(AR * 1.4, 12, 8), mat);
  handR.position.set(0, HAND_LOCAL_Y, 0);
  partsByName.armR_forearm.mesh.add(handR);
  const handL = new THREE.Mesh(new THREE.SphereGeometry(AR * 1.4, 12, 8), mat);
  handL.position.set(0, HAND_LOCAL_Y, 0);
  partsByName.armL_forearm.mesh.add(handL);
  for (const shinName of ['legL_shin', 'legR_shin'] as const) {
    const foot = new THREE.Mesh(
      new THREE.BoxGeometry(LR * 1.8, LR * 0.7, LR * 2.6),
      mat,
    );
    foot.position.set(0, FOOT_LOCAL_Y, FOOT_LOCAL_Z);
    partsByName[shinName].mesh.add(foot);
  }

  // Grapple line — remote endpoint comes from grap message.
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
  );
  const grappleLine = new THREE.Line(
    lineGeom,
    new THREE.LineBasicMaterial({ color: 0xffe88a }),
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

      const pos = lineGeom.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, tmpHandWorld.x, tmpHandWorld.y, tmpHandWorld.z);
      pos.setXYZ(1, grap[1], grap[2], grap[3]);
      pos.needsUpdate = true;
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
