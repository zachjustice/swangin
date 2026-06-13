import * as THREE from 'three';
import {
  AR, FOOT_LOCAL_Y, FOOT_LOCAL_Z, HAND_LOCAL_Y, HR, LR,
  PART_SHAPES, PartShape, PosePart,
} from './ragdoll-proportions.ts';

// Shared visual builder for ragdoll body parts. Both the local (dynamic) and
// the remote (kinematic-position) ragdolls call buildPartVisual() per pose
// body, so they always look identical. The visuals are pure cosmetics — they
// do not affect physics; the physics collider still comes from PART_SHAPES.

function buildPrimitive(
  shape: PartShape,
  material: THREE.MeshStandardMaterial,
): THREE.Mesh {
  if (shape.kind === 'ball') {
    return new THREE.Mesh(new THREE.SphereGeometry(shape.r, 18, 14), material);
  }
  return new THREE.Mesh(
    new THREE.CapsuleGeometry(shape.r, shape.halfH * 2, 6, 12),
    material,
  );
}

function addEyes(parent: THREE.Object3D) {
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0f24 });
  const eyeR = HR * 0.13;
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeR, 8, 6), eyeMat);
    eye.position.set(side * HR * 0.4, HR * 0.18, HR * 0.86);
    parent.add(eye);
  }
}

function addHand(parent: THREE.Object3D, material: THREE.MeshStandardMaterial) {
  const hand = new THREE.Mesh(
    new THREE.SphereGeometry(AR * 1.4, 12, 8),
    material,
  );
  hand.position.set(0, HAND_LOCAL_Y, 0);
  parent.add(hand);
}

function addFoot(parent: THREE.Object3D, material: THREE.MeshStandardMaterial) {
  const foot = new THREE.Mesh(
    new THREE.BoxGeometry(LR * 1.8, LR * 0.7, LR * 2.6),
    material,
  );
  foot.position.set(0, FOOT_LOCAL_Y, FOOT_LOCAL_Z);
  parent.add(foot);
}

export function buildPartVisual(
  name: PosePart,
  material: THREE.MeshStandardMaterial,
): THREE.Group {
  const group = new THREE.Group();
  group.add(buildPrimitive(PART_SHAPES[name], material));
  if (name === 'head') {
    addEyes(group);
  } else if (name === 'armL_forearm' || name === 'armR_forearm') {
    addHand(group, material);
  } else if (name === 'legL_shin' || name === 'legR_shin') {
    addFoot(group, material);
  }
  return group;
}
