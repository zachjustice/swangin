import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  POSE_PART_ORDER, type PosePart,
  STIFFNESS_GAP,
  PROPORTIONS, type ResolvedProportions,
} from './ragdoll-proportions.ts';
import { addHeadDecorations, buildFootGeometry } from './ragdoll-visuals.ts';
import type { Profile } from './ragdoll-spline-sampling.ts';

// Single-mesh ragdoll skin. Replaces the per-part `buildPartVisual` wiring with
// one THREE.SkinnedMesh whose 10 flat bones are driven 1:1 by the existing
// rigid bodies. Elbow and knee seams are ring-stitched: the upper segment's
// bottom ring and the lower segment's top ring coincide in world space and
// share 50/50 weight between the two bones, with a JOINT_BLEND_FRAC ramp into
// each segment so the bend reads as a smooth bulge instead of two cylinders.
// Shoulder/hip/neck have no skin blending in this first pass — the limbs sit
// at their physics bodies' rest positions and the visible torso/limb meeting
// curve is left as-is. Head sphere, foot meshes are standalone primitives
// parented to bones (not skinned).

// Bone-axis fraction over which weights linearly ramp from 0.5/0.5 (at the
// joint seam) to 1.0/0.0 (interior). 0.2 gives a ~4 cm blend zone on a typical
// 20 cm limb segment. Used at the elbow and knee where the segments meet end-
// to-end and the bend wants a fat smooth bulge.
const JOINT_BLEND_FRAC = 0.2;

// Shoulder / hip: the upper-limb sweep is extended upward into the torso
// silhouette by this many metres so the visible meeting curve becomes a single
// continuous surface that the torso shell hides. Asymmetric — the shoulder sits
// near the narrowing top of the torso so less overlap is safe; the hip has a
// fatter torso volume to bury into.
const SHOULDER_OVERLAP = 0.03;
const HIP_OVERLAP = 0.05;
const SHOULDER_EXT_RINGS = 3;
const HIP_EXT_RINGS = 3;

// Fraction of the upper limb's top (just below the joint plane) over which the
// inboard verts blend toward the torso bone. Smaller than JOINT_BLEND_FRAC so
// the limb doesn't visually "melt into" the torso for a quarter of its length.
const SHOULDER_BLEND_FRAC = 0.8;
const HIP_BLEND_FRAC = 0.8;

// Neck: torso top rings blend slightly toward the head bone so the head's
// rotation/translation gives the torso top a soft flex. The head itself stays
// a standalone non-skinned sphere; this is purely re-weighting the torso top.
const NECK_BLEND_FRAC = 0.2;

// Procedural shoulder/hip "bumps" displace torso verts outward toward each
// limb anchor with a smooth falloff, giving the torso its Gang-Beasts shape
// (limbs grow out of a soft bulge instead of poking sharply through a thin
// neck or a smaller-radius hip). The bump heights are DERIVED from the
// resolved proportions at construction time (see buildRagdollSkinnedMesh)
// so the JSON tuner can reshape the torso/limbs without drift; only the
// radial falloff range + the overshoot margin are fixed here.
const SHOULDER_BUMP_RADIUS = 0.20;
const HIP_BUMP_RADIUS = 0.06;
// Small overshoot so the limb tube is fully buried inside the bump instead
// of cleanly tangent to it (which would leave a visible kissing-curve).
const BUMP_HEIGHT_MARGIN = 0.05;

// Smooth Hermite step from 0 (at edge0) to 1 (at edge1). Used both as a
// gentle side gate (avoids the crease a binary half-space cull would create
// at the torso's X=0 silhouette line) and as the upward Y-clamp that keeps
// the bump from puffing out the head-weighted top of the torso.
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Cosine smoothstep over 3D distance to the bump anchor: 1 at the anchor,
// 0 at d>=R. Derivative-zero at both endpoints so the bump tapers in/out
// without a crease.
function cosineFalloff(d: number, R: number): number {
  if (d >= R) return 0;
  return (1 + Math.cos((d / R) * Math.PI)) / 2;
}

