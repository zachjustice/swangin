// Ragdoll physics tuning knobs.
// All values are sourced from ragdoll-config.json — this file re-exports them
// as constants to maintain backwards compatibility with existing imports.

import { CONFIG } from './ragdoll-proportions.ts';

const p = CONFIG.physics;

export const BODY_LINEAR_DAMPING = p.bodyLinearDamping;
export const BODY_ANGULAR_DAMPING_TORSO = p.bodyAngularDampingTorso;
export const BODY_ANGULAR_DAMPING_LIMB = p.bodyAngularDampingLimb;
export const COLLIDER_FRICTION = p.colliderFriction;
export const TORSO_RIGHTING_ENABLED = p.torsoRightingEnabled;
export const TORSO_RIGHTING_KP = p.torsoRightingKp;
export const TORSO_RIGHTING_KD = p.torsoRightingKd;
export const GRAPPLE_REACH_IMPULSE_ENABLED = p.grappleReachImpulseEnabled;
export const GRAPPLE_REACH_IMPULSE_STRENGTH = p.grappleReachImpulseStrength;
export const SHOULDER_KP = p.shoulderKp;
export const SHOULDER_KD = p.shoulderKd;
export const ELBOW_KP = p.elbowKp;
export const ELBOW_KD = p.elbowKd;
export const HIP_KP = p.hipKp;
export const HIP_KD = p.hipKd;
export const KNEE_KP = p.kneeKp;
export const KNEE_KD = p.kneeKd;
export const NECK_KP = p.neckKp;
export const NECK_KD = p.neckKd;
