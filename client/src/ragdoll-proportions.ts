// Shared body proportions used by the local (dynamic) and remote (kinematic)
// ragdolls. POSE_PART_ORDER is the canonical wire order: a Float32Array of
// 10 × 7 = 70 floats encodes (pos.x, pos.y, pos.z, quat.x,y,z,w) per part in
// this exact order. Both peers must agree.

// Local-ragdoll parts share membership 0x0002 and a filter that masks 0x0002,
// so they don't collide with each other (joint anchors sit on body surfaces).
// Remote ragdolls live on 0x0004 so the local filter still lets them through —
// that's what makes local↔remote contact (C11) work without re-enabling
// local self-collisions.
export const RAGDOLL_MEMBERSHIP = 0x0002;
export const RAGDOLL_FILTER = 0xfffd;
export const RAGDOLL_GROUPS = (RAGDOLL_MEMBERSHIP << 16) | RAGDOLL_FILTER;

export const REMOTE_RAGDOLL_MEMBERSHIP = 0x0004;
export const REMOTE_RAGDOLL_FILTER = 0xfffb; // everything except 0x0004
export const REMOTE_RAGDOLL_GROUPS =
  (REMOTE_RAGDOLL_MEMBERSHIP << 16) | REMOTE_RAGDOLL_FILTER;

export const DENSITY = 50;

// Player proportions — chunky, big head.
export const TR = 0.18; // torso radius
export const TH = 0.22; // torso half-height
export const HR = 0.22; // head radius
export const AR = 0.07; // arm radius
export const UA = 0.13; // upper-arm half-length
export const FA = 0.12; // forearm half-length
export const LR = 0.09; // leg radius
export const TT = 0.15; // thigh half-length
export const SN = 0.13; // shin half-length

export const NECK_GAP = 0.04;
export const SHOULDER_OFFSET_X = TR + AR * 0.6;
export const SHOULDER_OFFSET_Y = TH - 0.04;
export const HIP_OFFSET_X = TR * 0.55;

// 10 body parts in a stable order. Used for pose serialization and to keep
// the local ragdoll's parts[] aligned with what gets sent on the wire.
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
  torso: { kind: 'capsule', halfH: TH, r: TR },
  head: { kind: 'ball', r: HR },
  armL_upper: { kind: 'capsule', halfH: UA, r: AR },
  armL_forearm: { kind: 'capsule', halfH: FA, r: AR },
  armR_upper: { kind: 'capsule', halfH: UA, r: AR },
  armR_forearm: { kind: 'capsule', halfH: FA, r: AR },
  legL_thigh: { kind: 'capsule', halfH: TT, r: LR },
  legL_shin: { kind: 'capsule', halfH: SN, r: LR },
  legR_thigh: { kind: 'capsule', halfH: TT, r: LR },
  legR_shin: { kind: 'capsule', halfH: SN, r: LR },
};

// Local-space mesh offsets for ornaments parented under a part (eyes, hand
// sphere, feet). Used by the visual builder for both local and remote.
export const HAND_LOCAL_Y = -FA;
export const FOOT_LOCAL_Y = -SN - LR * 0.3;
export const FOOT_LOCAL_Z = LR * 0.5;
