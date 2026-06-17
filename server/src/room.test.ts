import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TokenBucket } from './token-bucket.ts';
import { isPoseValid } from './room.ts';

// ─── TokenBucket ────────────────────────────────────────────────────────────

describe('TokenBucket', () => {
  it('allows up to cap requests immediately on a fresh bucket', () => {
    const bucket = new TokenBucket(3, 30);
    assert.equal(bucket.allow(), true);
    assert.equal(bucket.allow(), true);
    assert.equal(bucket.allow(), true);
    assert.equal(bucket.allow(), false); // cap exhausted
  });

  it('refills over time and allows again', async () => {
    const bucket = new TokenBucket(1, 100); // 100 Hz → 1 token per 10 ms
    assert.equal(bucket.allow(), true);
    assert.equal(bucket.allow(), false);
    await new Promise(r => setTimeout(r, 20)); // wait 2 refill intervals
    assert.equal(bucket.allow(), true);
  });

  it('does not exceed cap on refill', async () => {
    const bucket = new TokenBucket(2, 100);
    // drain
    bucket.allow(); bucket.allow();
    // wait long enough to overfill if cap weren't enforced
    await new Promise(r => setTimeout(r, 100));
    assert.equal(bucket.allow(), true);
    assert.equal(bucket.allow(), true);
    assert.equal(bucket.allow(), false); // still capped at 2
  });

  it('30 Hz cap passes a 20 Hz burst without dropping', async () => {
    // Simulate 30 messages at 20 Hz (1 per 50 ms) — all should pass.
    const bucket = new TokenBucket(30, 30);
    for (let i = 0; i < 30; i++) {
      assert.equal(bucket.allow(), true, `message ${i} should pass`);
      await new Promise(r => setTimeout(r, 50)); // 20 Hz spacing
    }
  });

  it('drops excess at 60 Hz (above cap)', () => {
    // Fire 60 messages with no time passing — only `cap` should pass.
    const cap = 30;
    const bucket = new TokenBucket(cap, 30);
    let passed = 0;
    for (let i = 0; i < 60; i++) {
      if (bucket.allow()) passed++;
    }
    assert.equal(passed, cap);
  });
});

// ─── isPoseValid ─────────────────────────────────────────────────────────────

// Build a valid POSE_BYTES (172) payload filled with finite floats.
function validPoseBytes(): Uint8Array {
  const buf = new Uint8Array(172);
  const view = new DataView(buf.buffer);
  // Torso pos at offset 4 (3 × float32)
  view.setFloat32(4,  1.0, true);
  view.setFloat32(8,  2.0, true);
  view.setFloat32(12, 3.0, true);
  // Grapple anchor at offset 160 (3 × float32)
  view.setFloat32(160, 10.0, true);
  view.setFloat32(164, 20.0, true);
  view.setFloat32(168, 30.0, true);
  return buf;
}

describe('isPoseValid', () => {
  it('accepts a well-formed payload', () => {
    assert.equal(isPoseValid(validPoseBytes()), true);
  });

  it('rejects NaN in torso x', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(4, NaN, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('rejects NaN in torso y', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(8, NaN, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('rejects NaN in torso z', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(12, NaN, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('rejects +Infinity in torso pos', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(4, Infinity, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('rejects -Infinity in torso pos', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(8, -Infinity, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('rejects NaN in grapple anchor x', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(160, NaN, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('rejects NaN in grapple anchor y', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(164, NaN, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('rejects NaN in grapple anchor z', () => {
    const buf = validPoseBytes();
    new DataView(buf.buffer).setFloat32(168, NaN, true);
    assert.equal(isPoseValid(buf), false);
  });

  it('accepts zeroed anchor (grapple inactive)', () => {
    const buf = validPoseBytes();
    const view = new DataView(buf.buffer);
    view.setFloat32(160, 0, true);
    view.setFloat32(164, 0, true);
    view.setFloat32(168, 0, true);
    assert.equal(isPoseValid(buf), true);
  });
});
