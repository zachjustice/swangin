// Shared body proportions used by the local (dynamic) and remote (kinematic)
// ragdolls. POSE_PART_ORDER is the canonical wire order: a Float32Array of
// 10 × 7 = 70 floats encodes (pos.x, pos.y, pos.z, quat.x,y,z,w) per part in
// this exact order. Both peers must agree.
//
// 10-body humanoid mirrored after mattvb91/rapierjs-ragdoll: fully passive,
// only spherical joints, no motors, no PD. Arms split into upper+forearm at
// armJointY (analogous to the existing leg thigh+shin split at legJointY).
//
// All tunable values are sourced from ragdoll-config.json — the single source
// of truth for player shape, segmentation, material, and pose. Tune values
// via the ragdoll-prototype playground (logs JSON to console), then paste
// into ragdoll-config.json and reload.
//
// Body-part silhouettes (torso + limb segments) are elliptical sweeps along
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

  // Whole-limb silhouette. Both arm and leg ship as compound parts: the
  // whole-limb profile is split at armJointY / legJointY into upper +
  // lower halves (each recentered around y=0).
  armSideSpline: Spline;
  armFrontSpline: Spline;
  armSideProfile?: Profile;
  armFrontProfile?: Profile;
  armJointY: number;

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
//   head ↔ torso              — ON. Critical: without this, the spherical
//                                neck joint only constrains the head's
//                                center to a fixed distance from the anchor
//                                — it does NOT constrain rotation. With
//                                no head PD (we deleted it), gravity pivots
//                                the head around the anchor and the head
//                                sphere sinks into the torso. The contact
//                                solver is what keeps the head sitting ON
//                                the torso top, same as mattvb91's cuboid
//                                head resting on cuboid torso.
//   arms   ↔ {}                — arm-vs-torso OFF. The shoulder joint anchor
//                                sits inside the torso radius (the original
//                                code worked around this with a 0.18 m
//                                ARM_TOP_CLEARANCE collider trim); in the
//                                passive setup we just exclude the contact
//                                pair, same fix used for thigh-vs-torso.
//                                Arm-vs-arm stays off (joint pair).
//   thighs ↔ {}                — thigh-torso and thigh-thigh OFF; the hip
//                                anchor also sits inside the torso radius.
//   shins  ↔ {torso, head, other shins}
// Within one leg the thigh and shin do NOT collide — they share the knee
// joint and a permanent contact at the joint would fight the solver.
export const RAGDOLL_MEMBERSHIP = 0x0002;
export const RAGDOLL_FILTER = 0xfffd;

const HEAD_TORSO_MEMBERSHIP = 0x0002 | 0x0008;
const HEAD_TORSO_FILTER     = 0x0001 | 0x0004 | 0x0008 | 0x0040; // cubes + remotes + head/torso + shins
const ARM_MEMBERSHIP        = 0x0002 | 0x0010;
const ARM_FILTER            = 0x0001 | 0x0004; // cubes + remotes only
const THIGH_MEMBERSHIP      = 0x0002 | 0x0020;
const THIGH_FILTER          = 0x0001 | 0x0004; // cubes + remotes only
const SHIN_MEMBERSHIP       = 0x0002 | 0x0040;
const SHIN_FILTER           = 0x0001 | 0x0004 | 0x0008 | 0x0040; // cubes + remotes + head/torso + other shins

export const HEAD_TORSO_GROUPS = (HEAD_TORSO_MEMBERSHIP << 16) | HEAD_TORSO_FILTER;
export const ARM_GROUPS        = (ARM_MEMBERSHIP        << 16) | ARM_FILTER;
export const THIGH_GROUPS      = (THIGH_MEMBERSHIP      << 16) | THIGH_FILTER;
export const SHIN_GROUPS       = (SHIN_MEMBERSHIP       << 16) | SHIN_FILTER;

export const REMOTE_RAGDOLL_MEMBERSHIP = 0x0004;
export const REMOTE_RAGDOLL_FILTER = 0xfffb;
export const REMOTE_RAGDOLL_GROUPS =
  (REMOTE_RAGDOLL_MEMBERSHIP << 16) | REMOTE_RAGDOLL_FILTER;

// Union of every bit a ragdoll part (local or remote) carries in its
// membership. Reticle / grapple raycasts mask this entire set out so the
// targeting ray can never latch onto a body part.
export const ALL_RAGDOLL_BITS = 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0020 | 0x0040;

export const DENSITY = 50;

