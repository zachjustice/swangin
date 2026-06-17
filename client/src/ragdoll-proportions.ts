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
// part's physics box is derived from its profiles: halfH = (yTop - yBot)/2
// (used as the Y half-extent of the cuboid collider) and r = max sampled
// radius across either profile (used as the X/Z half-extent). So the
// spline IS the length, the spline IS the radius — no separate length/
// radius knobs.

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

  physics: {
    bodyLinearDamping: number;
    bodyAngularDampingTorso: number;
    bodyAngularDampingLimb: number;
    colliderFriction: number;
    torsoRightingEnabled: boolean;
    torsoRightingKp: number;
    torsoRightingKd: number;
    grappleReachImpulseEnabled: boolean;
    grappleReachImpulseStrength: number;
    shoulderKp: number;
    shoulderKd: number;
    elbowKp: number;
    elbowKd: number;
    hipKp: number;
    hipKd: number;
    kneeKp: number;
    kneeKd: number;
    neckKp: number;
    neckKd: number;
  };
}

export const CONFIG = rawConfig as unknown as RagdollConfig;

// --- Local-ragdoll collision groups.
//
// Three-group split because the joint anchors are inside the visual torso:
// shoulder is ~0.05 m inside (shoulderGapX=-0.08), hip is essentially AT the
// torso centerline (HIP_OFFSET_X ≈ 0.088, THIGH_RADIUS ≈ 0.087). Arms can
// safely contact the torso once the torso physics box is shrunk to a narrow
// pillar (TORSO_PHYS_HX, defined below) that clears the arm's inboard edge
// at spawn. Thighs can't be cleared by any non-negative torso width, so
// thigh↔torso stays off; the user-visible "arm trapped inside body"
// complaint is the arms case, and arms-on resolves it.
//
// Membership bits:
//   0x0001  world cubes (lattice) — default for cube colliders
//   0x0002  torso + head
//   0x0004  remote ragdoll
//   0x0008  arm (upper + forearm, both sides)
//   0x0010  leg (thigh + shin, both sides)
//
// Self-collision matrix:
//   torso ↔ arm    ON   ← stops arms sitting inside the body
//   torso ↔ leg    OFF  ← irreducible spawn overlap (anchor inside torso)
//   arm   ↔ leg    ON
//   arm   ↔ arm    ON   ← forearm↔upper-arm at elbow brakes elbow twist
//   leg   ↔ leg    ON   ← shin↔thigh at knee brakes knee twist
//   torso ↔ torso  ON   ← head↔torso contact stabilises the neck

export const TORSO_GROUPS = (0x0002 << 16) | (0x0001 | 0x0002 | 0x0004 | 0x0008);
export const ARM_GROUPS = (0x0008 << 16) | (0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010);
export const LEG_GROUPS = (0x0010 << 16) | (0x0001 | 0x0004 | 0x0008 | 0x0010);

export const REMOTE_RAGDOLL_MEMBERSHIP = 0x0004;
export const REMOTE_RAGDOLL_FILTER = 0xfffb;
export const REMOTE_RAGDOLL_GROUPS =
  (REMOTE_RAGDOLL_MEMBERSHIP << 16) | REMOTE_RAGDOLL_FILTER;

// Union of every bit a ragdoll part (local or remote) carries in its
// membership. Reticle / grapple raycasts mask this entire set out so the
// targeting ray can never latch onto a body part.
export const ALL_RAGDOLL_BITS = 0x0002 | 0x0004 | 0x0008 | 0x0010;

// --- Torso physics half-width (X and Z).
//
// Narrower than the visual silhouette (TORSO_RADIUS = 0.12). The shoulder
// joint anchor sits inside the visual torso by ~0.05 m (shoulderGapX is
// negative on purpose, to make arms hang visually flush with the body),
// so a full-width physics torso would have the upper-arm cuboid
// interpenetrating the torso cuboid by ~0.08 m at spawn. A narrow vertical
// pillar clears that — arm inboard edge at SHOULDER_OFFSET_X −
// ARM_UPPER_RADIUS ≈ 0.040, this pillar's edge at TORSO_PHYS_HX = 0.030,
// 10 mm of margin. The visual torso mesh stays at full spline width;
// only physics narrows.
export const TORSO_PHYS_HX = 0.03;

export const DENSITY = 50;

