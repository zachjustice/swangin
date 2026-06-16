import * as THREE from 'three';
import type { PosePart } from './ragdoll-proportions.ts';

// Grapple rope visual config. Tuned together: glow rides the global bloom pass
// in main.ts (threshold 0.95), so GRAPPLE_GLOW must keep the brightest channel
// of the color above ~0.95 for the halo to appear.
export const GRAPPLE_COLOR_HEX = 0xffffff;
export const GRAPPLE_GLOW = 1.0;
export const GRAPPLE_LINE_WIDTH = 0.02; // world units → tapers with distance

export const GRAPPLE_COLOR = new THREE.Color(GRAPPLE_COLOR_HEX).multiplyScalar(GRAPPLE_GLOW);

export const MOVE_IMPULSE = 1.5;   // impulse per physics substep (N·s)
export const MOVE_MAX_SPEED = 15.0; // horizontal speed cap (m/s)

// --- Player–player collision ---
// On contact between a local-ragdoll part and a remote-ragdoll part, the
// victim-side rule is: I die only if max(self, peer) >= THRESHOLD AND
// peer - self > TIE_EPSILON. Symmetric / unclear cases resolve to "nobody
// dies" by design — see /Users/zach/.claude/plans/create-an-implementation-plan-dazzling-key.md
// for the rationale (network staleness on peer speed makes a strict
// slower-dies rule produce both-die or nobody-die on symmetric crashes).
export const COLLISION_SPEED_THRESHOLD = 10.0; // m/s, torso |linvel|
export const COLLISION_TIE_EPSILON = 0.5;  // m/s
// EMA on torso |linvel| each physics substep. α = 0.2 over 60 Hz substeps
// gives a ~80 ms effective window — enough to swallow joint-impulse jitter,
// short enough that a real grapple release reads as fast within a few frames.
export const COLLISION_SPEED_EMA_ALPHA = 0.2;
export const TUMBLE_DURATION_S = 3.0;
export const SPAWN_PROTECT_DURATION_S = 1.5;
// Knockback impulse applied to the local torso on cross-player contact:
// magnitude = closingSpeed × KNOCKBACK_GAIN × localTorsoMass. Each client
// applies this to its OWN body — the streamed pose carries the reaction to
// the peer, so no synthetic offset is needed on the remote side.
export const KNOCKBACK_GAIN = 1.4;
// Local debounce: ignore re-fires from the same peer within this window.
export const LOCAL_PEER_COOLDOWN_MS = 500;
// Mirror of the server's dedup window in server/src/room.ts (SERVER_DEDUP_MS).
// Kept in sync by hand — single literal isn't worth a shared package for v0.
export const SERVER_DEDUP_MS_REF = 750;

// Confetti burst — InstancedMesh, JS-integrated, despawn after lifetime.
export const CONFETTI_COUNT = 120;
export const CONFETTI_LIFETIME_S = 1.8;
export const CONFETTI_GRAVITY = -15.0; // m/s²
export const CONFETTI_DRAG = 1.6;   // exponential damping factor / s
export const CONFETTI_INIT_SPEED_MIN = 4.0;   // m/s outward
export const CONFETTI_INIT_SPEED_MAX = 10.0;

// --- Speed-trail visual ("air lines") ---
// Pale-white polylines streaming from limb extremities when the body moves
// fast enough to be lethal. Pure visual — no gameplay impact, no network.
// Lower bound is anchored to the kill threshold so the visual cue precisely
// signals "I can kill / be killed". Above SPEED_TRAIL_MAX the trail saturates.
export const SPEED_TRAIL_START = COLLISION_SPEED_THRESHOLD;
export const SPEED_TRAIL_MAX = 25.0;  // m/s
export const SPEED_TRAIL_MIN_WIDTH = 0.012; // meters (worldUnits)
export const SPEED_TRAIL_MAX_WIDTH = 0.035;
export const SPEED_TRAIL_MIN_OPACITY = 0.10;
export const SPEED_TRAIL_MAX_OPACITY = 0.45;
// Fixed sample cadence so trail length-in-time is identical at 60 / 144 Hz.
export const TRAIL_SAMPLE_INTERVAL_S = 0.020;
export const TRAIL_SAMPLES = 14;    // ~280 ms of history
// If an anchor moves more than this between samples (respawn, etc.), reset
// its ring buffer so we don't stretch a line across the world.
export const TRAIL_TELEPORT_MAX_M = 4.0;
export const TRAIL_ANCHOR_PARTS: ReadonlyArray<PosePart> =
    ['head', 'armLowerL', 'armLowerR', 'legL_shin', 'legR_shin'];