// --- Stiffness gap (mattvb91 trick).
//
// Small inset applied at every joint anchor so two parented colliders don't
// start interpenetrating at rest. mattvb91 uses 0.03 with cuboid colliders
// (corners can dig in). With our capsule colliders the rounded caps touch
// tangentially at a zero-gap joint without overlapping the parent's
// interior, so the contact solver stays quiet. Defaulting to 0 preserves
// the authored config's at-rest look exactly; bump this if a future tuning
// pass ever shows joint jitter.
export const STIFFNESS_GAP = 0;

// --- 10 body parts in a stable order. Used for pose serialization and to
// keep the local ragdoll's parts[] aligned with what gets sent on the wire.
export const POSE_PART_ORDER = [
  'torso',
  'head',
  'armUpperL',
  'armLowerL',
  'armUpperR',
  'armLowerR',
  'legL_thigh',
  'legL_shin',
  'legR_thigh',
  'legR_shin',
] as const;

export type PosePart = (typeof POSE_PART_ORDER)[number];

// Per-part masses in kg. Flatter ratio than the old PD-driven setup:
// mattvb91 uses near-uniform density across all parts; we keep a humanoid
// bias but stay closer than the old 8.3× torso/arm ratio.
export const PART_MASS: Record<PosePart, number> = {
  torso: 4.0,
  head: 1.2,
  armUpperL: 0.8,
  armLowerL: 0.6,
  armUpperR: 0.8,
  armLowerR: 0.6,
  legL_thigh: 1.5,
  legR_thigh: 1.5,
  legL_shin: 1.0,
  legR_shin: 1.0,
};

// --- Torso (kept as explicit knobs for now — the torso splines control its
// silhouette but the capsule physics still uses these two scalars). ---
export const TORSO_RADIUS = CONFIG.torsoRadius;
export const TORSO_HALF_HEIGHT = CONFIG.torsoHalfHeight;
export const HEAD_RADIUS = CONFIG.headRadius;

// --- Whole-limb profile splits ---
// Arm: split at armJointY into upperArm + forearm (recentered halves).
// Leg: split at legJointY into thigh + shin (recentered halves).
function resolveCompound(side: Spline | undefined, front: Spline | undefined,
                         sideStored: Profile | undefined, frontStored: Profile | undefined,
                         jointY: number, name: string) {
  if (!side || !front) throw new Error(`ragdoll-config.json: missing ${name} splines`);
  const full = profileFromConfig(sideStored, frontStored, side, front);
  return sliceProfileAtY(full, jointY);
}

const armSplit = resolveCompound(CONFIG.armSideSpline, CONFIG.armFrontSpline,
                                 CONFIG.armSideProfile, CONFIG.armFrontProfile,
                                 CONFIG.armJointY, 'arm');
const upperArm = armSplit.upper;
const lowerArm = armSplit.lower;

const legSplit = resolveCompound(CONFIG.legSideSpline, CONFIG.legFrontSpline,
                                 CONFIG.legSideProfile, CONFIG.legFrontProfile,
                                 CONFIG.legJointY, 'leg');
const thigh = legSplit.upper;
const shin  = legSplit.lower;

export const ARM_UPPER_SIDE_PROFILE  = upperArm.side;
export const ARM_UPPER_FRONT_PROFILE = upperArm.front;
export const ARM_LOWER_SIDE_PROFILE  = lowerArm.side;
export const ARM_LOWER_FRONT_PROFILE = lowerArm.front;
export const THIGH_SIDE_PROFILE = thigh.side;
export const THIGH_FRONT_PROFILE = thigh.front;
export const SHIN_SIDE_PROFILE  = shin.side;
export const SHIN_FRONT_PROFILE = shin.front;

// --- Per-limb derived half-lengths and radii (physics capsule fits the
// silhouette). ---
export const ARM_UPPER_HALF_LEN = profileHalfHeight(upperArm.side);
export const ARM_LOWER_HALF_LEN = profileHalfHeight(lowerArm.side);
export const THIGH_HALF_LEN = profileHalfHeight(thigh.side);
export const SHIN_HALF_LEN  = profileHalfHeight(shin.side);

export const ARM_UPPER_RADIUS = profileMaxRadius(upperArm.front, upperArm.side);
export const ARM_LOWER_RADIUS = profileMaxRadius(lowerArm.front, lowerArm.side);
export const THIGH_RADIUS = profileMaxRadius(thigh.front, thigh.side);
export const SHIN_RADIUS  = profileMaxRadius(shin.front,  shin.side);