// --- Stiffness gap.
//
// Small inset applied at every joint anchor (except head — see ragdoll.ts).
// Tiny because limb↔torso self-collision is filtered off (TORSO_GROUPS vs
// LIMB_GROUPS), so the only same-ragdoll flat-on-flat contact is
// upper-arm↔forearm at the elbow and thigh↔shin at the knee — both
// vertically stacked cuboids with matching X/Z extent that touch
// face-to-face. 5 mm is enough margin for the contact solver and
// imperceptible visually; 30 mm was leaving a visible joint gap.
export const STIFFNESS_GAP = 0.030;

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

// --- Resolved proportions bundle.
//
// Everything spline- or config-derived used to live as module-level constants
// computed once from the locked CONFIG. The skinned-mesh factory needs to
// accept a parallel snapshot when the tuning prototype rebuilds with a
// slider-mutated config — so this function does the derivation in one place
// and returns a fresh bundle each call. The legacy module-level constants
// below still exist; they're now thin re-exports of fields on the default
// snapshot (`resolveProportions(CONFIG)`) so live-game callers don't change.
export interface ResolvedProportions {
  torsoRadius: number;
  torsoHalfHeight: number;
  torsoFrontProfile: Profile;
  torsoSideProfile: Profile;
  torsoRadialSegs: number;

  headRadius: number;
  headOffsetY: number;
  eyeRRatio: number;

  armUpper: { front: Profile; side: Profile; halfLen: number; radius: number };
  armLower: { front: Profile; side: Profile; halfLen: number; radius: number };
  thigh:    { front: Profile; side: Profile; halfLen: number; radius: number };
  shin:     { front: Profile; side: Profile; halfLen: number; radius: number };

  hipOffsetY: number;
  shoulderOffsetX: number;
  shoulderOffsetY: number;
  hipOffsetX: number;

  radialSegs: number;

  footW: number; footH: number; footD: number;
  footCornerRadius: number;
  footTopY: number;
  footLocalY: number;
  footLocalZ: number;

  handLocalY: number;

  material: { roughness: number; metalness: number };
}

function resolveCompound(side: Spline | undefined, front: Spline | undefined,
  sideStored: Profile | undefined, frontStored: Profile | undefined,
  jointY: number, name: string) {
  if (!side || !front) throw new Error(`ragdoll-config.json: missing ${name} splines`);
  const full = profileFromConfig(sideStored, frontStored, side, front);
  return sliceProfileAtY(full, jointY);
}

export function resolveProportions(cfg: RagdollConfig): ResolvedProportions {
  const torsoRadius = cfg.torsoRadius;

  const armSplit = resolveCompound(cfg.armSideSpline, cfg.armFrontSpline,
    cfg.armSideProfile, cfg.armFrontProfile, cfg.armJointY, 'arm');
  const upperArm = armSplit.upper;
  const lowerArm = armSplit.lower;

  const legSplit = resolveCompound(cfg.legSideSpline, cfg.legFrontSpline,
    cfg.legSideProfile, cfg.legFrontProfile, cfg.legJointY, 'leg');
  const thigh = legSplit.upper;
  const shin = legSplit.lower;

  const armUpperHalfLen = profileHalfHeight(upperArm.side);
  const armLowerHalfLen = profileHalfHeight(lowerArm.side);
  const thighHalfLen = profileHalfHeight(thigh.side);
  const shinHalfLen = profileHalfHeight(shin.side);

  const armUpperRadius = profileMaxRadius(upperArm.front, upperArm.side);
  const armLowerRadius = profileMaxRadius(lowerArm.front, lowerArm.side);
  const thighRadius = profileMaxRadius(thigh.front, thigh.side);
  const shinRadius = profileMaxRadius(shin.front, shin.side);

  return {
    torsoRadius,
    torsoHalfHeight: cfg.torsoHalfHeight,
    torsoFrontProfile: cfg.torsoFrontProfile,
    torsoSideProfile: cfg.torsoSideProfile,
    torsoRadialSegs: cfg.torsoRadialSegs,

    headRadius: cfg.headRadius,
    headOffsetY: cfg.headOffsetY,
    eyeRRatio: cfg.eyeRRatio,

    armUpper: { front: upperArm.front, side: upperArm.side, halfLen: armUpperHalfLen, radius: armUpperRadius },
    armLower: { front: lowerArm.front, side: lowerArm.side, halfLen: armLowerHalfLen, radius: armLowerRadius },
    thigh:    { front: thigh.front,    side: thigh.side,    halfLen: thighHalfLen,    radius: thighRadius },
    shin:     { front: shin.front,     side: shin.side,     halfLen: shinHalfLen,     radius: shinRadius },

    hipOffsetY: cfg.hipOffsetY,
    shoulderOffsetX: torsoRadius + armUpperRadius + cfg.shoulderGapX,
    shoulderOffsetY: cfg.shoulderOffsetY,
    hipOffsetX: torsoRadius * cfg.hipOffsetXRatio,

    radialSegs: cfg.radialSegs,

    footW: cfg.footW, footH: cfg.footH, footD: cfg.footD,
    footCornerRadius: cfg.footCornerRadius,
    footTopY: cfg.footTopY,
    footLocalY: cfg.footTopY - (shinRadius * cfg.footH) / 2,
    footLocalZ: shinRadius * (cfg.footD / 2 - 1),

    handLocalY: -armLowerHalfLen,

    material: { roughness: cfg.roughness, metalness: cfg.metalness },
  };
}

