import * as THREE from 'three';

// Shared helpers for the body-part silhouettes (torso + 4 limb segments). Each
// part is an elliptical sweep along Y with semi-axes (xR, zR) sourced from two
// Catmull-Rom splines: a Front spline (xR — silhouette seen from the front)
// and a Side spline (zR — silhouette seen from the side). Both splines have
// their top and bottom points pinned to x=0 and share the same Y at those
// endpoints, so the sweep closes cleanly.

export type Profile = Array<[number, number]>;
export type Spline = Array<[number, number]>;

export const SPLINE_SAMPLE_COUNT = 48;

// Build a SplineCurve with phantom control points reflected across the Y axis
// at each end. Uniform Catmull-Rom's tangent at an interior point P_i is
// (P_{i+1} - P_{i-1}) / 2; with the phantom = mirror(P_1) before P_0, the Y
// components cancel at P_0 and the tangent there is purely horizontal —
// exactly what a rounded apex needs. Same trick at the other end.
//
// The visible parameter range (the portion that represents the silhouette
// between the user's first and last handles) is [tStart, tEnd]. Sampling
// anywhere in that range gives a point on the silhouette; sampling at t<tStart
// or t>tEnd dips into the phantom region and is meaningless.
export function buildRoundedSplineCurve(
  visible: Spline,
): { curve: THREE.SplineCurve; tStart: number; tEnd: number } {
  const pts = visible.map(([x, y]) => new THREE.Vector2(x, y));
  const before = new THREE.Vector2(-pts[1].x, pts[1].y);
  const after  = new THREE.Vector2(-pts[pts.length - 2].x, pts[pts.length - 2].y);
  const curve = new THREE.SplineCurve([before, ...pts, after]);
  const segments = pts.length + 1;
  return { curve, tStart: 1 / segments, tEnd: (segments - 1) / segments };
}

// Get N points along the *visible* portion of the spline (skipping the phantom
// caps at each end). Drop-in replacement for SplineCurve.getPoints when you
// want only the silhouette samples.
export function roundedSplinePoints(visible: Spline, n: number): THREE.Vector2[] {
  const { curve, tStart, tEnd } = buildRoundedSplineCurve(visible);
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const t = tStart + (tEnd - tStart) * (i / (n - 1));
    out.push(curve.getPoint(t));
  }
  return out;
}

// Resample a front/side spline pair into matched-Y profile arrays at
// SPLINE_SAMPLE_COUNT uniform heights between the shared top and bottom.
// The mesh builder needs both arrays the same length with identical Y per
// index, which is exactly what this guarantees.
export function resampleSplinesPair(
  side: Spline,
  front: Spline,
): { side: Profile; front: Profile } {
  const yTop = side[0][1];
  const yBot = side[side.length - 1][1];
  const sideDense  = roundedSplinePoints(side, 128);
  const frontDense = roundedSplinePoints(front, 128);
  const outSide:  Profile = [];
  const outFront: Profile = [];
  for (let i = 0; i < SPLINE_SAMPLE_COUNT; i++) {
    const u = i / (SPLINE_SAMPLE_COUNT - 1);
    // Cosine-spaced Y: rings bunch near the apexes where the silhouette
    // curvature is concentrated, so the rounded cap actually reads as round.
    // Uniform-Y spacing puts only ~4 rings in a typical limb cap — too sparse
    // for the apex normals to fair smoothly.
    const t = 0.5 * (1 - Math.cos(Math.PI * u));
    const y = yTop * (1 - t) + yBot * t;
    outSide.push([sampleSplineAtY(sideDense, y), y]);
    outFront.push([sampleSplineAtY(frontDense, y), y]);
  }
  return { side: outSide, front: outFront };
}

// Linear interp of a dense spline-sample list at a target Y. Assumes Y is
// (mostly) monotonic across samples — true for the silhouettes the user can
// actually shape with the editor's pinned-endpoint handles.
export function sampleSplineAtY(samples: THREE.Vector2[], y: number): number {
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if ((a.y - y) * (b.y - y) <= 0) {
      const dy = b.y - a.y;
      if (Math.abs(dy) < 1e-9) return a.x;
      const t = (y - a.y) / dy;
      return a.x + (b.x - a.x) * t;
    }
  }
  return y > samples[0].y ? samples[0].x : samples[samples.length - 1].x;
}

