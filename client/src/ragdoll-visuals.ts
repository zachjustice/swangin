import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CONFIG, FOOT_LOCAL_Y, FOOT_LOCAL_Z, HEAD_RADIUS, SHIN_RADIUS,
  PART_SHAPES, PartShape, PosePart,
  ARM_UPPER_FRONT_PROFILE, ARM_UPPER_SIDE_PROFILE,
  ARM_LOWER_FRONT_PROFILE, ARM_LOWER_SIDE_PROFILE,
  THIGH_FRONT_PROFILE, THIGH_SIDE_PROFILE,
  SHIN_FRONT_PROFILE,  SHIN_SIDE_PROFILE,
  ARM_UPPER_HALF_LEN, THIGH_HALF_LEN,
  ELBOW_FRONT_RADIUS, ELBOW_SIDE_RADIUS,
  KNEE_FRONT_RADIUS, KNEE_SIDE_RADIUS,
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
  armUpperL:  { front: ARM_UPPER_FRONT_PROFILE, side: ARM_UPPER_SIDE_PROFILE },
  armUpperR:  { front: ARM_UPPER_FRONT_PROFILE, side: ARM_UPPER_SIDE_PROFILE },
  armLowerL:  { front: ARM_LOWER_FRONT_PROFILE, side: ARM_LOWER_SIDE_PROFILE },
  armLowerR:  { front: ARM_LOWER_FRONT_PROFILE, side: ARM_LOWER_SIDE_PROFILE },
  legL_thigh: { front: THIGH_FRONT_PROFILE, side: THIGH_SIDE_PROFILE },
  legR_thigh: { front: THIGH_FRONT_PROFILE, side: THIGH_SIDE_PROFILE },
  legL_shin:  { front: SHIN_FRONT_PROFILE,  side: SHIN_SIDE_PROFILE },
  legR_shin:  { front: SHIN_FRONT_PROFILE,  side: SHIN_SIDE_PROFILE },
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

// Eyes + smile on a head sphere of the given radius. Returns the shared
// black material so callers that track lifetimes (e.g. the prototype rebuild
// path) can dispose it.
//
// The smile is a thin half-torus arc placed on the face. Its z offset has
// to exceed the head's surface depth at the smile's y/x — otherwise the
// thin tube sits entirely inside the opaque head sphere and never renders.
// (The eyes get away with a smaller z because their sphere radius is large
// enough to poke through; the smile tube is too thin for that.)
export function addHeadDecorations(
  parent: THREE.Object3D,
  headRadius: number,
  eyeRRatio: number,
): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: 0x0a0f24 });

  const eyeR = headRadius * eyeRRatio;
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeR, 10, 8), mat);
    eye.position.set(side * headRadius * 0.4, headRadius * 0.18, headRadius * 0.86);
    parent.add(eye);
  }

  const mouthRadius = headRadius * 0.22;
  const mouthTube = headRadius * 0.025;
  // Shallow ⌣ — torus arc swept CCW from +X. Rotating by -π/2 - arc/2
  // around Z lands the arc's midpoint at the bottom (angle -π/2).
  const mouthArc = Math.PI * 0.55;
  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(mouthRadius, mouthTube, 8, 20, mouthArc),
    mat,
  );
  mouth.rotation.z = -Math.PI / 2 - mouthArc / 2;
  mouth.position.set(0, -headRadius * 0.18, headRadius * 0.95);
  parent.add(mouth);

  return mat;
}

