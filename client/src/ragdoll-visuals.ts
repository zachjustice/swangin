import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Visual helpers shared by the SkinnedMesh factory (ragdoll-skinned-mesh.ts)
// and the standalone tuning prototype. The per-part rigid-mesh path (the old
// `buildPartVisual` / joint-ball / per-primitive flow) has been replaced by
// the single SkinnedMesh factory — only the two primitive builders that ride
// along on the head bone and shin bones live here now.

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
      [hw - rc, hd - rc, 0],              // +X +Z corner
      [-hw + rc, hd - rc, Math.PI / 2],    // -X +Z corner
      [-hw + rc, -hd + rc, Math.PI],        // -X -Z corner
      [hw - rc, -hd + rc, Math.PI * 1.5],  // +X -Z corner
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
