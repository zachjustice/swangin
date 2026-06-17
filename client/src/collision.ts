import RAPIER from '@dimforge/rapier3d-compat';
import type { PosePart } from './ragdoll-proportions.ts';
import {
  COLLISION_SPEED_THRESHOLD,
  COLLISION_TIE_EPSILON,
  LOCAL_PEER_COOLDOWN_MS,
  KNOCKBACK_GAIN,
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

// Light interfaces — `collision` doesn't import multiplayer.ts to avoid a
// dependency cycle. main.ts is the wiring point that constructs the context.
export interface PeerSpeedInfo {
  lastSpeed: number | null;
  lastVel: { x: number; y: number; z: number } | null;
  torso: RAPIER.RigidBody;
}

export interface CollisionContext {
  localRagdoll: {
    smoothedSpeed: number;
    torso: RAPIER.RigidBody;
    vel: { x: number; y: number; z: number };
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
  // Optional: fired alongside every cross-player local-torso impulse with the
  // equal-and-opposite impulse vector. In real multiplayer this stays unset —
  // the remote's own machine moves their body and streams it back. The dev
  // dummy wires this up so its kinematic pose visibly swings on contact.
  onPeerImpulse?(remoteSession: string, impulse: { x: number; y: number; z: number }): void;
}

export class Collision {
  private readonly ownerByCollider = new Map<number, OwnerInfo>();
  // Inverse index: sessionId → collider handles. Lets `clearPeer` purge a
  // disconnected remote even if its ragdoll.dispose() never runs (e.g. an
  // abrupt teardown path or a future code change that forgets to call it).
  private readonly handlesBySession = new Map<string, Set<number>>();
  // Per-remote cooldown so a single brushing contact, which produces start
  // events on many limb pairs in one step, can't re-fire across steps.
  private readonly lastInteractionAt = new Map<string, number>();

  registerCollider(handle: number, info: OwnerInfo): void {
    this.ownerByCollider.set(handle, info);
    if (info.kind === 'remote' && info.sessionId !== null) {
      let bucket = this.handlesBySession.get(info.sessionId);
      if (!bucket) {
        bucket = new Set();
        this.handlesBySession.set(info.sessionId, bucket);
      }
      bucket.add(handle);
    }
  }

  unregisterCollider(handle: number): void {
    const info = this.ownerByCollider.get(handle);
    this.ownerByCollider.delete(handle);
    if (info && info.kind === 'remote' && info.sessionId !== null) {
      const bucket = this.handlesBySession.get(info.sessionId);
      if (bucket) {
        bucket.delete(handle);
        if (bucket.size === 0) this.handlesBySession.delete(info.sessionId);
      }
    }
  }

  clearPeerCooldown(sessionId: string): void {
    this.lastInteractionAt.delete(sessionId);
  }

  // Belt-and-suspenders cleanup when a peer disconnects: purges all collider
  // entries for the session plus the cooldown. Safe to call after the peer's
  // ragdoll.dispose() has already done the per-handle unregisterCollider loop.
  clearPeer(sessionId: string): void {
    const handles = this.handlesBySession.get(sessionId);
    if (handles) {
      for (const h of handles) this.ownerByCollider.delete(h);
      this.handlesBySession.delete(sessionId);
    }
    this.lastInteractionAt.delete(sessionId);
  }

  // Drop all internal state. For full scene re-init.
  reset(): void {
    this.ownerByCollider.clear();
    this.handlesBySession.clear();
    this.lastInteractionAt.clear();
  }

  drain(eventQueue: RAPIER.EventQueue, ctx: CollisionContext): void {
    const now = performance.now();

    // First pass: collect cross-player contacts, deduped per-remote-session.
    const involved = new Map<string, OwnerInfo>(); // remoteSession → remote OwnerInfo
    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return; // only act on contact-begin
      const a = this.ownerByCollider.get(h1);
      const b = this.ownerByCollider.get(h2);
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
      for (const sess of involved.keys()) this.lastInteractionAt.set(sess, now);
      return;
    }

    const selfSpeed = ctx.localRagdoll.smoothedSpeed;

    for (const [remoteSession] of involved) {
      const last = this.lastInteractionAt.get(remoteSession) ?? -Infinity;
      if (now - last < LOCAL_PEER_COOLDOWN_MS) continue;

      const peer = ctx.getPeer(remoteSession);
      if (!peer || peer.lastSpeed === null || peer.lastVel === null) {
        // No pose data yet for this peer — can't make a fair decision. Don't
        // stamp the cooldown: the data may arrive next frame, and stamping
        // here would silently swallow the next LOCAL_PEER_COOLDOWN_MS of
        // newly-valid contacts.
        continue;
      }

      const peerSpeed = peer.lastSpeed;

      // Local-only knockback: push self away from peer along the contact normal,
      // scaled by closing speed × KNOCKBACK_GAIN × torso mass. Both clients do
      // this independently for their own local body — the streamed pose carries
      // the result to the other side after INTERP_DELAY_MS. No double-counting,
      // and Rapier's natural contact against a kinematic remote is a wall-bump,
      // so the manual impulse is what makes the hit feel like momentum exchange.
      // Bail on zero distance (coincident torsos); no floor on closingSpeed, so
      // glancing brushes get nothing from this and rely on Rapier's contact.
      const localPos = ctx.localRagdoll.torso.translation();
      const peerPos = peer.torso.translation();
      const ndx = localPos.x - peerPos.x;
      const ndy = localPos.y - peerPos.y;
      const ndz = localPos.z - peerPos.z;
      const nlen = Math.hypot(ndx, ndy, ndz);
      if (nlen >= 1e-5) {
        const dx = ndx / nlen;
        const dy = ndy / nlen;
        const dz = ndz / nlen;
        const closingSpeed = Math.max(
          0,
          (peer.lastVel.x - ctx.localRagdoll.vel.x) * dx +
          (peer.lastVel.y - ctx.localRagdoll.vel.y) * dy +
          (peer.lastVel.z - ctx.localRagdoll.vel.z) * dz,
        );
        if (closingSpeed > 0) {
          const mag = closingSpeed * KNOCKBACK_GAIN * ctx.localRagdoll.torso.mass();
          ctx.localRagdoll.torso.applyImpulse(
            { x: dx * mag, y: dy * mag, z: dz * mag },
            true,
          );
          ctx.onPeerImpulse?.(remoteSession, { x: -dx * mag, y: -dy * mag, z: -dz * mag });
        }
      }

      if (Math.max(selfSpeed, peerSpeed) < COLLISION_SPEED_THRESHOLD) {
        // Neither side is moving fast enough — just a slow bump.
        this.lastInteractionAt.set(remoteSession, now);
        continue;
      }
      if (peerSpeed - selfSpeed > COLLISION_TIE_EPSILON) {
        // Clearly slower and the gate is open. I die.
        this.lastInteractionAt.set(remoteSession, now);
        ctx.lifecycle.onIncomingKill(remoteSession, peer.lastVel, peerSpeed);
        return; // state has transitioned; ignore remaining events this drain
      }

      if (selfSpeed - peerSpeed > COLLISION_TIE_EPSILON) {
        // Clearly faster than the peer and the gate is open. In real multi-
        // player nothing happens locally — the peer's client decides its own
        // death. The optional hook lets the dev dummy short-circuit that.
        this.lastInteractionAt.set(remoteSession, now);
        ctx.onLocalFasterHit?.(remoteSession);
        continue;
      }

      // Tie band — nobody dies on this contact.
      this.lastInteractionAt.set(remoteSession, now);
    }
  }
}