// Default snapshot from the locked JSON — what the live game uses.
export const PROPORTIONS: ResolvedProportions = resolveProportions(CONFIG);

// --- Legacy module-level exports.
//
// All of these are now thin views onto the default snapshot above. Existing
// callers (`ragdoll.ts`, `remote-ragdoll.ts`, the prototype's inline tuner)
// keep working unchanged. New code (the skinned-mesh factory) accepts a
// `ResolvedProportions` argument so the prototype can pass a fresh snapshot
// per slider-driven rebuild.
export const TORSO_RADIUS = PROPORTIONS.torsoRadius;
export const TORSO_HALF_HEIGHT = PROPORTIONS.torsoHalfHeight;
export const HEAD_RADIUS = PROPORTIONS.headRadius;

export const ARM_UPPER_SIDE_PROFILE = PROPORTIONS.armUpper.side;
export const ARM_UPPER_FRONT_PROFILE = PROPORTIONS.armUpper.front;
export const ARM_LOWER_SIDE_PROFILE = PROPORTIONS.armLower.side;
export const ARM_LOWER_FRONT_PROFILE = PROPORTIONS.armLower.front;
export const THIGH_SIDE_PROFILE = PROPORTIONS.thigh.side;
export const THIGH_FRONT_PROFILE = PROPORTIONS.thigh.front;
export const SHIN_SIDE_PROFILE = PROPORTIONS.shin.side;
export const SHIN_FRONT_PROFILE = PROPORTIONS.shin.front;

export const ARM_UPPER_HALF_LEN = PROPORTIONS.armUpper.halfLen;
export const ARM_LOWER_HALF_LEN = PROPORTIONS.armLower.halfLen;
export const THIGH_HALF_LEN = PROPORTIONS.thigh.halfLen;
export const SHIN_HALF_LEN = PROPORTIONS.shin.halfLen;

export const ARM_UPPER_RADIUS = PROPORTIONS.armUpper.radius;
export const ARM_LOWER_RADIUS = PROPORTIONS.armLower.radius;
export const THIGH_RADIUS = PROPORTIONS.thigh.radius;
export const SHIN_RADIUS = PROPORTIONS.shin.radius;

export const ARM_RADIUS = Math.max(ARM_UPPER_RADIUS, ARM_LOWER_RADIUS);

export const HEAD_OFFSET_Y = PROPORTIONS.headOffsetY;
export const HIP_OFFSET_Y = PROPORTIONS.hipOffsetY;
export const SHOULDER_OFFSET_X = PROPORTIONS.shoulderOffsetX;
export const SHOULDER_OFFSET_Y = PROPORTIONS.shoulderOffsetY;
export const HIP_OFFSET_X = PROPORTIONS.hipOffsetX;

export const MATERIAL = PROPORTIONS.material;

