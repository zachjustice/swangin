// Ragdoll physics tuning knobs.
//
// After the passive-skeleton restructure (mirror of mattvb91/rapierjs-ragdoll),
// the ragdoll has no PD controllers, no cone PD, no head chain, no knee motor,
// and no hip twist constraint. The only "active" force is the optional grapple
// reach impulse (off by default — set GRAPPLE_REACH_IMPULSE_ENABLED to true).
//
// Tweak, reload the page, playtest.

// ─────────────────────────────────────────────────────────────────────────────
// Body-level damping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linear damping applied to every ragdoll rigid body. Higher = more drag
 * on translation through space (the player feels "sticky" in the air).
 * Range: 0 (no drag) → 0.5 (very draggy).
 * Default: 0.05.
 */
export const BODY_LINEAR_DAMPING = 0.05;

/**
 * Angular damping applied to the torso (and head). Lower lets the body
 * swing freely on the grapple line.
 * Range: 0 (free spin) → 1.5 (sluggish).
 * Default: 0.05.
 */
export const BODY_ANGULAR_DAMPING_TORSO = 0.05;

/**
 * Angular damping applied to every limb (arms + legs). Higher than the
 * torso value so limbs visibly trail and lag through swing arcs — the
 * core "organic cartoony swing" effect. The PD motors handle return-
 * to-pose; this controls how fast the trail decays.
 * Range: 0 (windsock) → 1.5 (sluggish).
 * Default: 0.4.
 */
export const BODY_ANGULAR_DAMPING_LIMB = 0.4;

// ─────────────────────────────────────────────────────────────────────────────
// Collider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Friction coefficient between ragdoll parts and the world cubes.
 * Range: 0 (ice) → 1.0 (rubbery, sticks on cubes during a swing).
 * Default: 0.5.
 */
export const COLLIDER_FRICTION = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Optional torso uprightness assist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If true, motors.update() applies a very weak corrective torque on the
 * torso toward world-vertical. mattvb91's ragdoll is fully passive — the
 * character lies on the ground forever once knocked down. Flip this on
 * if play-testing finds that unfun.
 * Default: false.
 */
export const TORSO_RIGHTING_ENABLED = false;

/**
 * Torso uprightness spring (only used when TORSO_RIGHTING_ENABLED).
 * Much weaker than the old TORSO_PD_KP=50 — this is gentle nudging, not
 * snap-to-vertical.
 * Range: 0 (off) → 10 (mannequin-y).
 * Default: 2.
 */
export const TORSO_RIGHTING_KP = 2;

/**
 * Torso uprightness damping (only used when TORSO_RIGHTING_ENABLED).
 * Range: 0 → 1.
 * Default: 0.2.
 */
export const TORSO_RIGHTING_KD = 0.2;

// ─────────────────────────────────────────────────────────────────────────────
// Grapple reach impulse (forearm only, while grappling)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If true, motors.update() applies a small impulse to the right forearm
 * toward the grapple anchor each substep — keeps the arm pulled in the
 * grapple direction without a PD motor. mattvb91 uses the same applyImpulse
 * pattern for user-driven force.
 * Default: true.
 */
export const GRAPPLE_REACH_IMPULSE_ENABLED = true;

/**
 * Magnitude of the per-substep impulse applied to the forearm toward the
 * grapple anchor. Scaled by the forearm mass elsewhere, so this is a
 * dimensionless multiplier.
 * Range: 0 (no reach assist) → 0.5 (snappy).
 * Default: 0.08.
 */
export const GRAPPLE_REACH_IMPULSE_STRENGTH = 0.08;

// ─────────────────────────────────────────────────────────────────────────────
// Per-joint PD — mannequin recovery
// ─────────────────────────────────────────────────────────────────────────────
//
// Each joint runs a PD controller that pulls the child body toward a
// rest-relative orientation against its parent body. Tune live with the
// `,` / `.` keys (scales all joints via motors.globalMultiplier).
//
// Scale note: this is a dollhouse-sized model — limb half-extents ~0.05-
// 0.1 m, moments of inertia ~0.001-0.01 kg·m². KP is in units of N·m per
// radian of error, so values that look "small" produce real torques here.
// At KP=10 a 0.005 kg·m² thigh sees ~2000 rad/s² per rad of error → one
// 1/60 substep would launch it at ~33 rad/s. Keep KP ≤ ~1.5 on the most
// inertia-rich joint (the hip), proportionally less elsewhere.
//
// Motors start DISABLED — toggle with `M` once you've tuned. Wakes up
// passive ragdoll for an A/B baseline. If a limb still explodes with
// motors enabled, double the matching KD before raising KP.

export const SHOULDER_KP = 0.4;
export const SHOULDER_KD = 0.08;

export const ELBOW_KP = 0.3;
export const ELBOW_KD = 0.06;

export const HIP_KP = 0.6;
export const HIP_KD = 0.12;

export const KNEE_KP = 0.3;
export const KNEE_KD = 0.06;

export const NECK_KP = 0.15;
export const NECK_KD = 0.03;
