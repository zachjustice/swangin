import RAPIER from '@dimforge/rapier3d-compat';

// Pose wire format: a 70-float array [pos.xyz, quat.xyzw] × 10 in
// POSE_PART_ORDER. Plus the torso's smoothed speed scalar (collision-rule
// gate) and full linvel vector (knockback direction), and grapple state.
//
// Per-tick payload at 20 Hz:
//   70 + 1 + 3 + 4 = 78 floats × 4 B = 312 B  →  ~6.2 KB/s per player.

export const POSE_FLOATS = 70;

export interface PoseMessage {
  pose: number[];  // length === POSE_FLOATS
  speed: number;   // smoothed |torso linvel|, m/s
  vel: number[];   // length 3 — torso linvel xyz, m/s
  grap: number[];  // length 4 — [active, ax, ay, az]
}

export function encodePose(
  bodies: RAPIER.RigidBody[],
  smoothedSpeed: number,
  torsoLinvel: { x: number; y: number; z: number },
  grappleActive: boolean,
  grappleAnchor: { x: number; y: number; z: number } | null,
): PoseMessage {
  const pose = new Array<number>(POSE_FLOATS);
  for (let i = 0; i < bodies.length; i++) {
    const t = bodies[i].translation();
    const r = bodies[i].rotation();
    const o = i * 7;
    pose[o + 0] = t.x;
    pose[o + 1] = t.y;
    pose[o + 2] = t.z;
    pose[o + 3] = r.x;
    pose[o + 4] = r.y;
    pose[o + 5] = r.z;
    pose[o + 6] = r.w;
  }
  const vel = [torsoLinvel.x, torsoLinvel.y, torsoLinvel.z];
  const grap: number[] = grappleActive && grappleAnchor
    ? [1, grappleAnchor.x, grappleAnchor.y, grappleAnchor.z]
    : [0, 0, 0, 0];
  return { pose, speed: smoothedSpeed, vel, grap };
}
