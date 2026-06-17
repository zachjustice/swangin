import type RAPIER from '@dimforge/rapier3d-compat';

// Binary pose codec. PLAN.md calls for smallest-three quaternion encoding and
// root-relative int16 positions to fit the per-tick payload into a few
// hundred bytes of raw `ArrayBuffer` (vs ~700 B of JSON-ish floats per tick).
//
// In-memory pose format (kept across encode/decode for compat with the lerp /
// applyPose plumbing): a 70-float array — for each of 10 parts in
// POSE_PART_ORDER, 7 floats (pos.xyz, quat.xyzw).
//
// Wire layout, all little-endian, fixed width = POSE_BYTES (172):
//
//   off   size  field
//   0     4     tSendMs            (uint32, sender's performance.now() ms, mod 2^32)
//   4     12    torso pos          (3 × float32, world coords)
//   16    54    9 × limb pos       (3 × int16,  root-relative, ±POS_RANGE m)
//   70    80    10 × quat          (smallest-three, 8 B each: 3×int16 + 1×u8 idx + 1 pad)
//   150   2     speed              (uint16, scaled 0..SPEED_RANGE m/s)
//   152   6     vel                (3 × int16, ±VEL_RANGE m/s)
//   158   1     grap active        (uint8, 0 or 1)
//   159   1     —                  (padding to align anchor on a 4-B boundary)
//   160   12    grap anchor        (3 × float32, world coords)
//   172   —     end
//
// tSendMs lets the receiver interpolate against the sender's clock instead of
// arrival time, so network jitter doesn't translate into peer jitter. uint32
// rolls over at 49.7 days of page-uptime — receivers handle wrap by unwrapping
// against the previous sample's tSendMs.
//
// At 20 Hz this is ~3.4 KB/s/player — a ~4× reduction from the previous
// JSON-ish encoding and well within PLAN's bandwidth budget. The remaining
// floor is the 10× 14-byte per-part minimum (8 quat + 6 pos) that the
// documented format itself requires.
//
// Precision: per the round-trip test in pose-codec.test.ts, max rotation
// error stays under 0.05° and max position error under 0.1 mm anywhere in
// the legal limb radius — comfortably below PLAN's 0.1° / 1 mm bound.

export const POSE_FLOATS = 70;
export const POSE_BYTES = 172;

// Limb position quantization range. Limbs are at most ~1 m from the torso
// even at full extension; pick ±2 m so we never clip on transient solver
// blow-ups while keeping the per-component step at 2/32767 ≈ 61 μm.
const POS_RANGE = 2.0;
const POS_SCALE = 32767 / POS_RANGE;

// Velocity / speed ranges. MAX_RAGDOLL_BODY_SPEED caps body speed at 30 m/s,
// so ±100 m/s covers transient impulse spikes with plenty of headroom.
const VEL_RANGE = 100.0;
const VEL_SCALE = 32767 / VEL_RANGE;
const SPEED_RANGE = 100.0;
const SPEED_SCALE = 65535 / SPEED_RANGE;

// Quaternion smallest-three. After sign-flipping so the dropped component is
// non-negative, the remaining three components lie in [-1/√2, 1/√2]. Scale to
// int16 range — step ≈ 2 / 32767 ≈ 4.3e-5 → rotation error ≈ 0.0025°.
const QUAT_SCALE = 32767 * Math.SQRT2;

// Per-part offsets into the in-memory 70-float pose array. Matches the
// pos.xyz + quat.xyzw stride POSE_PART_ORDER consumers expect.
const PART_STRIDE = 7;

const T_SEND_OFFSET = 0;
const POS_BYTES_OFFSET = 4;
const QUAT_BYTES_OFFSET = POS_BYTES_OFFSET + 12 + 9 * 6; // 70
const SPEED_OFFSET = QUAT_BYTES_OFFSET + 10 * 8; // 150
const VEL_OFFSET = SPEED_OFFSET + 2; // 152
const GRAP_ACTIVE_OFFSET = VEL_OFFSET + 6; // 158
const GRAP_ANCHOR_OFFSET = GRAP_ACTIVE_OFFSET + 2; // 160 (1 B pad)

