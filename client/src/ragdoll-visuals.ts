import * as THREE from 'three';
import {
  CONFIG, FOOT_LOCAL_Y, FOOT_LOCAL_Z, HR, LR,
  PART_SHAPES, PartShape, PosePart,
} from './ragdoll-proportions.ts';

// Shared visual builder for ragdoll body parts. Both the local (dynamic) and
// the remote (kinematic-position) ragdolls call buildPartVisual() per pose
// body, so they always look identical. The visuals are pure cosmetics — they
// do not affect physics; the physics collider still comes from PART_SHAPES.
//
// All tunable numbers (profile points, tapers, bumps, segments, eye/foot
// ratios) live in ragdoll-config.json and reach us via CONFIG.

// Smooth barrel torso via LatheGeometry. Profile points are absolute (top →
// bottom). LatheGeometry winds faces so that profile points going bottom→top
// on +X produce outward-facing normals, so we reverse() before constructing.
function buildTorsoGeometry(): THREE.LatheGeometry {
  const pts = CONFIG.torsoProfile
    .map(([x, y]) => new THREE.Vector2(x, y))
    .reverse();
  return new THREE.LatheGeometry(pts, CONFIG.torsoRadialSegs);
}

// Tapered capsule: hemispherical caps of different radii at each end with a
// smoothly interpolated cylindrical wall between them. Used for limbs.
function buildTaperedCapsule(
  rTop: number,
  rBot: number,
  halfH: number,
): THREE.LatheGeometry {
  const arcSteps = CONFIG.arcSteps;
  const wallSteps = CONFIG.wallSteps;
  const pts: THREE.Vector2[] = [];

  for (let i = 0; i <= arcSteps; i++) {
    const a = (i / arcSteps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(rTop * Math.sin(a), halfH + rTop * Math.cos(a)));
  }
  for (let i = 1; i <= wallSteps; i++) {
    const t = i / (wallSteps + 1);
    const r = rTop + (rBot - rTop) * t;
    const y = halfH - 2 * halfH * t;
    pts.push(new THREE.Vector2(r, y));
  }
  for (let i = 0; i <= arcSteps; i++) {
    const a = (i / arcSteps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(rBot * Math.cos(a), -halfH - rBot * Math.sin(a)));
  }
  // Reverse to bottom→top so LatheGeometry produces outward-facing normals.
  pts.reverse();
  return new THREE.LatheGeometry(pts, CONFIG.radialSegs);
}

function buildPrimitive(
  shape: PartShape,
  material: THREE.MeshStandardMaterial,
  name: PosePart,
): THREE.Mesh {
  if (name === 'torso') {
    return new THREE.Mesh(buildTorsoGeometry(), material);
  }
  if (shape.kind === 'ball') {
    return new THREE.Mesh(new THREE.SphereGeometry(shape.r, 20, 16), material);
  }
  // Per-part limb taper: thicker at the body-side end, narrower at the
  // hand/foot-side end. Pulled from CONFIG so a JSON edit retunes the limbs.
  const tapers: Partial<Record<PosePart, [number, number]>> = {
    armL_upper:   [CONFIG.upperArmTaperTop, CONFIG.upperArmTaperBot],
    armR_upper:   [CONFIG.upperArmTaperTop, CONFIG.upperArmTaperBot],
    armL_forearm: [CONFIG.forearmTaperTop,  CONFIG.forearmTaperBot],
    armR_forearm: [CONFIG.forearmTaperTop,  CONFIG.forearmTaperBot],
    legL_thigh:   [CONFIG.thighTaperTop,    CONFIG.thighTaperBot],
    legR_thigh:   [CONFIG.thighTaperTop,    CONFIG.thighTaperBot],
    legL_shin:    [CONFIG.shinTaperTop,     CONFIG.shinTaperBot],
    legR_shin:    [CONFIG.shinTaperTop,     CONFIG.shinTaperBot],
  };
  const [rT, rB] = tapers[name] ?? [1.0, 1.0];
  return new THREE.Mesh(
    buildTaperedCapsule(shape.r * rT, shape.r * rB, shape.halfH),
    material,
  );
}

function addEyes(parent: THREE.Object3D) {
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0f24 });
  const eyeR = HR * CONFIG.eyeRRatio;
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeR, 10, 8), eyeMat);
    eye.position.set(side * HR * 0.4, HR * 0.18, HR * 0.86);
    parent.add(eye);
  }
}

// Shoulder/hip bumps parented to the torso. They sit on the torso silhouette
// (NOT at the limb joint anchors), so they read as body shape and don't follow
// limb rotation.
function addJointBalls(parent: THREE.Object3D, material: THREE.MeshStandardMaterial) {
  for (const side of [-1, 1] as const) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.shoulderBumpR, 16, 12), material);
    s.position.set(side * CONFIG.shoulderBumpX, CONFIG.shoulderBumpY, 0);
    parent.add(s);
  }
  for (const side of [-1, 1] as const) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.hipBumpR, 16, 12), material);
    s.position.set(side * CONFIG.hipBumpX, CONFIG.hipBumpY, 0);
    parent.add(s);
  }
}

function addFoot(parent: THREE.Object3D, material: THREE.MeshStandardMaterial) {
  const foot = new THREE.Mesh(
    new THREE.BoxGeometry(LR * CONFIG.footW, LR * CONFIG.footH, LR * CONFIG.footD),
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
  group.add(buildPrimitive(PART_SHAPES[name], material, name));
  if (name === 'head') {
    addEyes(group);
  } else if (name === 'torso') {
    addJointBalls(group, material);
  } else if (name === 'legL_shin' || name === 'legR_shin') {
    addFoot(group, material);
  }
  return group;
}