// Linear interpolation of the front profile's X-radius at a given segment-
// local Y. The profile is sorted top→bottom in Y (y descending). Used to
// derive bump heights: `localTorsoRadius_at_anchor_Y` tells us how much the
// torso surface needs to push outward to meet the limb's outer edge.
function torsoXRadiusAt(front: Profile, y: number): number {
  const N = front.length;
  if (N === 0) return 0;
  if (y >= front[0][1]) return front[0][0];
  if (y <= front[N - 1][1]) return front[N - 1][0];
  for (let i = 0; i < N - 1; i++) {
    const a = front[i], b = front[i + 1];
    if (a[1] >= y && y >= b[1]) {
      const dy = a[1] - b[1];
      if (dy < 1e-9) return a[0];
      const t = (a[1] - y) / dy;
      return a[0] + (b[0] - a[0]) * t;
    }
  }
  return front[N - 1][0];
}

interface TorsoBump {
  anchor: THREE.Vector3;     // bump centre in WORLD coords
  outwardDir: THREE.Vector3; // unit XZ outward from torso centerline
  height: number;            // peak outward displacement (m)
  radius: number;            // falloff radius (m)
  // Upper-Y clamp: displacement fades to zero as v.y crosses [yClampStart,
  // yClampEnd]. Used for shoulder bumps to keep them out of the
  // NECK_BLEND_FRAC-weighted torso top, which would otherwise pop with the
  // head's rotation. For hip bumps (no head-weight overlap) yClampEnd is
  // set above the torso top so the gate is a no-op.
  yClampStart: number;
  yClampEnd: number;
}

// Displace verts in positions[startIdx*3..endIdx*3] by summing each bump's
// contribution. Each bump contributes `height * radialFalloff * sideGate *
// upperYGate * outwardDir` to the vertex. Bumps live on the torso bone and
// move rigidly with it — no skin-weight changes needed.
const tmpVertV = new THREE.Vector3();
function displaceTorsoVerts(
  positions: number[], startIdx: number, endIdx: number,
  bumps: TorsoBump[], torsoCenter: THREE.Vector3,
): void {
  for (let i = startIdx; i < endIdx; i++) {
    const o = i * 3;
    tmpVertV.set(positions[o], positions[o + 1], positions[o + 2]);
    let dx = 0, dy = 0, dz = 0;
    for (const b of bumps) {
      // Side gate: smooth half-space cull at the torso centerline so the
      // shoulder-R bump can't push the LEFT side of the torso outward.
      // Smoothstep (not a hard `> 0`) avoids the visible crease at X=0
      // where neighboring verts would otherwise straddle the gate edge.
      const vxRel = tmpVertV.x - torsoCenter.x;
      const vzRel = tmpVertV.z - torsoCenter.z;
      const sideDot = vxRel * b.outwardDir.x + vzRel * b.outwardDir.z;
      const sideGate = smoothstep(0, b.radius, sideDot);
      if (sideGate <= 0) continue;
      // Radial falloff: 3D distance to the bump anchor.
      const ax = tmpVertV.x - b.anchor.x;
      const ay = tmpVertV.y - b.anchor.y;
      const az = tmpVertV.z - b.anchor.z;
      const d = Math.sqrt(ax * ax + ay * ay + az * az);
      const f = cosineFalloff(d, b.radius);
      if (f <= 0) continue;
      // Upper Y-clamp: keeps the shoulder bump out of neck-blend territory.
      const yGate = 1 - smoothstep(b.yClampStart, b.yClampEnd, tmpVertV.y);
      const w = b.height * f * sideGate * yGate;
      dx += b.outwardDir.x * w;
      dz += b.outwardDir.z * w;
    }
    positions[o] += dx;
    positions[o + 1] += dy;
    positions[o + 2] += dz;
  }
}

// Skin contributions per vertex: [boneIdx, weight] pairs. Three.js takes 4 of
// these per vert; we never use more than 2.
type SkinContrib = Array<[number, number]>;

export interface BoneRest { position: THREE.Vector3; quaternion: THREE.Quaternion; }