export interface DecodedPose {
  pose: Float32Array;  // POSE_FLOATS floats — pos.xyz, quat.xyzw per part
  speed: number;
  vel: Float32Array;   // 3 floats — torso linvel xyz, m/s
  grap: Float32Array;  // 4 floats — [active, ax, ay, az]
  tSendMs: number;     // sender's performance.now() at encode, ms (uint32)
}

interface Vec3Like { x: number; y: number; z: number }

function clampInt16(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32767) return -32767;
  return v;
}

function clampUint16(v: number): number {
  if (v > 65535) return 65535;
  if (v < 0) return 0;
  return v;
}

// Write a quaternion at `offset` using smallest-three. Returns nothing; bytes
// land in `view`. The whole quaternion is sign-flipped if needed so the
// dropped component is non-negative — q and -q represent the same rotation.
function writeQuat(
  view: DataView, offset: number,
  x: number, y: number, z: number, w: number,
): void {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const aw = Math.abs(w);
  let idx = 0;
  let maxA = ax;
  if (ay > maxA) { maxA = ay; idx = 1; }
  if (az > maxA) { maxA = az; idx = 2; }
  if (aw > maxA) { idx = 3; }

  const dropped = idx === 0 ? x : idx === 1 ? y : idx === 2 ? z : w;
  const sign = dropped < 0 ? -1 : 1;

  let a, b, c;
  if (idx === 0)      { a = y; b = z; c = w; }
  else if (idx === 1) { a = x; b = z; c = w; }
  else if (idx === 2) { a = x; b = y; c = w; }
  else                { a = x; b = y; c = z; }

  view.setInt16(offset + 0, clampInt16(Math.round(a * sign * QUAT_SCALE)), true);
  view.setInt16(offset + 2, clampInt16(Math.round(b * sign * QUAT_SCALE)), true);
  view.setInt16(offset + 4, clampInt16(Math.round(c * sign * QUAT_SCALE)), true);
  view.setUint8(offset + 6, idx);
  view.setUint8(offset + 7, 0);
}

function readQuat(view: DataView, offset: number, out: Float32Array, outOffset: number): void {
  const a = view.getInt16(offset + 0, true) / QUAT_SCALE;
  const b = view.getInt16(offset + 2, true) / QUAT_SCALE;
  const c = view.getInt16(offset + 4, true) / QUAT_SCALE;
  const idx = view.getUint8(offset + 6);
  const sumSq = a * a + b * b + c * c;
  // Clamp under 1 to keep sqrt real even when the int16 round-trip puts the
  // smallest-three components a hair above the unit circle.
  const d = Math.sqrt(Math.max(0, 1 - sumSq));
  if (idx === 0)      { out[outOffset + 0] = d; out[outOffset + 1] = a; out[outOffset + 2] = b; out[outOffset + 3] = c; }
  else if (idx === 1) { out[outOffset + 0] = a; out[outOffset + 1] = d; out[outOffset + 2] = b; out[outOffset + 3] = c; }
  else if (idx === 2) { out[outOffset + 0] = a; out[outOffset + 1] = b; out[outOffset + 2] = d; out[outOffset + 3] = c; }
  else                { out[outOffset + 0] = a; out[outOffset + 1] = b; out[outOffset + 2] = c; out[outOffset + 3] = d; }
}

