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
 * Angular damping applied to every ragdoll rigid body. Lower lets limbs
 * keep their swing energy longer (Gang-Beasts-y); higher kills oscillation
 * after impulses.
 * mattvb91 leaves this at Rapier's default. 0.2 here is light enough to
 * preserve floppy feel and high enough to suppress numerical jitter.
 * Range: 0 (free spin) → 1.5 (sluggish).
 * Default: 0.2.
 */
export const BODY_ANGULAR_DAMPING = 0.2;

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
