import * as THREE from 'three';

// Grapple rope visual config. Tuned together: glow rides the global bloom pass
// in main.ts (threshold 0.95), so GRAPPLE_GLOW must keep the brightest channel
// of the color above ~0.95 for the halo to appear.
export const GRAPPLE_COLOR_HEX = 0xffffff;
export const GRAPPLE_GLOW = 1.0;
export const GRAPPLE_LINE_WIDTH = 0.02; // world units → tapers with distance

export const GRAPPLE_COLOR = new THREE.Color(GRAPPLE_COLOR_HEX).multiplyScalar(GRAPPLE_GLOW);

export const MOVE_IMPULSE = 0.8;   // impulse per physics substep (N·s)
export const MOVE_MAX_SPEED = 8.0; // horizontal speed cap (m/s)
