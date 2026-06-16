import RAPIER from '@dimforge/rapier3d-compat';
import type { PosePart } from './ragdoll-proportions.ts';
import {
  COLLISION_SPEED_THRESHOLD,
  COLLISION_TIE_EPSILON,
  LOCAL_PEER_COOLDOWN_MS,
} from './constants.ts';

// Cross-player collision detection.
//
// Layout:
//   - Side-map `ownerByCollider` keyed by Rapier collider handles. Populated
//     at ragdoll/remote-ragdoll construction with `{ kind, sessionId, part }`.
//     For the local ragdoll the sessionId is `null` (the local player's
//     sessionId isn't known until Colyseus resolves) — `null` literally means
//     "self" everywhere downstream, so no backfill is needed.
//   - `drain(eventQueue, ctx)` per physics step: walks Rapier's drained
//     collision events, filters to genuine local↔remote pairs, dedupes
//     multi-part contacts in the same step, applies the cooldown + threshold
//     rule, and (when self loses) calls `ctx.lifecycle.onIncomingKill`.
//
// Authority: victim-authoritative. This module never declares anyone else
// dead — the only outbound effect is `onIncomingKill` on the *local* player.

export interface OwnerInfo {
  kind: 'local' | 'remote';
  sessionId: string | null; // null === local player
  part: PosePart;
}

const ownerByCollider = new Map<number, OwnerInfo>();

// Per-remote cooldown so a single brushing contact, which produces start
// events on many limb pairs in one step, can't re-fire across steps.
const lastInteractionAt = new Map<string, number>();

export function registerCollider(handle: number, info: OwnerInfo): void {
  ownerByCollider.set(handle, info);
}

export function unregisterCollider(handle: number): void {
  ownerByCollider.delete(handle);
}

export function clearPeerCooldown(sessionId: string): void {
  lastInteractionAt.delete(sessionId);
}

// Light interfaces — `collision` doesn't import multiplayer.ts to avoid a
// dependency cycle. main.ts is the wiring point that constructs the context.
export interface PeerSpeedInfo {
  lastSpeed: number | null;
  lastVel: { x: number; y: number; z: number } | null;
}

export interface CollisionContext {
  localRagdoll: {
    smoothedSpeed: number;
  };
  lifecycle: {
    canBeKilled(): boolean;
    onIncomingKill(
      killerSessionId: string,
      killerVel: { x: number; y: number; z: number },
      killerSpeed: number,
    ): void;
  };
  getPeer(sessionId: string): PeerSpeedInfo | undefined;
  // Optional: fired when the local player is the clearly-faster party in a
  // lethal-gate-passing contact. In real multiplayer this is a no-op — the
  // remote client decides its own death. Used by the dev dummy (which has
  // no real client behind it) to trigger a local-only confetti effect.
  onLocalFasterHit?(remoteSession: string): void;
}

export function drain(eventQueue: RAPIER.EventQueue, ctx: CollisionContext): void {
  const now = performance.now();

  // First pass: collect cross-player contacts, deduped per-remote-session.
  const involved = new Map<string, OwnerInfo>(); // remoteSession → remote OwnerInfo
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return; // only act on contact-begin
    const a = ownerByCollider.get(h1);
    const b = ownerByCollider.get(h2);
    if (!a || !b) return; // one side is a cube collider — skip
    if (a.kind === b.kind) return; // same side (shouldn't happen with current groups but cheap guard)
    const remote = a.kind === 'remote' ? a : b;
    if (remote.sessionId === null) return; // remote with null session shouldn't exist
    if (!involved.has(remote.sessionId)) involved.set(remote.sessionId, remote);
  });

  if (involved.size === 0) return;

  // If self can't be killed (already dying or spawn-protected), still stamp
  // cooldowns so we don't immediately re-evaluate the moment protection lifts.
  if (!ctx.lifecycle.canBeKilled()) {
    for (const sess of involved.keys()) lastInteractionAt.set(sess, now);
    return;
  }

  const selfSpeed = ctx.localRagdoll.smoothedSpeed;

  for (const [remoteSession] of involved) {
    const last = lastInteractionAt.get(remoteSession) ?? -Infinity;
    if (now - last < LOCAL_PEER_COOLDOWN_MS) continue;

    const peer = ctx.getPeer(remoteSession);
    if (!peer || peer.lastSpeed === null || peer.lastVel === null) {
      // No pose data yet for this peer — can't make a fair decision.
      // Stamp the cooldown so we don't churn on every step until data arrives.
      lastInteractionAt.set(remoteSession, now);
      continue;
    }

    const peerSpeed = peer.lastSpeed;
    if (Math.max(selfSpeed, peerSpeed) < COLLISION_SPEED_THRESHOLD) {
      // Neither side is moving fast enough — just a slow bump.
      lastInteractionAt.set(remoteSession, now);
      continue;
    }
    if (peerSpeed - selfSpeed > COLLISION_TIE_EPSILON) {
      // Clearly slower and the gate is open. I die.
      lastInteractionAt.set(remoteSession, now);
      ctx.lifecycle.onIncomingKill(remoteSession, peer.lastVel, peerSpeed);
      return; // state has transitioned; ignore remaining events this drain
    }

    if (selfSpeed - peerSpeed > COLLISION_TIE_EPSILON) {
      // Clearly faster than the peer and the gate is open. In real multi-
      // player nothing happens locally — the peer's client decides its own
      // death. The optional hook lets the dev dummy short-circuit that.
      lastInteractionAt.set(remoteSession, now);
      ctx.onLocalFasterHit?.(remoteSession);
      continue;
    }

    // Tie band — nobody dies on this contact.
    lastInteractionAt.set(remoteSession, now);
  }
}
