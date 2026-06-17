import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import * as Colyseus from 'colyseus.js';
import { getStateCallbacks } from 'colyseus.js';
import { createRemoteRagdoll, RemoteRagdoll } from './remote-ragdoll.ts';
import { POSE_PART_ORDER } from './ragdoll-proportions.ts';
import { POSE_BYTES, POSE_FLOATS, decodePose } from './pose-codec.ts';
import { clearPeerCooldown, type PeerSpeedInfo } from './collision.ts';
import type { Confetti } from './confetti.ts';

// Identity + score. Pose ships via room messages so we can timestamp +
// interpolate. The `kills` field is the only piece of authoritative
// game-state today — server credits it on a `died` message.
interface PlayerState {
  userId: string;
  name: string;
  color: number;
  kills: number;
}

interface RoomState {
  startedAt: number;
  players: Map<string, PlayerState>;
}

interface PoseEnvelope {
  pose: Float32Array;  // decoded length-POSE_FLOATS pose
  speed: number;
  vel: Float32Array;
  grap: Float32Array;
  s: string; // sender sessionId
  t: number; // arrival time (set on receipt)
}

const textDecoder = new TextDecoder();

interface ConfettiBroadcast {
  victimSession: string;
  killerSession: string;
  color: number;
  x: number;
  y: number;
  z: number;
}

// ~100ms playback delay per PLAN.md — give the buffer 2 samples to lerp between
// even with one missed packet. 20Hz send cadence = ~50ms between samples.
const INTERP_DELAY_MS = 100;
const BUFFER_MAX = 12; // 600ms — enough headroom for short stalls.
// How long to keep pending pose envelopes for a sessionId that never gets an
// onAdd (e.g. a message for a peer that already left). Keeps the map bounded.
const PENDING_TTL_MS = 5000;
// Time after a peer confetti broadcast to keep their mesh hidden. The next
// pose tick from the respawned peer naturally re-shows it; this is a safety
// net in case that tick is delayed.
const REMOTE_MESH_HIDE_FALLBACK_MS = 2000;

export interface Peer extends PeerSpeedInfo {
  state: PlayerState;
  ragdoll: RemoteRagdoll;
  torso: RAPIER.RigidBody;
  buffer: PoseEnvelope[];
  // `setKillCount` proxy so collision code never reaches into the schema —
  // the Multiplayer instance bridges Colyseus diffs to ragdoll setters.
}

export interface MultiplayerOptions {
  scene: THREE.Scene;
  world: RAPIER.World;
  spawnHint: THREE.Vector3;
  channelId: string;
  userId: string;
  name: string;
  color: number;
  confetti: Confetti;
  // Local ragdoll handle — needed so we can bridge the local player's
  // `kills` schema diff to the local kill-counter sprite.
  localRagdoll: { setKillCount(n: number): void };
}

const tmpQA = new THREE.Quaternion();
const tmpQB = new THREE.Quaternion();

// Lerp two pose envelopes at alpha ∈ [0,1] into `out` (length POSE_FLOATS).
// Positions linearly, quaternions slerped (with shortest-path flip).
function lerpPose(a: PoseEnvelope, b: PoseEnvelope, alpha: number, out: Float32Array): void {
  const ap = a.pose, bp = b.pose;
  for (let i = 0; i < POSE_PART_ORDER.length; i++) {
    const o = i * 7;
    out[o + 0] = ap[o + 0] + (bp[o + 0] - ap[o + 0]) * alpha;
    out[o + 1] = ap[o + 1] + (bp[o + 1] - ap[o + 1]) * alpha;
    out[o + 2] = ap[o + 2] + (bp[o + 2] - ap[o + 2]) * alpha;
    tmpQA.set(ap[o + 3], ap[o + 4], ap[o + 5], ap[o + 6]);
    tmpQB.set(bp[o + 3], bp[o + 4], bp[o + 5], bp[o + 6]);
    tmpQA.slerp(tmpQB, alpha);
    out[o + 3] = tmpQA.x;
    out[o + 4] = tmpQA.y;
    out[o + 5] = tmpQA.z;
    out[o + 6] = tmpQA.w;
  }
}