// Pure encoder from in-memory pose arrays. Used by encodePose() and by the
// unit test directly (which can build pose arrays without a RAPIER world).
export function encodePoseBytes(
  pose: ArrayLike<number>,    // POSE_FLOATS floats
  speed: number,
  vel: ArrayLike<number>,     // 3 floats
  grap: ArrayLike<number>,    // 4 floats
  tSendMs: number = 0,        // sender's performance.now() in ms
): ArrayBuffer {
  const buf = new ArrayBuffer(POSE_BYTES);
  const view = new DataView(buf);

  view.setUint32(T_SEND_OFFSET, (tSendMs >>> 0), true);

  // Torso pos (root) — float32 absolute world coords.
  const rx = pose[0];
  const ry = pose[1];
  const rz = pose[2];
  view.setFloat32(POS_BYTES_OFFSET + 0, rx, true);
  view.setFloat32(POS_BYTES_OFFSET + 4, ry, true);
  view.setFloat32(POS_BYTES_OFFSET + 8, rz, true);

  // Limb positions — int16 root-relative.
  for (let i = 1; i < 10; i++) {
    const po = i * PART_STRIDE;
    const limbOffset = POS_BYTES_OFFSET + 12 + (i - 1) * 6;
    view.setInt16(limbOffset + 0, clampInt16(Math.round((pose[po + 0] - rx) * POS_SCALE)), true);
    view.setInt16(limbOffset + 2, clampInt16(Math.round((pose[po + 1] - ry) * POS_SCALE)), true);
    view.setInt16(limbOffset + 4, clampInt16(Math.round((pose[po + 2] - rz) * POS_SCALE)), true);
  }

  // Quats — smallest-three for every part including torso.
  for (let i = 0; i < 10; i++) {
    const po = i * PART_STRIDE;
    writeQuat(
      view, QUAT_BYTES_OFFSET + i * 8,
      pose[po + 3], pose[po + 4], pose[po + 5], pose[po + 6],
    );
  }

  view.setUint16(SPEED_OFFSET, clampUint16(Math.round(speed * SPEED_SCALE)), true);

  view.setInt16(VEL_OFFSET + 0, clampInt16(Math.round(vel[0] * VEL_SCALE)), true);
  view.setInt16(VEL_OFFSET + 2, clampInt16(Math.round(vel[1] * VEL_SCALE)), true);
  view.setInt16(VEL_OFFSET + 4, clampInt16(Math.round(vel[2] * VEL_SCALE)), true);

  view.setUint8(GRAP_ACTIVE_OFFSET, grap[0] > 0.5 ? 1 : 0);
  view.setUint8(GRAP_ACTIVE_OFFSET + 1, 0);
  view.setFloat32(GRAP_ANCHOR_OFFSET + 0, grap[1] ?? 0, true);
  view.setFloat32(GRAP_ANCHOR_OFFSET + 4, grap[2] ?? 0, true);
  view.setFloat32(GRAP_ANCHOR_OFFSET + 8, grap[3] ?? 0, true);

  return buf;
}