// Spawn-relative rest world transforms for all 10 bones. Mirrors the spawn math
// in ragdoll.ts (makePart / buildArm / buildLeg) so the skin's bind pose lines
// up exactly with the physics bodies at construction time. `overrides` lets
// callers (e.g. the prototype tuning tab) hand-pose specific bones — handy for
// T-pose arms when previewing silhouettes statically.
export function ragdollRestTransforms(
  spawn: THREE.Vector3,
  p: ResolvedProportions = PROPORTIONS,
  overrides: Partial<Record<PosePart, BoneRest>> = {},
): Record<PosePart, BoneRest> {
  const torsoC = spawn.clone();
  const headC = torsoC.clone().add(new THREE.Vector3(0, p.headOffsetY, 0));

  function arm(side: -1 | 1) {
    const shoulder = torsoC.clone().add(
      new THREE.Vector3(side * p.shoulderOffsetX, p.shoulderOffsetY, 0),
    );
    const upperC = shoulder.clone().add(
      new THREE.Vector3(0, -STIFFNESS_GAP - p.armUpper.halfLen, 0),
    );
    const elbow = upperC.clone().add(new THREE.Vector3(0, -p.armUpper.halfLen, 0));
    const lowerC = elbow.clone().add(
      new THREE.Vector3(0, -STIFFNESS_GAP * 2 - p.armLower.halfLen, 0),
    );
    return { upper: upperC, lower: lowerC };
  }
  function leg(side: -1 | 1) {
    const hip = torsoC.clone().add(new THREE.Vector3(side * p.hipOffsetX, p.hipOffsetY, 0));
    const thighC = hip.clone().add(new THREE.Vector3(0, -STIFFNESS_GAP - p.thigh.halfLen, 0));
    const knee = thighC.clone().add(new THREE.Vector3(0, -p.thigh.halfLen, 0));
    const shinC = knee.clone().add(
      new THREE.Vector3(0, -STIFFNESS_GAP * 2 - p.shin.halfLen, 0),
    );
    return { thigh: thighC, shin: shinC };
  }
  const aL = arm(-1), aR = arm(1);
  const lL = leg(-1), lR = leg(1);
  const q = () => new THREE.Quaternion();
  const defaults: Record<PosePart, BoneRest> = {
    torso: { position: torsoC, quaternion: q() },
    head: { position: headC, quaternion: q() },
    armUpperL: { position: aL.upper, quaternion: q() },
    armLowerL: { position: aL.lower, quaternion: q() },
    armUpperR: { position: aR.upper, quaternion: q() },
    armLowerR: { position: aR.lower, quaternion: q() },
    legL_thigh: { position: lL.thigh, quaternion: q() },
    legL_shin: { position: lL.shin, quaternion: q() },
    legR_thigh: { position: lR.thigh, quaternion: q() },
    legR_shin: { position: lR.shin, quaternion: q() },
  };
  for (const k of POSE_PART_ORDER) {
    const o = overrides[k];
    if (o) defaults[k] = { position: o.position.clone(), quaternion: o.quaternion.clone() };
  }
  return defaults;
}

// Bone index in the flat skeleton — matches POSE_PART_ORDER.
const BONE_IDX: Record<PosePart, number> = Object.fromEntries(
  POSE_PART_ORDER.map((n, i) => [n, i]),
) as Record<PosePart, number>;

// Limb chain neighbors used for elbow/knee weight blending.
const CHAIN_PARENT: Partial<Record<PosePart, PosePart>> = {
  armLowerL: 'armUpperL',
  armLowerR: 'armUpperR',
  legL_shin: 'legL_thigh',
  legR_shin: 'legR_thigh',
};
const CHAIN_CHILD: Partial<Record<PosePart, PosePart>> = {
  armUpperL: 'armLowerL',
  armUpperR: 'armLowerR',
  legL_thigh: 'legL_shin',
  legR_thigh: 'legR_shin',
};

// Lower segments (forearm, shin) have their top ring snapped up to coincide
// with the upper segment's bottom ring in world space. This closes the
// 2*STIFFNESS_GAP physical gap between cuboid colliders so the skin reads as
// continuous across the joint.
const TOP_RING_GAP_SNAP: Partial<Record<PosePart, number>> = {
  armLowerL: STIFFNESS_GAP * 2,
  armLowerR: STIFFNESS_GAP * 2,
  legL_shin: STIFFNESS_GAP * 2,
  legR_shin: STIFFNESS_GAP * 2,
};