export class Multiplayer {
  readonly client: Colyseus.Client;
  private room: Colyseus.Room<RoomState> | null = null;
  private mySessionId: string | null = null;
  private readonly peers = new Map<string, Peer>();
  private readonly remoteHideUntil = new Map<string, number>();
  // Pose envelopes that arrived before the sender's onAdd. Drained into
  // peer.buffer when addPeer runs; stale entries evicted after PENDING_TTL_MS.
  private readonly pending = new Map<string, PoseEnvelope[]>();
  private readonly outPose: Float32Array = new Float32Array(POSE_FLOATS);
  // Fallback to local boot time if state hasn't synced yet — keeps the orb
  // animating from frame 1 instead of staring at a flat sphere.
  private startedAt = Date.now();

  constructor(private readonly opts: MultiplayerOptions) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/colyseus`;
    this.client = new Colyseus.Client(url);
  }

  // Seconds since the room was created, derived from the server-broadcast
  // startedAt. Used to drive ownerless animations (the orb swirl) so every
  // client sees the same phase modulo small NTP drift.
  get roomTime(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  get sessionId(): string | null {
    return this.mySessionId;
  }

  getPeer(sessionId: string): Peer | undefined {
    return this.peers.get(sessionId);
  }

  async connect(): Promise<void> {
    const room = await this.client.joinOrCreate<RoomState>('swangin', {
      channelId: this.opts.channelId,
      userId: this.opts.userId,
      name: this.opts.name,
      color: this.opts.color,
    });
    this.room = room;
    this.mySessionId = room.sessionId;
    console.log(
      `[mp] joined room=${room.roomId} session=${room.sessionId} channel=${this.opts.channelId}`,
    );

    const $ = getStateCallbacks(room);
    if (room.state.startedAt) this.startedAt = room.state.startedAt;
    $(room.state).listen('startedAt', (v: number) => {
      if (v) this.startedAt = v;
    });
    $(room.state).players.onAdd((player: PlayerState, sessionId: string) => {
      if (sessionId === this.mySessionId) {
        // Bridge local kills schema diff to the local kill-counter sprite.
        $(player).listen('kills', (n: number) => {
          this.opts.localRagdoll.setKillCount(n);
        });
        // Apply current value (in case it was non-zero on rejoin).
        this.opts.localRagdoll.setKillCount(player.kills ?? 0);
        return;
      }
      console.log(`[mp] +peer ${player.name} (${sessionId})`);
      this.addPeer(sessionId, player);
      // Bridge peer kills to their sprite.
      const peer = this.peers.get(sessionId);
      if (peer) {
        peer.ragdoll.setKillCount(player.kills ?? 0);
        $(player).listen('kills', (n: number) => {
          peer.ragdoll.setKillCount(n);
        });
      }
    });
    $(room.state).players.onRemove((player: PlayerState, sessionId: string) => {
      console.log(`[mp] -peer ${player.name} (${sessionId})`);
      this.removePeer(sessionId);
    });

    room.onMessage<Uint8Array>('pose', (raw) => {
      // Wire envelope: [u8 sidLen][sid UTF-8 bytes][POSE_BYTES pose payload].
      // The server prepends the sender's sessionId so receivers can dispatch
      // the decoded pose to the right peer.
      if (!raw || raw.byteLength < 1) return;
      const sidLen = raw[0];
      const headerLen = 1 + sidLen;
      if (raw.byteLength !== headerLen + POSE_BYTES) return;
      const sid = textDecoder.decode(raw.subarray(1, headerLen));
      const decoded = decodePose(raw.subarray(headerLen));
      const env: PoseEnvelope = {
        pose: decoded.pose,
        speed: decoded.speed,
        vel: decoded.vel,
        grap: decoded.grap,
        s: sid,
        t: performance.now(),
      };
      const peer = this.peers.get(sid);
      if (!peer) {
        let bucket = this.pending.get(sid);
        if (!bucket) { bucket = []; this.pending.set(sid, bucket); }
        bucket.push(env);
        if (bucket.length > BUFFER_MAX) bucket.shift();
        return;
      }
      peer.buffer.push(env);
      if (peer.buffer.length > BUFFER_MAX) peer.buffer.shift();
    });

    room.onMessage<ConfettiBroadcast>('confetti', (msg) => {
      // Pop confetti at the broadcast position regardless of whether we
      // have the peer locally (e.g. third tab spectator).
      this.opts.confetti.burst(msg.x, msg.y, msg.z, msg.color);
      const peer = this.peers.get(msg.victimSession);
      if (peer) {
        peer.ragdoll.setVisible(false);
        this.remoteHideUntil.set(
          msg.victimSession,
          performance.now() + REMOTE_MESH_HIDE_FALLBACK_MS,
        );
      }
    });
  }

  sendPose(payload: ArrayBuffer): void {
    if (!this.room) return;
    // sendBytes uses the ROOM_DATA_BYTES protocol — no msgpack wrapper, so
    // the server gets exactly POSE_BYTES bytes of payload.
    this.room.sendBytes('pose', new Uint8Array(payload));
  }

  sendDied(killerSessionId: string, x: number, y: number, z: number): void {
    if (!this.room) return;
    this.room.send('died', { killerSessionId, x, y, z });
  }

  // Call once per render frame. Samples each peer's buffer at now - INTERP_DELAY_MS
  // and applies the interpolated pose to its kinematic ragdoll.
  update(dtSeconds = 1 / 60): void {
    const now = performance.now();
    const renderTime = now - INTERP_DELAY_MS;
    // Evict pending buckets whose last envelope is older than PENDING_TTL_MS
    // so sessionIds that never get an onAdd don't accumulate indefinitely.
    for (const [sid, bucket] of this.pending) {
      if (bucket.length > 0 && now - bucket[bucket.length - 1].t > PENDING_TTL_MS) {
        this.pending.delete(sid);
      }
    }
    for (const [sid, peer] of this.peers) {
      // Trail ticks even if no pose arrived this frame so it fades cleanly
      // after a peer stops sending.
      peer.ragdoll.trail.update(dtSeconds);
      const buf = peer.buffer;
      if (buf.length === 0) continue;
      let appliedFresh = false;
      if (buf.length === 1 || renderTime <= buf[0].t) {
        peer.ragdoll.applyPose(buf[0].pose, buf[0].speed, buf[0].vel, buf[0].grap);
        appliedFresh = true;
      } else {
        const last = buf[buf.length - 1];
        if (renderTime >= last.t) {
          peer.ragdoll.applyPose(last.pose, last.speed, last.vel, last.grap);
          appliedFresh = true;
          // Trim everything but the most-recent sample so we don't grow forever
          // when render falls behind the buffer.
          if (buf.length > 1) peer.buffer = [last];
        } else {
          // Find the pair straddling renderTime.
          for (let i = buf.length - 1; i > 0; i--) {
            const b = buf[i];
            const a = buf[i - 1];
            if (a.t <= renderTime && renderTime <= b.t) {
              const span = b.t - a.t || 1;
              const alpha = (renderTime - a.t) / span;
              lerpPose(a, b, alpha, this.outPose);
              // Carry grapple state with no interp — match the newer sample.
              // Same for speed/vel (using the newer sample is closer to "now").
              peer.ragdoll.applyPose(this.outPose, b.speed, b.vel, b.grap);
              appliedFresh = true;
              // Drop samples older than `a` so buffer can't grow unboundedly.
              if (i - 1 > 0) peer.buffer = buf.slice(i - 1);
              break;
            }
          }
        }
      }

      // Re-show a previously hidden peer once new pose data flows OR the
      // safety window expires.
      if (appliedFresh && this.remoteHideUntil.has(sid)) {
        this.remoteHideUntil.delete(sid);
        peer.ragdoll.setVisible(true);
      } else {
        const until = this.remoteHideUntil.get(sid);
        if (until !== undefined && now > until) {
          this.remoteHideUntil.delete(sid);
          peer.ragdoll.setVisible(true);
        }
      }
    }
  }

  private addPeer(sessionId: string, state: PlayerState): void {
    const ragdoll = createRemoteRagdoll(
      this.opts.scene,
      this.opts.world,
      sessionId,
      state.color,
      state.name,
      this.opts.spawnHint,
    );
    const bucket = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    this.peers.set(sessionId, {
      state,
      ragdoll,
      torso: ragdoll.torso,
      buffer: bucket,
      get lastSpeed() { return ragdoll.lastSpeed; },
      get lastVel() { return ragdoll.lastVel; },
    });
  }

  private removePeer(sessionId: string): void {
    this.pending.delete(sessionId);
    const peer = this.peers.get(sessionId);
    if (!peer) return;
    peer.ragdoll.dispose();
    this.peers.delete(sessionId);
    this.remoteHideUntil.delete(sessionId);
    clearPeerCooldown(sessionId);
  }
}

// Bright HSL hue from a hash of the user id, per PLAN.md.
export function colorFromUserId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return new THREE.Color().setHSL(hue / 360, 0.7, 0.6).getHex();
}
