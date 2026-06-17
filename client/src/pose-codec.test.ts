import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  POSE_BYTES,
  POSE_FLOATS,
  encodePoseBytes,
  decodePose,
} from './pose-codec.ts';

// Random-but-deterministic generator. Avoid Math.random so failures reproduce.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitQuat(rand: () => number): [number, number, number, number] {
  // Marsaglia's quaternion sampling — uniform on the 3-sphere.
  let x1 = 0, y1 = 0, s1 = 2;
  while (s1 >= 1) { x1 = 2 * rand() - 1; y1 = 2 * rand() - 1; s1 = x1 * x1 + y1 * y1; }
  let x2 = 0, y2 = 0, s2 = 2;
  while (s2 >= 1) { x2 = 2 * rand() - 1; y2 = 2 * rand() - 1; s2 = x2 * x2 + y2 * y2; }
  const k = Math.sqrt((1 - s1) / s2);
  return [x1, y1, x2 * k, y2 * k];
}

// Quaternion angular distance in radians (handles q vs -q ambiguity).
function quatAngleError(
  qa: [number, number, number, number],
  qb: [number, number, number, number],
): number {
  const dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  const absDot = Math.min(1, Math.abs(dot));
  return 2 * Math.acos(absDot);
}

function buildPose(rand: () => number): {
  pose: Float32Array;
  speed: number;
  vel: Float32Array;
  grap: Float32Array;
} {
  const pose = new Float32Array(POSE_FLOATS);
  // Torso somewhere inside the world (~±30 m on each axis).
  const rx = (rand() - 0.5) * 60;
  const ry = (rand() - 0.5) * 60;
  const rz = (rand() - 0.5) * 60;
  pose[0] = rx; pose[1] = ry; pose[2] = rz;
  const tq = randomUnitQuat(rand);
  pose[3] = tq[0]; pose[4] = tq[1]; pose[5] = tq[2]; pose[6] = tq[3];

  for (let i = 1; i < 10; i++) {
    const po = i * 7;
    // Limbs within ~1.5 m of the torso — well inside the ±2 m quant range.
    pose[po + 0] = rx + (rand() - 0.5) * 3;
    pose[po + 1] = ry + (rand() - 0.5) * 3;
    pose[po + 2] = rz + (rand() - 0.5) * 3;
    const q = randomUnitQuat(rand);
    pose[po + 3] = q[0];
    pose[po + 4] = q[1];
    pose[po + 5] = q[2];
    pose[po + 6] = q[3];
  }

  const speed = rand() * 40;
  const vel = new Float32Array([
    (rand() - 0.5) * 60,
    (rand() - 0.5) * 60,
    (rand() - 0.5) * 60,
  ]);
  const grap = new Float32Array([
    rand() < 0.5 ? 1 : 0,
    (rand() - 0.5) * 80,
    (rand() - 0.5) * 80,
    (rand() - 0.5) * 80,
  ]);
  return { pose, speed, vel, grap };
}