// Compute the skin contributions for a single ring on a segment, given where
// that ring sits along the bone (yLocalNormalized in [-1, +1] with -1 at
// segment bottom and +1 at top) and which neighbor bones blend at each end.
// topBlendFrac / bottomBlendFrac control how much of the segment's length the
// respective blend zone occupies (0..1 of half-length).
//
// Always returns contributions sorted by bone index so coincident seam verts
// emitted from opposite sides of a joint (upper's bottom ring + lower's top
// ring) get IDENTICAL skinIndex/skinWeight attribute tuples — required for
// mergeVertices to weld them into one shared seam loop.
function ringSkinContribs(
  ownBone: number,
  parentBone: number | null,    // bone above (parent in chain) — used for top-of-segment blend
  childBone: number | null,     // bone below — used for bottom-of-segment blend
  yLocalNormalized: number,
  topBlendFrac: number,
  bottomBlendFrac: number,
): SkinContrib {
  // Clamp into [-1, +1] so the snapped lower-segment top ring (whose yLocal
  // sits 2*STIFFNESS_GAP above its profile top) still lands at the seam
  // endpoint (t = 1, weight = 0.5) instead of overshooting past 50/50.
  const y = Math.max(-1, Math.min(1, yLocalNormalized));
  let pairs: SkinContrib;
  if (parentBone !== null && topBlendFrac > 0 && y > 1 - topBlendFrac) {
    const t = (y - (1 - topBlendFrac)) / topBlendFrac; // 0..1
    const wParent = 0.5 * t;
    pairs = [[ownBone, 1.0 - wParent], [parentBone, wParent]];
  } else if (childBone !== null && bottomBlendFrac > 0 && y < -1 + bottomBlendFrac) {
    const t = ((-1 + bottomBlendFrac) - y) / bottomBlendFrac; // 0..1
    const wChild = 0.5 * t;
    pairs = [[ownBone, 1.0 - wChild], [childBone, wChild]];
  } else {
    return [[ownBone, 1]];
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

// Optional extra rings emitted ABOVE the profile's top ring. Used for the
// shoulder/hip overlap — the limb sweep continues a few cm into the torso
// silhouette so the rendered surface is continuous across the joint instead of
// terminating in a flat disk at the limb top. Each extension ring copies the
// profile's top radii (constant tube into the body) and its skin weight is
// dominated by the extension's parentBone: 1.0 at the deepest ring, ramping
// linearly to 0.5/0.5 at the joint plane (where the profile's normal top sits).
interface UpwardExtension {
  depth: number;        // distance above the profile top in segment-local Y (metres)
  rings: number;        // number of extra rings (the joint-plane ring is NOT counted here)
  parentBone: number;   // the bone the extension is anchored to (deepest ring → 100%)
}

// Pad a SkinContrib to exactly 4 entries (Three.js expects 4-wide skinIndex /
// skinWeight). Unused slots use bone 0 with weight 0.
function pad4(c: SkinContrib): [number, number, number, number, number, number, number, number] {
  const i: number[] = [];
  const w: number[] = [];
  for (let k = 0; k < 4; k++) {
    if (k < c.length) { i.push(c[k][0]); w.push(c[k][1]); }
    else { i.push(0); w.push(0); }
  }
  return [i[0], i[1], i[2], i[3], w[0], w[1], w[2], w[3]];
}

// Emit one ring of M+1 verts whose bone-local positions are
//   (xR*cos a, yLocal, zR*sin a)
// then rotated by `rest.quaternion` and translated by `rest.position` into
// world space. Skipping the rotation step (using rest.position only) is
// correct when the bind quaternion is identity — the skinning round-trip
// keeps verts at the emitted position — but produces axis-aligned rings at
// the bone's translated centroid when the bind quaternion is non-trivial
// (e.g. the prototype's T-pose). Applying it here makes the bind pose
// honour any caller-supplied rest rotation.
const tmpRingV = new THREE.Vector3();
function emitRing(
  positions: number[], skinIdx: number[], skinW: number[], M: number,
  rest: BoneRest, yLocal: number, xR: number, zR: number,
  contribs: SkinContrib,
): number {
  const start = positions.length / 3;
  const [i0, i1, i2, i3, w0, w1, w2, w3] = pad4(contribs);
  for (let j = 0; j <= M; j++) {
    const a = (j / M) * Math.PI * 2;
    tmpRingV.set(xR * Math.cos(a), yLocal, zR * Math.sin(a));
    tmpRingV.applyQuaternion(rest.quaternion);
    tmpRingV.add(rest.position);
    positions.push(tmpRingV.x, tmpRingV.y, tmpRingV.z);
    skinIdx.push(i0, i1, i2, i3);
    skinW.push(w0, w1, w2, w3);
  }
  return start;
}

// Stitch two adjacent rings of M+1 verts into a quad strip. Winding (a,c,b)
// followed by (b,c,d) matches buildSweepGeometry — outward normals after
// computeVertexNormals.
function stitchRings(indices: number[], M: number, startA: number, startB: number) {
  for (let j = 0; j < M; j++) {
    const a = startA + j;
    const c = a + 1;
    const b = startB + j;
    const d = b + 1;
    indices.push(a, c, b);
    indices.push(b, c, d);
  }
}

interface EmitSegmentOpts {
  parentBone: number | null;
  childBone: number | null;
  topBlendFrac: number;
  bottomBlendFrac: number;
  topYShift: number;             // 2*STIFFNESS_GAP for lower segments' top ring; 0 otherwise
  extension: UpwardExtension | null;
}

// Emit a single skinned segment (torso or a limb segment): sample its profile
// into rings, place them in world space at the bone's rest centroid, weight
// them per ring according to which joints (if any) sit at the top/bottom ends.
// When opts.extension is set, also emits a small column of "extra" rings ABOVE
// the profile that extend the limb's sweep into the parent's silhouette — the
// shoulder/hip overlap that hides the limb-to-torso meeting curve.
function emitSegment(
  positions: number[], skinIdx: number[], skinW: number[], indices: number[],
  M: number,
  rest: BoneRest, ownBone: number,
  front: Profile, side: Profile,
  opts: EmitSegmentOpts,
): void {
  const N = Math.min(front.length, side.length);
  // The profile is recentered around y=0 with span [+halfH, -halfH] (top→bot).
  // Cache the top/bot Y for the local-Y → normalized [-1, +1] mapping the
  // blend zones use.
  const yTop = side[0][1];
  const yBot = side[N - 1][1];
  const halfRange = (yTop - yBot) / 2; // == half-length of the segment

  const ringStarts: number[] = [];

  // Optional upward extension into the parent silhouette. Emit from the
  // deepest (topmost in world Y) ring down toward the joint plane — that
  // ordering keeps stitchRings producing outward normals consistent with
  // the rest of the sweep.
  if (opts.extension) {
    const ext = opts.extension;
    const topR_x = front[0][0];
    const topR_z = side[0][0];
    for (let k = ext.rings; k >= 1; k--) {
      const t = k / ext.rings; // 1.0 deepest, → 1/rings at the ring just above joint plane
      const yLocal = yTop + ext.depth * t;
      // Weight ramp: deepest = 100% parent, joint-plane-side = 0.5/0.5 at t→0.
      const wParent = 0.5 + 0.5 * t;
      const pairs: SkinContrib = [[ownBone, 1 - wParent], [ext.parentBone, wParent]];
      pairs.sort((a, b) => a[0] - b[0]);
      const startA = emitRing(
        positions, skinIdx, skinW, M,
        rest, yLocal, topR_x, topR_z, pairs,
      );
      ringStarts.push(startA);
    }
  }

  for (let i = 0; i < N; i++) {
    let yLocal = side[i][1];
    if (i === 0) yLocal += opts.topYShift; // snap top ring up to meet joint above
    const xR = front[i][0];
    const zR = side[i][0];
    const yNorm = halfRange > 1e-9 ? yLocal / halfRange : 0;
    const contribs = ringSkinContribs(
      ownBone, opts.parentBone, opts.childBone, yNorm,
      opts.topBlendFrac, opts.bottomBlendFrac,
    );
    const startA = emitRing(
      positions, skinIdx, skinW, M,
      rest, yLocal, xR, zR, contribs,
    );
    ringStarts.push(startA);
  }
  for (let i = 0; i < ringStarts.length - 1; i++) {
    stitchRings(indices, M, ringStarts[i], ringStarts[i + 1]);
  }
}

export interface RagdollSkinnedMesh {
  mesh: THREE.SkinnedMesh;
  bones: Record<PosePart, THREE.Bone>;
  // Children that aren't skinned (head sphere, feet) carry their own
  // geometries/materials that need cleanup.
  dispose(): void;
}

// Build the full ragdoll: one SkinnedMesh covering torso + 4 arm segments + 4
// leg segments, plus non-skinned head sphere (parented to head bone) and foot
// meshes (parented to each shin bone). `proportions` lets the tuning prototype
// pass a fresh, slider-derived snapshot; `restOverrides` lets it hand-pose
// specific bones (e.g. T-pose arms) for static silhouette previews.
export function buildRagdollSkinnedMesh(
  material: THREE.MeshStandardMaterial,
  spawn: THREE.Vector3 = new THREE.Vector3(),
  proportions: ResolvedProportions = PROPORTIONS,
  restOverrides: Partial<Record<PosePart, BoneRest>> = {},
): RagdollSkinnedMesh {
  const rest = ragdollRestTransforms(spawn, proportions, restOverrides);
  const M = proportions.radialSegs;
  const Mt = proportions.torsoRadialSegs;

  const limbProfiles: Partial<Record<PosePart, { front: Profile; side: Profile }>> = {
    armUpperL: proportions.armUpper,
    armUpperR: proportions.armUpper,
    armLowerL: proportions.armLower,
    armLowerR: proportions.armLower,
    legL_thigh: proportions.thigh,
    legR_thigh: proportions.thigh,
    legL_shin: proportions.shin,
    legR_shin: proportions.shin,
  };

  const positions: number[] = [];
  const skinIdx: number[] = [];
  const skinW: number[] = [];
  const indices: number[] = [];

  // Torso: full sweep. Top NECK_BLEND_FRAC slice blends toward the head bone
  // so the head's motion gives the torso top a soft flex instead of a hard
  // swivel — see SHOULDER/HIP blends below for the same trick at the limbs.
  const torsoVertStart = positions.length / 3;
  emitSegment(
    positions, skinIdx, skinW, indices, Mt,
    rest.torso, BONE_IDX.torso,
    proportions.torsoFrontProfile, proportions.torsoSideProfile,
    {
      parentBone: BONE_IDX.head,
      childBone: null,
      topBlendFrac: NECK_BLEND_FRAC,
      bottomBlendFrac: 0,
      topYShift: 0,
      extension: null,
    },
  );
  const torsoVertEnd = positions.length / 3;

  // Procedural shoulder/hip bumps on the torso shell. Without these, the
  // closed rotationally-symmetric torso tube and the closed limb tubes meet
  // at a visible cross-section ring (the "baby doll snap-in" look). The
  // bumps deform the torso silhouette outward at each anchor so the limb
  // grows out of a soft bulge instead.
  //
  // Heights are derived per-build so torso/limb spline edits stay coherent
  // with the bumps. Each bump's target outward radius at its anchor Y is
  // `anchorLateralX + limbRadius + margin`. The bump needs to add the
  // difference between that target and the torso's current silhouette at
  // that height.
  const torsoFront = proportions.torsoFrontProfile;
  const shoulderTargetX = proportions.shoulderOffsetX + proportions.armUpper.radius;
  const hipTargetX = proportions.hipOffsetX + proportions.thigh.radius;
  const shoulderBumpH = Math.max(
    0,
    shoulderTargetX - torsoXRadiusAt(torsoFront, proportions.shoulderOffsetY) + BUMP_HEIGHT_MARGIN,
  );
  const hipBumpH = Math.max(
    0,
    hipTargetX - torsoXRadiusAt(torsoFront, proportions.hipOffsetY) + BUMP_HEIGHT_MARGIN,
  );

  // Neck-blend zone clamp for shoulder bumps. NECK_BLEND_FRAC of the torso's
  // half-range from the top is head-weighted; displacing those verts would
  // make the shoulder bump pop when the head rotates. The clamp fades the
  // bump to zero before it reaches the head-weighted region.
  const torsoYTop = torsoFront[0][1];
  const torsoYBot = torsoFront[torsoFront.length - 1][1];
  const torsoHalfRange = (torsoYTop - torsoYBot) / 2;
  const neckBlendStartLocal = torsoYTop - NECK_BLEND_FRAC * torsoHalfRange;
  // Convert to world Y (torso bone has identity rotation by construction).
  const neckBlendStartWorld = rest.torso.position.y + neckBlendStartLocal;
  const shoulderYClampStart = neckBlendStartWorld - SHOULDER_BUMP_RADIUS * 0.3;
  const shoulderYClampEnd = neckBlendStartWorld;
  // Hip bumps don't approach head territory — disable the clamp by setting
  // its window above any vert in the torso.
  const yGateOff = rest.torso.position.y + torsoYTop + 1;

  const bumps: TorsoBump[] = [];
  for (const side of [-1, 1] as const) {
    bumps.push({
      anchor: new THREE.Vector3(
        rest.torso.position.x + side * proportions.shoulderOffsetX,
        rest.torso.position.y + proportions.shoulderOffsetY,
        rest.torso.position.z,
      ),
      outwardDir: new THREE.Vector3(side, 0, 0),
      height: shoulderBumpH,
      radius: SHOULDER_BUMP_RADIUS,
      yClampStart: shoulderYClampStart,
      yClampEnd: shoulderYClampEnd,
    });
    bumps.push({
      anchor: new THREE.Vector3(
        rest.torso.position.x + side * proportions.hipOffsetX,
        rest.torso.position.y + proportions.hipOffsetY,
        rest.torso.position.z,
      ),
      outwardDir: new THREE.Vector3(side, 0, 0),
      height: hipBumpH,
      radius: HIP_BUMP_RADIUS,
      yClampStart: yGateOff,
      yClampEnd: yGateOff + 1,
    });
  }
  displaceTorsoVerts(positions, torsoVertStart, torsoVertEnd, bumps, rest.torso.position);

  // Limb segments. Upper segments (armUpper, thigh) attach to the torso at
  // the top: they get a small upward extension into the torso silhouette
  // plus a top-side blend toward the torso bone for a doughy meet. Lower
  // segments (armLower, shin) only attach at the elbow/knee — their top is
  // snapped up by 2*STIFFNESS_GAP so its ring coincides with the upper's
  // bottom ring in world space (the seam is welded by mergeVertices).
  const UPPER_LIMB_CONFIG: Partial<Record<PosePart, { extDepth: number; extRings: number; topFrac: number }>> = {
    armUpperL: { extDepth: SHOULDER_OVERLAP, extRings: SHOULDER_EXT_RINGS, topFrac: SHOULDER_BLEND_FRAC },
    armUpperR: { extDepth: SHOULDER_OVERLAP, extRings: SHOULDER_EXT_RINGS, topFrac: SHOULDER_BLEND_FRAC },
    legL_thigh: { extDepth: HIP_OVERLAP, extRings: HIP_EXT_RINGS, topFrac: HIP_BLEND_FRAC },
    legR_thigh: { extDepth: HIP_OVERLAP, extRings: HIP_EXT_RINGS, topFrac: HIP_BLEND_FRAC },
  };

  const limbParts: PosePart[] = [
    'armUpperL', 'armLowerL',
    'armUpperR', 'armLowerR',
    'legL_thigh', 'legL_shin',
    'legR_thigh', 'legR_shin',
  ];
  for (const part of limbParts) {
    const prof = limbProfiles[part]!;
    const parent = CHAIN_PARENT[part];
    const child = CHAIN_CHILD[part];
    const upper = UPPER_LIMB_CONFIG[part];
    emitSegment(
      positions, skinIdx, skinW, indices, M,
      rest[part], BONE_IDX[part],
      prof.front, prof.side,
      {
        parentBone: upper ? BONE_IDX.torso : (parent ? BONE_IDX[parent] : null),
        childBone: child ? BONE_IDX[child] : null,
        topBlendFrac: upper ? upper.topFrac : JOINT_BLEND_FRAC,
        bottomBlendFrac: JOINT_BLEND_FRAC,
        topYShift: TOP_RING_GAP_SNAP[part] ?? 0,
        extension: upper
          ? { depth: upper.extDepth, rings: upper.extRings, parentBone: BONE_IDX.torso }
          : null,
      },
    );
  }

  // Build the geometry. Merge coincident verts so the elbow/knee seam rings
  // (upper's bottom + lower's top, sitting at the same world position with
  // identical skin weights) collapse into one shared loop — smooth normals
  // across the joint after computeVertexNormals.
  let geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));
  geom.setIndex(indices);
  geom = mergeVertices(geom, 1e-5);
  geom.computeVertexNormals();

  // Bones — flat skeleton, no parent/child chain. Each bone sits at its rest
  // world transform; bind matrix is the inverse of that transform so the verts
  // (emitted in world space at bind) skin correctly when the bone moves.
  const bones = {} as Record<PosePart, THREE.Bone>;
  const boneArr: THREE.Bone[] = [];
  const boneInverses: THREE.Matrix4[] = [];
  for (const name of POSE_PART_ORDER) {
    const bone = new THREE.Bone();
    const r = rest[name];
    bone.position.copy(r.position);
    bone.quaternion.copy(r.quaternion);
    bones[name] = bone;
    boneArr.push(bone);
    const m = new THREE.Matrix4().compose(r.position, r.quaternion, new THREE.Vector3(1, 1, 1));
    boneInverses.push(m.invert());
  }

  const skeleton = new THREE.Skeleton(boneArr, boneInverses);
  const mesh = new THREE.SkinnedMesh(geom, material);
  // Parent all bones to the SkinnedMesh so their world matrices are derived
  // from the mesh's matrix (which we leave at identity). With the mesh at the
  // scene origin, bone.position carries the absolute world position the
  // physics bodies write into.
  for (const b of boneArr) mesh.add(b);
  mesh.bind(skeleton, new THREE.Matrix4());
  // Three.js frustum-tests the SkinnedMesh against the bind-pose bounding
  // sphere (computed from the buffer as written, i.e. the tight upright pose
  // at spawn). Once the bones drag the actual skinned verts away from there,
  // the bind-pose sphere can exit the frustum while the rendered skin is
  // still on-screen — the renderer culls the body and we see only the
  // non-skinned head sphere + foot domes floating with their bones. Skinning
  // 10 bones is cheap; opting out of culling is the standard remedy.
  mesh.frustumCulled = false;

  // Non-skinned children parented to bones. Head sphere + eye/mouth, foot
  // dome on each shin. These move rigidly with their bone (no skin blending),
  // which matches the Gang-Beasts look — the head and feet read as distinct
  // primitives floating with the body.
  const ownedGeoms: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];

  const headSphereGeom = new THREE.SphereGeometry(proportions.headRadius, 20, 16);
  ownedGeoms.push(headSphereGeom);
  const headSphere = new THREE.Mesh(headSphereGeom, material);
  bones.head.add(headSphere);
  const eyeMat = addHeadDecorations(headSphere, proportions.headRadius, proportions.eyeRRatio);
  ownedMats.push(eyeMat);

  const shinRadius = proportions.shin.radius;
  const footW = shinRadius * proportions.footW;
  const footH = shinRadius * proportions.footH;
  const footD = shinRadius * proportions.footD;
  const footR = shinRadius * proportions.footCornerRadius;
  for (const shinName of ['legL_shin', 'legR_shin'] as const) {
    const footGeom = buildFootGeometry(footW, footH, footD, footR);
    ownedGeoms.push(footGeom);
    const foot = new THREE.Mesh(footGeom, material);
    foot.position.set(0, proportions.footLocalY, proportions.footLocalZ);
    bones[shinName].add(foot);
  }

  function dispose() {
    skeleton.dispose();
    geom.dispose();
    for (const g of ownedGeoms) g.dispose();
    for (const m of ownedMats) m.dispose();
  }

  return { mesh, bones, dispose };
}
