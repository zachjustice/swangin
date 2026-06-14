// Shared body proportions used by the local (dynamic) and remote (kinematic)
// ragdolls. POSE_PART_ORDER is the canonical wire order: a Float32Array of
// 8 × 7 = 56 floats encodes (pos.x, pos.y, pos.z, quat.x,y,z,w) per part in
// this exact order. Both peers must agree.
//
// All tunable values are sourced from ragdoll-config.json — the single source
// of truth for player shape, segmentation, material, and pose. Tune values
// via the ragdoll-prototype playground (logs JSON to console), then paste
// into ragdoll-config.json and reload.
//
// Body-part silhouettes (torso + 4 limb segments) are elliptical sweeps along
// Y, with semi-axes from a pair of Catmull-Rom splines (Front + Side). Each
// part's physics capsule is derived from its profiles: halfH = (yTop - yBot)/2
// and r = max sampled radius across either profile. So the spline IS the
// length, the spline IS the radius — no separate length/radius knobs.

import rawConfig from './ragdoll-config.json' with { type: 'json' };
import {
  profileFromConfig, profileHalfHeight, profileMaxRadius, sliceProfileAtY,
  type Profile, type Spline,
} from './ragdoll-spline-sampling.ts';

// Locked schema for the JSON. Extending the JSON means extending this type.
export interface RagdollConfig {
  torsoRadius: number;
  torsoHalfHeight: number;
  headRadius: number;
  headOffsetY: number;
  hipOffsetY: number;
  shoulderGapX: number;
  shoulderOffsetY: number;
  hipOffsetXRatio: number;

  // Elliptical-sweep profiles (sampled) + splines (5 control points).
  // For each part, side controls Z extent and front controls X extent.
  // Profiles are optional in JSON — when missing the live game resamples
  // from the splines on the fly.
  torsoSideProfile: Profile;
  torsoFrontProfile: Profile;
  torsoSideSpline?: Spline;
  torsoFrontSpline?: Spline;

  // Whole-limb silhouette. Arm ships as a single sweep (shoulder→wrist) with
  // no elbow — one rigid body per arm. Leg still ships as a compound: legJointY
  // splits the profile into thigh + shin (recentered halves) for the knee.
  armSideSpline: Spline;
  armFrontSpline: Spline;
  armSideProfile?: Profile;
  armFrontProfile?: Profile;

  legSideSpline: Spline;
  legFrontSpline: Spline;
  legSideProfile?: Profile;
  legFrontProfile?: Profile;
  legJointY: number;

  radialSegs: number;
  torsoRadialSegs: number;
  eyeRRatio: number;
  footW: number; footH: number; footD: number;
  footCornerRadius: number;
  // Y of the foot dome's apex in shin-local coords. The foot's vertical
  // extent is [footTopY − footH·SHIN_RADIUS, footTopY], so this directly
  // controls where the top of the dome sits relative to the shin.
  footTopY: number;
  color: string;
  roughness: number; metalness: number;
  armSpread: number; legSpread: number;
}

export const CONFIG = rawConfig as unknown as RagdollConfig;

// --- Local-ragdoll collision groups.
//
// Membership bits in use across the project:
//   0x0001  world cubes (lattice)
//   0x0002  ragdoll-base — every local ragdoll part carries this; we mask it
//           out of every local filter so unrelated parts can never collide
//   0x0004  remote ragdoll
//   0x0008  torso/head marker — enables arm contact with head and torso
//   0x0010  arm marker — enables torso/head contact with arms
//   0x0020  thigh marker — reserved (no filter currently accepts it)
//   0x0040  shin marker  — enables torso + cross-side shin contact
//
// Selective self-collision matrix:
//   arms   ↔ {torso, head}
//   thighs ↔ {}                     — thigh-torso AND thigh-thigh OFF.
//                                     HIP_OFFSET_X (~0.09 m) sits INSIDE
//                                     the torso radius (0.12 m), so each
//                                     thigh capsule (r ~0.08 m) deeply
//                                     overlaps the torso's bottom
//                                     hemisphere at rest — contact would
//                                     splay the legs outward. Same logic
//                                     for thigh-thigh.
//   shins  ↔ {torso, other shins}   — shins are far enough apart at the
//                                     knees that cross-side contact is
//                                     fine.
// Within one leg the thigh and shin do NOT collide — they share the knee
// revolute and a permanent contact at the joint would fight the solver.
// Cross-leg thigh ↔ shin is also off; rare in practice and avoiding it
// keeps the matrix symmetric and simple.
//
// Filter format = bits we ACCEPT contact from. Pair test:
// `(A.mem & B.fil) ≠ 0  AND  (B.mem & A.fil) ≠ 0`.
export const RAGDOLL_MEMBERSHIP = 0x0002;
export const RAGDOLL_FILTER = 0xfffd;