// Custom flat-bottom foot — half-ellipsoid with a rounded-rect base. Cross-
// sections at every height are similar rounded rectangles whose dimensions
// scale by cos(θ) as the height rises by h·sin(θ); the dome converges to a
// single apex at the top. Flat sole at y=-h/2, apex at y=+h/2.
//
// Geometry is centered at the origin so it drops into the existing FOOT_LOCAL_Y
// positioning frame.
export function buildFootGeometry(
  w: number, h: number, d: number, r: number,
  cornerSegments = 8, domeSegments = 10,
): THREE.BufferGeometry {
  r = Math.max(0, Math.min(r, Math.min(w, d) / 2 - 1e-4));

  // One ring of perimeter points at height y, with the rounded-rect footprint
  // uniformly scaled by `scale` (= cos θ). Always emits 4·cornerSegments
  // points so vertex counts match across rings; mergeVertices collapses any
  // coincident duplicates at the apex.
  function ring(y: number, scale: number): [number, number, number][] {
    const hw = (w / 2) * scale;
    const hd = (d / 2) * scale;
    const rc = r * scale;
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
  // domeSegments+1 rings, from sole (θ=0, scale=1) to apex (θ=π/2, scale=0).
  // θ-linear sampling auto-bunches near the apex (cosine-spaced in y) where
  // the dome curvature is highest — same trick as the limb caps.
  const rings: [number, number, number][][] = [];
  for (let s = 0; s <= domeSegments; s++) {
    const theta = (Math.PI / 2) * (s / domeSegments);
    rings.push(ring(yBot + h * Math.sin(theta), Math.cos(theta)));
  }

  const N = rings[0].length;
  const positions: number[] = [];
  for (const rg of rings) for (const [x, y, z] of rg) positions.push(x, y, z);
  const bottomCenter = positions.length / 3;
  positions.push(0, yBot, 0);

  const indices: number[] = [];
  // Side bands. Rings walk CCW around +Y from above, so winding (a,c,b)/(b,c,d)
  // gives outward normals — same convention as buildSweepGeometry.
  for (let row = 0; row < rings.length - 1; row++) {
    const b0 = row * N;
    const b1 = (row + 1) * N;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      indices.push(b0 + i, b1 + i, b0 + j);
      indices.push(b0 + j, b1 + i, b1 + j);
    }
  }
  // Bottom cap (fan from bottomCenter). For a −Y outward normal with the
  // perimeter walking CCW from above, the fan goes (center, i, j) — NOT
  // (center, j, i); the inverted winding was why the sole rendered invisible.
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    indices.push(bottomCenter, i, j);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setIndex(indices);
  // Merge the coincident apex duplicates (cornerSegments·4 verts all at the
  // top point) so computeVertexNormals averages a single smooth normal across
  // all dome triangles at the apex.
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

// Ellipsoid parented at the bottom of a segment, sized to the segment's seam
// cross-section. Lives where the spherical joint anchors are, so when the
// child segment bends, the ball fills the gap that would otherwise show as a
// pair of flat exposed disks at the elbow / knee.
function addJointBall(
  parent: THREE.Object3D,
  material: THREE.MeshStandardMaterial,
  segmentHalfH: number,
  frontR: number,
  sideR: number,
) {
  const r = Math.max(frontR, sideR, 1e-4);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), material);
  ball.scale.set(frontR / r, 1, sideR / r);
  ball.position.set(0, -segmentHalfH, 0);
  parent.add(ball);
}

export function buildPartVisual(
  name: PosePart,
  material: THREE.MeshStandardMaterial,
): THREE.Group {
  const group = new THREE.Group();
  group.add(buildPrimitive(PART_SHAPES[name], material, name));
  if (name === 'head') {
    addHeadDecorations(group, HEAD_RADIUS, CONFIG.eyeRRatio);
  } else if (name === 'legL_shin' || name === 'legR_shin') {
    addFoot(group, material);
  } else if (name === 'legL_thigh' || name === 'legR_thigh') {
    addJointBall(group, material, THIGH_HALF_LEN, KNEE_FRONT_RADIUS, KNEE_SIDE_RADIUS);
  } else if (name === 'armUpperL' || name === 'armUpperR') {
    addJointBall(group, material, ARM_UPPER_HALF_LEN, ELBOW_FRONT_RADIUS, ELBOW_SIDE_RADIUS);
  }
  return group;
}
