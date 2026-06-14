// Shared body proportions used by the local (dynamic) and remote (kinematic)
// ragdolls. POSE_PART_ORDER is the canonical wire order: a Float32Array of
// 10 × 7 = 70 floats encodes (pos.x, pos.y, pos.z, quat.x,y,z,w) per part in
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

  // Whole-limb silhouette: one spline pair for the entire arm (shoulder→wrist)
  // and entire leg (hip→ankle). The elbow / knee position is a separate Y
  // value (in limb-local coords, between yTop and yBot) that splits the
  // profile into upper + lower halves for the physics capsules.
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
  color: string;
  roughness: number; metalness: number;
  armSpread: number; legSpread: number;
}

export const CONFIG = rawConfig as unknown as RagdollConfig;

// --- Local-ragdoll parts share membership 0x0002 and a filter that masks 0x0002,
// so they don't collide with each other (joint anchors sit on body surfaces).
// Remote ragdolls live on 0x0004 so the local filter still lets them through —
// that's what makes local↔remote contact (C11) work without re-enabling
// local self-collisions.
export const RAGDOLL_MEMBERSHIP = 0x0002;
export const RAGDOLL_FILTER = 0xfffd;
export const RAGDOLL_GROUPS = (RAGDOLL_MEMBERSHIP << 16) | RAGDOLL_FILTER;

export const REMOTE_RAGDOLL_MEMBERSHIP = 0x0004;
export const REMOTE_RAGDOLL_FILTER = 0xfffb;
export const REMOTE_RAGDOLL_GROUPS =
  (REMOTE_RAGDOLL_MEMBERSHIP << 16) | REMOTE_RAGDOLL_FILTER;

export const DENSITY = 50;

// --- Torso (kept as explicit knobs for now — the torso splines control its
// silhouette but the capsule physics still uses these two scalars). ---
export const TORSO_RADIUS = CONFIG.torsoRadius;
export const TORSO_HALF_HEIGHT = CONFIG.torsoHalfHeight;
export const HEAD_RADIUS = CONFIG.headRadius;

// --- Whole-limb profile + joint split ---
// The arm and leg each ship as a single spline pair (shoulder→wrist for arm,
// hip→ankle for leg). The elbow / knee Y splits the full profile into the
// upper and lower physics segments; their flat faces meet flush at that Y.
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
const legSplit = resolveCompound(CONFIG.legSideSpline, CONFIG.legFrontSpline,
                                 CONFIG.legSideProfile, CONFIG.legFrontProfile,
                                 CONFIG.legJointY, 'leg');
const upperArm = armSplit.upper;
const forearm  = armSplit.lower;
const thigh    = legSplit.upper;
const shin     = legSplit.lower;

export const UPPER_ARM_SIDE_PROFILE  = upperArm.side;
export const UPPER_ARM_FRONT_PROFILE = upperArm.front;
export const FOREARM_SIDE_PROFILE    = forearm.side;
export const FOREARM_FRONT_PROFILE   = forearm.front;
export const THIGH_SIDE_PROFILE      = thigh.side;
export const THIGH_FRONT_PROFILE     = thigh.front;
export const SHIN_SIDE_PROFILE       = shin.side;
export const SHIN_FRONT_PROFILE      = shin.front;

// --- Per-limb derived half-lengths and radii (physics capsule fits the
// silhouette). ---
export const UPPER_ARM_HALF_LEN = profileHalfHeight(upperArm.side);
export const FOREARM_HALF_LEN   = profileHalfHeight(forearm.side);
export const THIGH_HALF_LEN     = profileHalfHeight(thigh.side);
export const SHIN_HALF_LEN      = profileHalfHeight(shin.side);

export const UPPER_ARM_RADIUS = profileMaxRadius(upperArm.front, upperArm.side);
export const FOREARM_RADIUS   = profileMaxRadius(forearm.front,  forearm.side);
export const THIGH_RADIUS     = profileMaxRadius(thigh.front,    thigh.side);
export const SHIN_RADIUS      = profileMaxRadius(shin.front,     shin.side);

// --- Joint anchor offsets (also used by physics in ragdoll.ts) ---
export const HEAD_OFFSET_Y = CONFIG.headOffsetY;
export const HIP_OFFSET_Y = CONFIG.hipOffsetY;
// Shoulder X anchor sits at the side of the torso + the upper arm's widest
// section + the user's small tunable gap. Uses UPPER_ARM_RADIUS now that
// "armRadius" is per-segment.
export const SHOULDER_OFFSET_X = TORSO_RADIUS + UPPER_ARM_RADIUS + CONFIG.shoulderGapX;
export const SHOULDER_OFFSET_Y = CONFIG.shoulderOffsetY;
export const HIP_OFFSET_X = TORSO_RADIUS * CONFIG.hipOffsetXRatio;

// --- Material settings shared by local + remote ragdoll materials ---
export const MATERIAL = {
  roughness: CONFIG.roughness,
  metalness: CONFIG.metalness,
} as const;

// --- 10 body parts in a stable order. Used for pose serialization and to
// keep the local ragdoll's parts[] aligned with what gets sent on the wire.
export const POSE_PART_ORDER = [
  'torso',
  'head',
  'armL_upper',
  'armL_forearm',
  'armR_upper',
  'armR_forearm',
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
  torso:        { kind: 'capsule', halfH: TORSO_HALF_HEIGHT,  r: TORSO_RADIUS },
  head:         { kind: 'ball',    r: HEAD_RADIUS },
  armL_upper:   { kind: 'capsule', halfH: UPPER_ARM_HALF_LEN, r: UPPER_ARM_RADIUS },
  armL_forearm: { kind: 'capsule', halfH: FOREARM_HALF_LEN,   r: FOREARM_RADIUS },
  armR_upper:   { kind: 'capsule', halfH: UPPER_ARM_HALF_LEN, r: UPPER_ARM_RADIUS },
  armR_forearm: { kind: 'capsule', halfH: FOREARM_HALF_LEN,   r: FOREARM_RADIUS },
  legL_thigh:   { kind: 'capsule', halfH: THIGH_HALF_LEN,     r: THIGH_RADIUS },
  legL_shin:    { kind: 'capsule', halfH: SHIN_HALF_LEN,      r: SHIN_RADIUS },
  legR_thigh:   { kind: 'capsule', halfH: THIGH_HALF_LEN,     r: THIGH_RADIUS },
  legR_shin:    { kind: 'capsule', halfH: SHIN_HALF_LEN,      r: SHIN_RADIUS },
};

// Local-space mesh offsets for ornaments parented under a part (eyes, hand
// sphere, feet). Used by the visual builder for both local and remote.
export const HAND_LOCAL_Y = -FOREARM_HALF_LEN;
export const FOOT_LOCAL_Y = -SHIN_HALF_LEN - SHIN_RADIUS * 0.3;
// Place the foot so its back face aligns with the back of the shin
// (z = -SHIN_RADIUS): footCenterZ - footHalfDepth = -SHIN_RADIUS.
export const FOOT_LOCAL_Z = SHIN_RADIUS * (CONFIG.footD / 2 - 1);
