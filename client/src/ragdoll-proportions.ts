// Shared body proportions used by the local (dynamic) and remote (kinematic)
// ragdolls. POSE_PART_ORDER is the canonical wire order: a Float32Array of
// 10 × 7 = 70 floats encodes (pos.x, pos.y, pos.z, quat.x,y,z,w) per part in
// this exact order. Both peers must agree.
//
// All tunable values are sourced from ragdoll-config.json — the single source
// of truth for player shape, segmentation, bumps, material, and pose. Tune
// values via the ragdoll-prototype playground (logs JSON to console), then
// paste into ragdoll-config.json and reload.

import rawConfig from './ragdoll-config.json' with { type: 'json' };

// Locked schema for the JSON. Extending the JSON means extending this type.
export interface RagdollConfig {
  TR: number; TH: number; HR: number;
  AR: number; UA: number; FA: number;
  LR: number; TT: number; SN: number;
  NECK_GAP: number;
  SHOULDER_OFFSET_X_GAP: number;
  SHOULDER_OFFSET_Y: number;
  HIP_OFFSET_X_RATIO: number;
  torsoProfile: Array<[number, number]>;
  upperArmTaperTop: number; upperArmTaperBot: number;
  forearmTaperTop: number;  forearmTaperBot: number;
  thighTaperTop: number;    thighTaperBot: number;
  shinTaperTop: number;     shinTaperBot: number;
  shoulderBumpX: number; shoulderBumpY: number; shoulderBumpR: number;
  hipBumpX: number;      hipBumpY: number;      hipBumpR: number;
  arcSteps: number; wallSteps: number;
  radialSegs: number; torsoRadialSegs: number;
  eyeRRatio: number;
  footW: number; footH: number; footD: number;
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

// --- Proportions (lengths / radii) ---
export const TR = CONFIG.TR;
export const TH = CONFIG.TH;
export const HR = CONFIG.HR;
export const AR = CONFIG.AR;
export const UA = CONFIG.UA;
export const FA = CONFIG.FA;
export const LR = CONFIG.LR;
export const TT = CONFIG.TT;
export const SN = CONFIG.SN;

// --- Joint anchor offsets (also used by physics in ragdoll.ts) ---
export const NECK_GAP = CONFIG.NECK_GAP;
export const SHOULDER_OFFSET_X = TR + AR + CONFIG.SHOULDER_OFFSET_X_GAP;
export const SHOULDER_OFFSET_Y = CONFIG.SHOULDER_OFFSET_Y;
export const HIP_OFFSET_X = TR * CONFIG.HIP_OFFSET_X_RATIO;

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