const HEAD_TORSO_MEMBERSHIP = 0x0002 | 0x0008;
const HEAD_TORSO_FILTER     = 0x0001 | 0x0004 | 0x0010 | 0x0040; // cubes + remotes + arms + shins
const ARM_MEMBERSHIP        = 0x0002 | 0x0010;
const ARM_FILTER            = 0x0001 | 0x0004 | 0x0008; // cubes + remotes + head/torso
// Thigh ↔ torso is OFF: the hip spherical-joint anchor sits inside the
// torso surface (HIP_OFFSET_X ~0.09 m < TORSO_RADIUS 0.12 m), so the
// thigh capsule penetrates the torso's bottom hemisphere at rest and
// the contact-solver permanently splays the legs into an inverted Y.
// Thigh-thigh is OFF for the same overlap-at-rest reason.
const THIGH_MEMBERSHIP      = 0x0002 | 0x0020;
const THIGH_FILTER          = 0x0001 | 0x0004; // cubes + remotes only
// Shins are further apart at the knees so cross-side shin contact can
// stay on without splay regression.
const SHIN_MEMBERSHIP       = 0x0002 | 0x0040;
const SHIN_FILTER           = 0x0001 | 0x0004 | 0x0008 | 0x0040; // cubes + remotes + head/torso + other shins

export const HEAD_TORSO_GROUPS = (HEAD_TORSO_MEMBERSHIP << 16) | HEAD_TORSO_FILTER;
export const ARM_GROUPS        = (ARM_MEMBERSHIP        << 16) | ARM_FILTER;
export const THIGH_GROUPS      = (THIGH_MEMBERSHIP      << 16) | THIGH_FILTER;
export const SHIN_GROUPS       = (SHIN_MEMBERSHIP       << 16) | SHIN_FILTER;

/** @deprecated Use THIGH_GROUPS / SHIN_GROUPS. Alias of THIGH_GROUPS so
 *  any older import keeps building. */
export const LEG_GROUPS = THIGH_GROUPS;

/** @deprecated Use the per-role group (HEAD_TORSO_GROUPS / ARM_GROUPS /
 *  THIGH_GROUPS / SHIN_GROUPS) instead. Kept as an alias of THIGH_GROUPS
 *  so anything that imported the old "block all self-collision" mask
 *  still works. */
export const RAGDOLL_GROUPS = THIGH_GROUPS;

export const REMOTE_RAGDOLL_MEMBERSHIP = 0x0004;
export const REMOTE_RAGDOLL_FILTER = 0xfffb;
export const REMOTE_RAGDOLL_GROUPS =
  (REMOTE_RAGDOLL_MEMBERSHIP << 16) | REMOTE_RAGDOLL_FILTER;

// Union of every bit a ragdoll part (local or remote) carries in its
// membership. Reticle / grapple raycasts mask this entire set out so the
// targeting ray can never latch onto a body part. Masking only the
// 0x0002 base bit isn't enough — head/torso/arm/thigh/shin each also
// carry a role bit (0x0008…0x0040) that would otherwise satisfy the
// pair test against a default-filter raycast.
export const ALL_RAGDOLL_BITS = 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0020 | 0x0040;

export const DENSITY = 50;

// Per-part masses in kg. Overrides DENSITY (which would make the head
// nearly as heavy as the torso at these proportions, so head bonks yank
// the body). Humanoid-ish: heavy torso, light arms/head.
export const PART_MASS: Record<PosePart, number> = {
  torso: 5.0,
  head: 1.0,
  armL: 0.6,
  armR: 0.6,
  legL_thigh: 1.4,
  legR_thigh: 1.4,
  legL_shin: 0.9,
  legR_shin: 0.9,
};

// --- Torso (kept as explicit knobs for now — the torso splines control its
// silhouette but the capsule physics still uses these two scalars). ---
export const TORSO_RADIUS = CONFIG.torsoRadius;
export const TORSO_HALF_HEIGHT = CONFIG.torsoHalfHeight;
export const HEAD_RADIUS = CONFIG.headRadius;

// --- Whole-limb profile (arm) + joint split (leg) ---
// Arm: one rigid body from shoulder to wrist, no elbow. Profile is the full
// arm silhouette.
// Leg: thigh + shin split at legJointY (recentered halves), with a knee ball.
function resolveCompound(side: Spline | undefined, front: Spline | undefined,
                         sideStored: Profile | undefined, frontStored: Profile | undefined,
                         jointY: number, name: string) {
  if (!side || !front) throw new Error(`ragdoll-config.json: missing ${name} splines`);
  const full = profileFromConfig(sideStored, frontStored, side, front);
  return sliceProfileAtY(full, jointY);
}

if (!CONFIG.armSideSpline || !CONFIG.armFrontSpline) {
  throw new Error('ragdoll-config.json: missing arm splines');
}
const arm = profileFromConfig(
  CONFIG.armSideProfile, CONFIG.armFrontProfile,
  CONFIG.armSideSpline,  CONFIG.armFrontSpline,
);
const legSplit = resolveCompound(CONFIG.legSideSpline, CONFIG.legFrontSpline,
                                 CONFIG.legSideProfile, CONFIG.legFrontProfile,
                                 CONFIG.legJointY, 'leg');
const thigh = legSplit.upper;
const shin  = legSplit.lower;

