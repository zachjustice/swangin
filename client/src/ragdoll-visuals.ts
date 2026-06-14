import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CONFIG, FOOT_LOCAL_Y, FOOT_LOCAL_Z, HEAD_RADIUS, SHIN_RADIUS,
  PART_SHAPES, PartShape, PosePart,
  UPPER_ARM_FRONT_PROFILE, UPPER_ARM_SIDE_PROFILE,
  FOREARM_FRONT_PROFILE,   FOREARM_SIDE_PROFILE,
  THIGH_FRONT_PROFILE,     THIGH_SIDE_PROFILE,
  SHIN_FRONT_PROFILE,      SHIN_SIDE_PROFILE,
} from './ragdoll-proportions.ts';
import { buildSweepGeometry, type Profile } from './ragdoll-spline-sampling.ts';

// Shared visual builder for ragdoll body parts. Both the local (dynamic) and
// the remote (kinematic-position) ragdolls call buildPartVisual() per pose
// body, so they always look identical. The visuals are pure cosmetics — they
// do not affect physics; the physics collider still comes from PART_SHAPES.
//
// All tunable numbers (silhouette splines, segments, eye/foot ratios) live
// in ragdoll-config.json and reach us via CONFIG / the derived profile
// constants in ragdoll-proportions.

// Torso silhouette — uses the explicit torso profiles stored in JSON.
function buildTorsoGeometry(): THREE.BufferGeometry {
  return buildSweepGeometry(
    CONFIG.torsoFrontProfile,
    CONFIG.torsoSideProfile,
    CONFIG.torsoRadialSegs,
  );
}

// Per-limb-segment elliptical sweep profiles. The matching constants on the
// proportions module are pre-resolved (either pulled from JSON or derived
// from the splines on the fly), so this is a pure lookup.
const LIMB_PROFILES: Partial<Record<PosePart, { front: Profile; side: Profile }>> = {
  armL_upper:   { front: UPPER_ARM_FRONT_PROFILE, side: UPPER_ARM_SIDE_PROFILE },
  armR_upper:   { front: UPPER_ARM_FRONT_PROFILE, side: UPPER_ARM_SIDE_PROFILE },
  armL_forearm: { front: FOREARM_FRONT_PROFILE,   side: FOREARM_SIDE_PROFILE },
  armR_forearm: { front: FOREARM_FRONT_PROFILE,   side: FOREARM_SIDE_PROFILE },
  legL_thigh:   { front: THIGH_FRONT_PROFILE,     side: THIGH_SIDE_PROFILE },
  legR_thigh:   { front: THIGH_FRONT_PROFILE,     side: THIGH_SIDE_PROFILE },
  legL_shin:    { front: SHIN_FRONT_PROFILE,      side: SHIN_SIDE_PROFILE },
  legR_shin:    { front: SHIN_FRONT_PROFILE,      side: SHIN_SIDE_PROFILE },
};

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
  const p = LIMB_PROFILES[name];
  if (!p) throw new Error(`buildPartVisual: no profile entry for ${name}`);
  return new THREE.Mesh(buildSweepGeometry(p.front, p.side, CONFIG.radialSegs), material);
}

function addEyes(parent: THREE.Object3D) {
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0f24 });
  const eyeR = HEAD_RADIUS * CONFIG.eyeRRatio;
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeR, 10, 8), eyeMat);
    eye.position.set(side * HEAD_RADIUS * 0.4, HEAD_RADIUS * 0.18, HEAD_RADIUS * 0.86);
    parent.add(eye);
  }
}

