import RAPIER from '@dimforge/rapier3d-compat';

// Pose wire format: a 56-float array [pos.xyz, quat.xyzw] × 8 in
// POSE_PART_ORDER. Grapple state ships separately as [active(0|1), ax, ay, az].
// 56 floats × 4 B = 224 B per pose; at 20 Hz that's ~4.5 KB/s per player.

export const POSE_FLOATS = 56;

export interface PoseMessage {
  pose: number[]; // length === POSE_FLOATS
  grap: number[]; // length === 4 — [active, ax, ay, az]
}

export function encodePose(
  bodies: RAPIER.RigidBody[],
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
  const grap: number[] = grappleActive && grappleAnchor
    ? [1, grappleAnchor.x, grappleAnchor.y, grappleAnchor.z]
    : [0, 0, 0, 0];
  return { pose, grap };
}