// Geometry spec per body (used by both the visual builder and the kinematic
// remote builder so physics shapes line up exactly). Limbs and torso are
// cuboids so flat-face contact at each joint brakes long-axis twist (a
// capsule is rotationally symmetric and a spherical joint imposes no twist
// limit, so capsule limbs spin freely). Half-extents are (r, halfH, r) so
// the box face coincides with the joint anchor (which sits at the end of
// the cylindrical section, e.g. ARM_UPPER_HALF_LEN + STIFFNESS_GAP) and
// two parented boxes meet flat-to-flat across the STIFFNESS_GAP inset.
// The head stays a ball — visual outranks neck-twist behavior.
export type PartShape =
  | { kind: 'cuboid'; hx: number; hy: number; hz: number }
  | { kind: 'ball'; r: number };

export const PART_SHAPES: Record<PosePart, PartShape> = {
  torso: { kind: 'cuboid', hx: TORSO_PHYS_HX, hy: TORSO_HALF_HEIGHT, hz: TORSO_PHYS_HX },
  head: { kind: 'ball', r: HEAD_RADIUS },
  armUpperL: { kind: 'cuboid', hx: ARM_UPPER_RADIUS, hy: ARM_UPPER_HALF_LEN, hz: ARM_UPPER_RADIUS },
  armLowerL: { kind: 'cuboid', hx: ARM_LOWER_RADIUS, hy: ARM_LOWER_HALF_LEN, hz: ARM_LOWER_RADIUS },
  armUpperR: { kind: 'cuboid', hx: ARM_UPPER_RADIUS, hy: ARM_UPPER_HALF_LEN, hz: ARM_UPPER_RADIUS },
  armLowerR: { kind: 'cuboid', hx: ARM_LOWER_RADIUS, hy: ARM_LOWER_HALF_LEN, hz: ARM_LOWER_RADIUS },
  legL_thigh: { kind: 'cuboid', hx: THIGH_RADIUS, hy: THIGH_HALF_LEN, hz: THIGH_RADIUS },
  legL_shin: { kind: 'cuboid', hx: SHIN_RADIUS, hy: SHIN_HALF_LEN, hz: SHIN_RADIUS },
  legR_thigh: { kind: 'cuboid', hx: THIGH_RADIUS, hy: THIGH_HALF_LEN, hz: THIGH_RADIUS },
  legR_shin: { kind: 'cuboid', hx: SHIN_RADIUS, hy: SHIN_HALF_LEN, hz: SHIN_RADIUS },
};

// Local-space mesh offsets for ornaments parented under a part (eyes, hand
// sphere, feet). Used by the visual builder for both local and remote.
// Hand sits at the wrist (bottom of the forearm).
export const HAND_LOCAL_Y = PROPORTIONS.handLocalY;
// Foot mesh is centered at its own y=0, so to put its dome apex at
// footTopY (shin-local) the mesh sits halfway-down from that apex.
export const FOOT_LOCAL_Y = PROPORTIONS.footLocalY;
// Place the foot so its back face aligns with the back of the shin
// (z = -SHIN_RADIUS): footCenterZ - footHalfDepth = -SHIN_RADIUS.
export const FOOT_LOCAL_Z = PROPORTIONS.footLocalZ;

const _ph = CONFIG.physics;
export const BODY_LINEAR_DAMPING = _ph.bodyLinearDamping;
export const BODY_ANGULAR_DAMPING_TORSO = _ph.bodyAngularDampingTorso;
export const BODY_ANGULAR_DAMPING_LIMB = _ph.bodyAngularDampingLimb;
export const COLLIDER_FRICTION = _ph.colliderFriction;
export const TORSO_RIGHTING_ENABLED = _ph.torsoRightingEnabled;
export const TORSO_RIGHTING_KP = _ph.torsoRightingKp;
export const TORSO_RIGHTING_KD = _ph.torsoRightingKd;
export const GRAPPLE_REACH_IMPULSE_ENABLED = _ph.grappleReachImpulseEnabled;
export const GRAPPLE_REACH_IMPULSE_STRENGTH = _ph.grappleReachImpulseStrength;
export const SHOULDER_KP = _ph.shoulderKp;
export const SHOULDER_KD = _ph.shoulderKd;
export const ELBOW_KP = _ph.elbowKp;
export const ELBOW_KD = _ph.elbowKd;
export const HIP_KP = _ph.hipKp;
export const HIP_KD = _ph.hipKd;
export const KNEE_KP = _ph.kneeKp;
export const KNEE_KD = _ph.kneeKd;
export const NECK_KP = _ph.neckKp;
export const NECK_KD = _ph.neckKd;