// Per-tick encoder called from main.ts each network send. Reads RAPIER body
// transforms directly into the binary buffer — no intermediate pose array.
export function encodePose(
  bodies: RAPIER.RigidBody[],
  smoothedSpeed: number,
  torsoLinvel: Vec3Like,
  grappleActive: boolean,
  grappleAnchor: Vec3Like | null,
  tSendMs: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(POSE_BYTES);
  const view = new DataView(buf);

  view.setUint32(T_SEND_OFFSET, (tSendMs >>> 0), true);

  const root = bodies[0].translation();
  const rx = root.x, ry = root.y, rz = root.z;
  view.setFloat32(POS_BYTES_OFFSET + 0, rx, true);
  view.setFloat32(POS_BYTES_OFFSET + 4, ry, true);
  view.setFloat32(POS_BYTES_OFFSET + 8, rz, true);

  const rootRot = bodies[0].rotation();
  writeQuat(view, QUAT_BYTES_OFFSET, rootRot.x, rootRot.y, rootRot.z, rootRot.w);

  for (let i = 1; i < 10; i++) {
    const t = bodies[i].translation();
    const limbOffset = POS_BYTES_OFFSET + 12 + (i - 1) * 6;
    view.setInt16(limbOffset + 0, clampInt16(Math.round((t.x - rx) * POS_SCALE)), true);
    view.setInt16(limbOffset + 2, clampInt16(Math.round((t.y - ry) * POS_SCALE)), true);
    view.setInt16(limbOffset + 4, clampInt16(Math.round((t.z - rz) * POS_SCALE)), true);
    const r = bodies[i].rotation();
    writeQuat(view, QUAT_BYTES_OFFSET + i * 8, r.x, r.y, r.z, r.w);
  }

  view.setUint16(SPEED_OFFSET, clampUint16(Math.round(smoothedSpeed * SPEED_SCALE)), true);
  view.setInt16(VEL_OFFSET + 0, clampInt16(Math.round(torsoLinvel.x * VEL_SCALE)), true);
  view.setInt16(VEL_OFFSET + 2, clampInt16(Math.round(torsoLinvel.y * VEL_SCALE)), true);
  view.setInt16(VEL_OFFSET + 4, clampInt16(Math.round(torsoLinvel.z * VEL_SCALE)), true);

  view.setUint8(GRAP_ACTIVE_OFFSET, grappleActive && grappleAnchor ? 1 : 0);
  view.setUint8(GRAP_ACTIVE_OFFSET + 1, 0);
  view.setFloat32(GRAP_ANCHOR_OFFSET + 0, grappleAnchor ? grappleAnchor.x : 0, true);
  view.setFloat32(GRAP_ANCHOR_OFFSET + 4, grappleAnchor ? grappleAnchor.y : 0, true);
  view.setFloat32(GRAP_ANCHOR_OFFSET + 8, grappleAnchor ? grappleAnchor.z : 0, true);

  return buf;
}

export function decodePose(buf: ArrayBuffer | Uint8Array): DecodedPose {
  const view = buf instanceof Uint8Array
    ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    : new DataView(buf);

  const tSendMs = view.getUint32(T_SEND_OFFSET, true);

  const pose = new Float32Array(POSE_FLOATS);

  const rx = view.getFloat32(POS_BYTES_OFFSET + 0, true);
  const ry = view.getFloat32(POS_BYTES_OFFSET + 4, true);
  const rz = view.getFloat32(POS_BYTES_OFFSET + 8, true);
  pose[0] = rx;
  pose[1] = ry;
  pose[2] = rz;
  readQuat(view, QUAT_BYTES_OFFSET, pose, 3);

  for (let i = 1; i < 10; i++) {
    const po = i * PART_STRIDE;
    const limbOffset = POS_BYTES_OFFSET + 12 + (i - 1) * 6;
    pose[po + 0] = rx + view.getInt16(limbOffset + 0, true) / POS_SCALE;
    pose[po + 1] = ry + view.getInt16(limbOffset + 2, true) / POS_SCALE;
    pose[po + 2] = rz + view.getInt16(limbOffset + 4, true) / POS_SCALE;
    readQuat(view, QUAT_BYTES_OFFSET + i * 8, pose, po + 3);
  }

  const speed = view.getUint16(SPEED_OFFSET, true) / SPEED_SCALE;

  const vel = new Float32Array(3);
  vel[0] = view.getInt16(VEL_OFFSET + 0, true) / VEL_SCALE;
  vel[1] = view.getInt16(VEL_OFFSET + 2, true) / VEL_SCALE;
  vel[2] = view.getInt16(VEL_OFFSET + 4, true) / VEL_SCALE;

  const grap = new Float32Array(4);
  grap[0] = view.getUint8(GRAP_ACTIVE_OFFSET);
  grap[1] = view.getFloat32(GRAP_ANCHOR_OFFSET + 0, true);
  grap[2] = view.getFloat32(GRAP_ANCHOR_OFFSET + 4, true);
  grap[3] = view.getFloat32(GRAP_ANCHOR_OFFSET + 8, true);

  return { pose, speed, vel, grap, tSendMs };
}