describe('pose-codec', () => {
  it('writes exactly POSE_BYTES bytes', () => {
    const { pose, speed, vel, grap } = buildPose(mulberry32(1));
    const buf = encodePoseBytes(pose, speed, vel, grap);
    assert.equal(buf.byteLength, POSE_BYTES);
  });

  it('round-trips position within 1 mm and rotation within 0.1° over many samples', () => {
    const rand = mulberry32(42);
    // PLAN's documented precision bounds — checked against the tightest
    // observed error so a regression below this floor is flagged as well.
    const POS_TOL_M = 0.001;          // 1 mm
    const ROT_TOL_RAD = 0.1 * Math.PI / 180; // 0.1°
    let maxPosErr = 0;
    let maxRotErr = 0;
    const samples = 2000;
    for (let trial = 0; trial < samples; trial++) {
      const { pose, speed, vel, grap } = buildPose(rand);
      const buf = encodePoseBytes(pose, speed, vel, grap);
      const decoded = decodePose(buf);

      for (let i = 0; i < 10; i++) {
        const o = i * 7;
        const dx = decoded.pose[o + 0] - pose[o + 0];
        const dy = decoded.pose[o + 1] - pose[o + 1];
        const dz = decoded.pose[o + 2] - pose[o + 2];
        const posErr = Math.hypot(dx, dy, dz);
        if (posErr > maxPosErr) maxPosErr = posErr;

        const qa: [number, number, number, number] = [pose[o + 3], pose[o + 4], pose[o + 5], pose[o + 6]];
        const qb: [number, number, number, number] = [decoded.pose[o + 3], decoded.pose[o + 4], decoded.pose[o + 5], decoded.pose[o + 6]];
        const rotErr = quatAngleError(qa, qb);
        if (rotErr > maxRotErr) maxRotErr = rotErr;
      }

      // Scalars: speed precision = 100/65535 ≈ 1.5 mm/s; vel = 100/32767 ≈ 3 mm/s.
      assert.ok(Math.abs(decoded.speed - speed) < 0.01, `speed err ${decoded.speed - speed}`);
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(decoded.vel[i] - vel[i]) < 0.01, `vel[${i}] err ${decoded.vel[i] - vel[i]}`);
      }
      // grap[0] is a boolean active flag — must round-trip exactly.
      assert.equal(decoded.grap[0], grap[0]);
      // grap[1..3] are float32 anchor coords — exact round-trip.
      for (let i = 1; i < 4; i++) {
        assert.equal(decoded.grap[i], grap[i]);
      }
    }
    assert.ok(maxPosErr < POS_TOL_M, `max position error ${maxPosErr * 1000} mm exceeds 1 mm bound`);
    assert.ok(maxRotErr < ROT_TOL_RAD, `max rotation error ${maxRotErr * 180 / Math.PI}° exceeds 0.1° bound`);
  });

  it('encodes a known identity pose to a decodable buffer', () => {
    const pose = new Float32Array(POSE_FLOATS);
    for (let i = 0; i < 10; i++) {
      const o = i * 7;
      pose[o + 6] = 1; // identity quat (w=1)
    }
    const buf = encodePoseBytes(pose, 0, new Float32Array(3), new Float32Array(4));
    const decoded = decodePose(buf);
    assert.equal(decoded.speed, 0);
    for (let i = 0; i < 10; i++) {
      const o = i * 7;
      // Identity quat: |w|=1 is the largest, so smallest-three drops w. The
      // other three components decode as ~0; w reconstructs as +1.
      assert.ok(Math.abs(decoded.pose[o + 3]) < 1e-3);
      assert.ok(Math.abs(decoded.pose[o + 4]) < 1e-3);
      assert.ok(Math.abs(decoded.pose[o + 5]) < 1e-3);
      assert.ok(Math.abs(decoded.pose[o + 6] - 1) < 1e-3);
    }
  });

  it('round-trips a negative-w quaternion (sign-flip path)', () => {
    // Build a quat with w < 0 — encoder must flip sign so dropped component
    // is non-negative.
    const pose = new Float32Array(POSE_FLOATS);
    const q: [number, number, number, number] = [0.1, 0.2, 0.3, -0.927];
    const norm = Math.hypot(q[0], q[1], q[2], q[3]);
    for (let i = 0; i < 4; i++) q[i] /= norm;
    for (let i = 0; i < 10; i++) {
      const o = i * 7;
      pose[o + 3] = q[0]; pose[o + 4] = q[1]; pose[o + 5] = q[2]; pose[o + 6] = q[3];
    }
    const buf = encodePoseBytes(pose, 0, new Float32Array(3), new Float32Array(4));
    const decoded = decodePose(buf);
    for (let i = 0; i < 10; i++) {
      const o = i * 7;
      const qa: [number, number, number, number] = [q[0], q[1], q[2], q[3]];
      const qb: [number, number, number, number] = [decoded.pose[o + 3], decoded.pose[o + 4], decoded.pose[o + 5], decoded.pose[o + 6]];
      assert.ok(quatAngleError(qa, qb) < 0.1 * Math.PI / 180);
    }
  });
});