export const ARM_SIDE_PROFILE   = arm.side;
export const ARM_FRONT_PROFILE  = arm.front;
export const THIGH_SIDE_PROFILE = thigh.side;
export const THIGH_FRONT_PROFILE = thigh.front;
export const SHIN_SIDE_PROFILE  = shin.side;
export const SHIN_FRONT_PROFILE = shin.front;

// --- Per-limb derived half-lengths and radii (physics capsule fits the
// silhouette). ---
export const ARM_HALF_LEN   = profileHalfHeight(arm.side);
export const THIGH_HALF_LEN = profileHalfHeight(thigh.side);
export const SHIN_HALF_LEN  = profileHalfHeight(shin.side);

export const ARM_RADIUS   = profileMaxRadius(arm.front,   arm.side);
export const THIGH_RADIUS = profileMaxRadius(thigh.front, thigh.side);
export const SHIN_RADIUS  = profileMaxRadius(shin.front,  shin.side);

// Cross-section radii at the knee seam — used to drop an ellipsoid at the
// joint so the bend reads smooth instead of exposing two flat caps. The thigh
// is recentered with the seam at its bottom (last entry).
const kneeSeam = {
  side:  thigh.side[thigh.side.length - 1][0],
  front: thigh.front[thigh.front.length - 1][0],
};
export const KNEE_SIDE_RADIUS  = kneeSeam.side;
export const KNEE_FRONT_RADIUS = kneeSeam.front;

// --- Joint anchor offsets (also used by physics in ragdoll.ts) ---
export const HEAD_OFFSET_Y = CONFIG.headOffsetY;
export const HIP_OFFSET_Y = CONFIG.hipOffsetY;
// Shoulder X anchor sits at the side of the torso + the arm's widest section
// + the user's small tunable gap.
export const SHOULDER_OFFSET_X = TORSO_RADIUS + ARM_RADIUS + CONFIG.shoulderGapX;
export const SHOULDER_OFFSET_Y = CONFIG.shoulderOffsetY;
export const HIP_OFFSET_X = TORSO_RADIUS * CONFIG.hipOffsetXRatio;

// --- Rest pose: arm and leg spread from the shoulder / hip (radians around Z).
// Drives both spawn placement AND the PD motor's rest target so the ragdoll
// returns to this pose when nothing is dragging it.
export const ARM_SPREAD = CONFIG.armSpread;
export const LEG_SPREAD = CONFIG.legSpread;

// --- Material settings shared by local + remote ragdoll materials ---
export const MATERIAL = {
  roughness: CONFIG.roughness,
  metalness: CONFIG.metalness,
} as const;

// --- 8 body parts in a stable order. Used for pose serialization and to
// keep the local ragdoll's parts[] aligned with what gets sent on the wire.
export const POSE_PART_ORDER = [
  'torso',
  'head',
  'armL',
  'armR',
  'legL_thigh',
  'legL_shin',
  'legR_thigh',
  'legR_shin',
] as const;

export type PosePart = (typeof POSE_PART_ORDER)[number];

// Geometry spec per body (used by both the visual builder and the kinematic
// remote builder so capsule/sphere shapes line up exactly).
export type PartShape =
  | { kind: 'capsule'; halfH: number; r: number }
  | { kind: 'ball'; r: number };

export const PART_SHAPES: Record<PosePart, PartShape> = {
  torso:      { kind: 'capsule', halfH: TORSO_HALF_HEIGHT, r: TORSO_RADIUS },
  head:       { kind: 'ball',    r: HEAD_RADIUS },
  armL:       { kind: 'capsule', halfH: ARM_HALF_LEN,      r: ARM_RADIUS },
  armR:       { kind: 'capsule', halfH: ARM_HALF_LEN,      r: ARM_RADIUS },
  legL_thigh: { kind: 'capsule', halfH: THIGH_HALF_LEN,    r: THIGH_RADIUS },
  legL_shin:  { kind: 'capsule', halfH: SHIN_HALF_LEN,     r: SHIN_RADIUS },
  legR_thigh: { kind: 'capsule', halfH: THIGH_HALF_LEN,    r: THIGH_RADIUS },
  legR_shin:  { kind: 'capsule', halfH: SHIN_HALF_LEN,     r: SHIN_RADIUS },
};

// Local-space mesh offsets for ornaments parented under a part (eyes, hand
// sphere, feet). Used by the visual builder for both local and remote.
// Hand sits at the wrist (bottom of the arm capsule).
export const HAND_LOCAL_Y = -ARM_HALF_LEN;
// Foot mesh is centered at its own y=0, so to put its dome apex at
// footTopY (shin-local) the mesh sits halfway-down from that apex.
export const FOOT_LOCAL_Y = CONFIG.footTopY - (SHIN_RADIUS * CONFIG.footH) / 2;
// Place the foot so its back face aligns with the back of the shin
// (z = -SHIN_RADIUS): footCenterZ - footHalfDepth = -SHIN_RADIUS.
export const FOOT_LOCAL_Z = SHIN_RADIUS * (CONFIG.footD / 2 - 1);