// Widest of the two — used for shoulder gap math and any place the prior
// single-arm code referenced ARM_RADIUS.
export const ARM_RADIUS = Math.max(ARM_UPPER_RADIUS, ARM_LOWER_RADIUS);

// Cross-section radii at the elbow/knee seams — used to drop an ellipsoid
// at the joint so the bend reads smooth instead of exposing two flat caps.
const elbowSeam = {
  side:  upperArm.side[upperArm.side.length - 1][0],
  front: upperArm.front[upperArm.front.length - 1][0],
};
export const ELBOW_SIDE_RADIUS  = elbowSeam.side;
export const ELBOW_FRONT_RADIUS = elbowSeam.front;

const kneeSeam = {
  side:  thigh.side[thigh.side.length - 1][0],
  front: thigh.front[thigh.front.length - 1][0],
};
export const KNEE_SIDE_RADIUS  = kneeSeam.side;
export const KNEE_FRONT_RADIUS = kneeSeam.front;

// --- Joint anchor offsets (also used by physics in ragdoll.ts) ---
export const HEAD_OFFSET_Y = CONFIG.headOffsetY;
export const HIP_OFFSET_Y = CONFIG.hipOffsetY;
// Shoulder X anchor sits at the side of the torso + the upper arm's widest
// section + the user's small tunable gap.
export const SHOULDER_OFFSET_X = TORSO_RADIUS + ARM_UPPER_RADIUS + CONFIG.shoulderGapX;
export const SHOULDER_OFFSET_Y = CONFIG.shoulderOffsetY;
export const HIP_OFFSET_X = TORSO_RADIUS * CONFIG.hipOffsetXRatio;

// --- Rest pose: arm and leg spread from the shoulder / hip (radians around Z).
// In the passive ragdoll these only set the spawn pose; gravity pulls limbs
// to their natural hang within a beat regardless of the spread value.
export const ARM_SPREAD = CONFIG.armSpread;
export const LEG_SPREAD = CONFIG.legSpread;

// --- Material settings shared by local + remote ragdoll materials ---
export const MATERIAL = {
  roughness: CONFIG.roughness,
  metalness: CONFIG.metalness,
} as const;

// Geometry spec per body (used by both the visual builder and the kinematic
// remote builder so capsule/sphere shapes line up exactly).
export type PartShape =
  | { kind: 'capsule'; halfH: number; r: number }
  | { kind: 'ball'; r: number };

export const PART_SHAPES: Record<PosePart, PartShape> = {
  torso:      { kind: 'capsule', halfH: TORSO_HALF_HEIGHT, r: TORSO_RADIUS },
  head:       { kind: 'ball',    r: HEAD_RADIUS },
  armUpperL:  { kind: 'capsule', halfH: ARM_UPPER_HALF_LEN, r: ARM_UPPER_RADIUS },
  armLowerL:  { kind: 'capsule', halfH: ARM_LOWER_HALF_LEN, r: ARM_LOWER_RADIUS },
  armUpperR:  { kind: 'capsule', halfH: ARM_UPPER_HALF_LEN, r: ARM_UPPER_RADIUS },
  armLowerR:  { kind: 'capsule', halfH: ARM_LOWER_HALF_LEN, r: ARM_LOWER_RADIUS },
  legL_thigh: { kind: 'capsule', halfH: THIGH_HALF_LEN,    r: THIGH_RADIUS },
  legL_shin:  { kind: 'capsule', halfH: SHIN_HALF_LEN,     r: SHIN_RADIUS },
  legR_thigh: { kind: 'capsule', halfH: THIGH_HALF_LEN,    r: THIGH_RADIUS },
  legR_shin:  { kind: 'capsule', halfH: SHIN_HALF_LEN,     r: SHIN_RADIUS },
};

// Local-space mesh offsets for ornaments parented under a part (eyes, hand
// sphere, feet). Used by the visual builder for both local and remote.
// Hand sits at the wrist (bottom of the forearm).
export const HAND_LOCAL_Y = -ARM_LOWER_HALF_LEN;
// Foot mesh is centered at its own y=0, so to put its dome apex at
// footTopY (shin-local) the mesh sits halfway-down from that apex.
export const FOOT_LOCAL_Y = CONFIG.footTopY - (SHIN_RADIUS * CONFIG.footH) / 2;
// Place the foot so its back face aligns with the back of the shin
// (z = -SHIN_RADIUS): footCenterZ - footHalfDepth = -SHIN_RADIUS.
export const FOOT_LOCAL_Z = SHIN_RADIUS * (CONFIG.footD / 2 - 1);