// Custom flat-bottom foot — like a simple shoe last. The bottom face is a
// solid rounded rectangle sitting flat on the ground plane (no curve). The
// vertical sides have rounded corners around the footprint perimeter. The
// top edges roll inward over a quarter-circle of radius r to a flat top
// ridge — gives the dome-on-a-sole silhouette of a shoe.
//
// Geometry is centered at the origin: bottom face at y=-h/2, top at y=+h/2.
// Drop-in for the old RoundedBoxGeometry call site (same center frame).
export function buildFootGeometry(
  w: number, h: number, d: number, r: number,
  cornerSegments = 6, domeSegments = 4,
): THREE.BufferGeometry {
  // Clamp so the geometry stays sane while the user drags sliders.
  r = Math.max(0, Math.min(r, Math.min(w, d) / 2 - 1e-4, h - 1e-4));

  // One ring of perimeter points at height y, optionally inset toward the
  // central axis (the dome top is the same perimeter inset by r·(1−cos φ)).
  // Vertices ordered CCW around +Y for consistent outward normals.
  //
  // ALWAYS emits `4 × cornerSegments` perimeter points, even when the corner
  // radius collapses to zero — that keeps the vertex count constant across
  // every ring so the side-band quad loop can index uniformly. Coincident
  // verts are removed by the final mergeVertices() pass.
  function ring(y: number, inset: number): [number, number, number][] {
    const hw = w / 2 - inset;
    const hd = d / 2 - inset;
    const rc = Math.max(0, r - inset);
    const corners: Array<[number, number, number]> = [
      [ hw - rc,  hd - rc, 0],              // +X +Z corner
      [-hw + rc,  hd - rc, Math.PI / 2],    // -X +Z corner
      [-hw + rc, -hd + rc, Math.PI],        // -X -Z corner
      [ hw - rc, -hd + rc, Math.PI * 1.5],  // +X -Z corner
    ];
    const out: [number, number, number][] = [];
    for (const [cx, cz, a0] of corners) {
      for (let s = 0; s < cornerSegments; s++) {
        const a = a0 + (Math.PI / 2) * (s / cornerSegments);
        out.push([cx + rc * Math.cos(a), y, cz + rc * Math.sin(a)]);
      }
    }
    return out;
  }

  const yBot = -h / 2;
  const yTop = h / 2;
  const yWallTop = yTop - r;

  // Ring stack: bottom (y=yBot), top-of-wall (y=yWallTop), then `domeSegments`
  // rings curling inward+up to the top ridge at y=yTop.
  const rings: [number, number, number][][] = [];
  rings.push(ring(yBot, 0));
  rings.push(ring(yWallTop, 0));
  for (let s = 1; s <= domeSegments; s++) {
    const phi = (Math.PI / 2) * (s / domeSegments);
    rings.push(ring(yWallTop + r * Math.sin(phi), r * (1 - Math.cos(phi))));
  }

  const N = rings[0].length;
  const positions: number[] = [];
  for (const rg of rings) for (const [x, y, z] of rg) positions.push(x, y, z);
  const bottomCenter = positions.length / 3;
  positions.push(0, yBot, 0);
  const topCenter = positions.length / 3;
  positions.push(0, yTop, 0);

  const indices: number[] = [];
  // Side bands. Rings are CCW around +Y, so outward face uses winding
  // (a, c, b) / (b, c, d) — same convention as buildSweepGeometry.
  for (let row = 0; row < rings.length - 1; row++) {
    const b0 = row * N;
    const b1 = (row + 1) * N;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      indices.push(b0 + i, b1 + i, b0 + j);
      indices.push(b0 + j, b1 + i, b1 + j);
    }
  }
  // Bottom cap (fan from bottomCenter). Bottom-facing normal needs CW
  // perimeter order when viewed from below.
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    indices.push(bottomCenter, j, i);
  }
  // Top cap (fan from topCenter). Top-facing normal CCW when viewed from above.
  const topBase = (rings.length - 1) * N;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    indices.push(topCenter, topBase + i, topBase + j);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setIndex(indices);
  // Merge coincident verts at the top ridge if domeSegments collapsed inset
  // past the side-corner radius — keeps the top shading smooth.
  const merged = mergeVertices(geom, 1e-6);
  merged.computeVertexNormals();
  return merged;
}

function addFoot(parent: THREE.Object3D, material: THREE.MeshStandardMaterial) {
  const w = SHIN_RADIUS * CONFIG.footW;
  const h = SHIN_RADIUS * CONFIG.footH;
  const d = SHIN_RADIUS * CONFIG.footD;
  // footCornerRadius controls both the vertical edge rounding AND the top
  // dome rolloff radius — one knob for now; expose separately if needed.
  const r = SHIN_RADIUS * CONFIG.footCornerRadius;
  const foot = new THREE.Mesh(buildFootGeometry(w, h, d, r), material);
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
  } else if (name === 'legL_shin' || name === 'legR_shin') {
    addFoot(group, material);
  }
  return group;
}