// Half-length of a sweep part = (yTop - yBot) / 2 of its profile. The physics
// capsule's halfH for that part uses this directly so length is a pure
// consequence of where the user dragged the endpoint handles.
export function profileHalfHeight(p: Profile): number {
  return (p[0][1] - p[p.length - 1][1]) / 2;
}

// Capsule radius for the physics body = max sampled radius across either
// profile. Conservative (capsule may be slightly fatter than the visual at
// narrow regions) but never thinner, which is what we want for collision.
export function profileMaxRadius(front: Profile, side: Profile): number {
  let m = 0;
  for (const [x] of front) if (x > m) m = x;
  for (const [x] of side)  if (x > m) m = x;
  return m;
}

// Resolve a profile from the JSON: prefer a stored sampled array if present,
// otherwise derive from the spline pair on the fly. Lets the live game work
// with a JSON that has only splines authored.
export function profileFromConfig(
  storedSide:  Profile | undefined,
  storedFront: Profile | undefined,
  sideSpline:  Spline,
  frontSpline: Spline,
): { side: Profile; front: Profile } {
  const haveSide  = storedSide  && storedSide.length  >= 2;
  const haveFront = storedFront && storedFront.length >= 2;
  if (haveSide && haveFront) {
    return { side: storedSide!, front: storedFront! };
  }
  return resampleSplinesPair(sideSpline, frontSpline);
}

// Slice a whole-limb (arm or leg) profile pair at a joint Y into two stacked
// sub-profiles. The shared seam (one row at exactly jointY) is appended to the
// upper and prepended to the lower with the SAME radii, so the two meshes that
// get built from these abut flush at the elbow / knee.
//
// Each half is RECENTERED to span symmetrically around y=0 (top at +halfH,
// bottom at -halfH). The mesh builder + the physics capsule are both centered
// on their owner body's local origin, so a non-centered profile would offset
// the mesh from its physics capsule — that bug shows up as upper arm drifting
// above the shoulder and forearm drifting below.
//
// Profiles assumed top→bottom in Y (y descending across the array), which is
// how resampleSplinesPair emits them.
export function sliceProfileAtY(
  profile: { side: Profile; front: Profile },
  jointY: number,
): { upper: { side: Profile; front: Profile }; lower: { side: Profile; front: Profile } } {
  const { side, front } = profile;
  const N = Math.min(side.length, front.length);

  let i = 0;
  while (i < N && side[i][1] > jointY) i++;
  // i is the first index whose Y <= jointY. The split sits between i-1 and i.
  // Clamp so we always have at least one row above and below.
  if (i <= 0) i = 1;
  if (i >= N) i = N - 1;

  function interp(arr: Profile, idx: number): number {
    const a = arr[idx - 1];
    const b = arr[idx];
    const dy = a[1] - b[1];
    if (Math.abs(dy) < 1e-9) return b[0];
    const t = (a[1] - jointY) / dy;
    return a[0] + (b[0] - a[0]) * t;
  }

  const xSide  = interp(side,  i);
  const xFront = interp(front, i);

  const upperSide:  Profile = side.slice(0, i);  upperSide.push([xSide,  jointY]);
  const upperFront: Profile = front.slice(0, i); upperFront.push([xFront, jointY]);
  const lowerSide:  Profile = [[xSide,  jointY], ...side.slice(i)];
  const lowerFront: Profile = [[xFront, jointY], ...front.slice(i)];

  function recenter(p: Profile): Profile {
    const cy = (p[0][1] + p[p.length - 1][1]) / 2;
    return p.map(([x, y]) => [x, y - cy] as [number, number]);
  }

  return {
    upper: { side: recenter(upperSide),  front: recenter(upperFront) },
    lower: { side: recenter(lowerSide),  front: recenter(lowerFront) },
  };
}
