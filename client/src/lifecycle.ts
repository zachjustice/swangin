import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  TUMBLE_DURATION_S, SPAWN_PROTECT_DURATION_S, KNOCKBACK_GAIN,
} from './constants.ts';

// Local player state machine.
//
// ALIVE: full control, eligible to be killed.
// DYING_TUMBLE: ~3 s. No WASD, no grapple-fire. Grapple force-released and a
//   one-shot knockback impulse applied to the torso along the killer's
//   velocity vector. Mesh stays visible — pose still broadcasts so other
//   clients watch the body fly. At end-of-tumble: send `died`, spawn
//   confetti, hide mesh, respawn, re-show mesh (atomic frame).
// SPAWN_PROTECT: ~1.5 s. Control + grapple back online but death checks are
//   suppressed. Catches the "fast incoming swinger spawn-camps the central
//   pillar" case for at least one breath.
//
// `forceRespawn()` is the path for OOB falls and the R-key — no death credit,
// no `died` message, just a respawn-to-protect transition.

type LifecycleState = 'ALIVE' | 'DYING_TUMBLE' | 'SPAWN_PROTECT';

export interface LifecycleDeps {
  ragdoll: {
    torso: RAPIER.RigidBody;
    respawn(spawn: THREE.Vector3): void;
    setVisible(v: boolean): void;
    material: THREE.MeshStandardMaterial;
  };
  grapple: { release(): void };
  multiplayer: { sendDied(killerSession: string, x: number, y: number, z: number): void };
  confetti: { burst(x: number, y: number, z: number, color: number): void };
  spawnPoint: THREE.Vector3;
}

export class PlayerLifecycle {
  state: LifecycleState = 'ALIVE';
  private stateEnteredAt = performance.now();
  private killerSession: string | null = null;

  constructor(private readonly deps: LifecycleDeps) {}

  canControl(): boolean { return this.state !== 'DYING_TUMBLE'; }
  canBeKilled(): boolean { return this.state === 'ALIVE'; }

  // Called by collision.drain when this client identified itself as the
  // slower party. Apply knockback in the killer's direction of travel.
  onIncomingKill(
    killerSession: string,
    killerVel: { x: number; y: number; z: number },
    _killerSpeed: number,
  ): void {
    if (!this.canBeKilled()) return;
    this.state = 'DYING_TUMBLE';
    this.stateEnteredAt = performance.now();
    this.killerSession = killerSession;
    this.deps.grapple.release();

    // impulse = killerVel × KNOCKBACK_GAIN × torsoMass
    // (mass-scaling makes the felt acceleration constant regardless of mass
    // tuning; magnitude scales with killer velocity, so a faster killer
    // launches harder.)
    const m = this.deps.ragdoll.torso.mass();
    this.deps.ragdoll.torso.applyImpulse({
      x: killerVel.x * KNOCKBACK_GAIN * m,
      y: killerVel.y * KNOCKBACK_GAIN * m,
      z: killerVel.z * KNOCKBACK_GAIN * m,
    }, true);
  }

  tick(now: number): void {
    const dt = now - this.stateEnteredAt;
    if (this.state === 'DYING_TUMBLE' && dt >= TUMBLE_DURATION_S * 1000) {
      const t = this.deps.ragdoll.torso.translation();
      // Order matters: send the `died` message FIRST so the server has the
      // pre-respawn explosion position. Then the local effects.
      if (this.killerSession) {
        this.deps.multiplayer.sendDied(this.killerSession, t.x, t.y, t.z);
      }
      this.deps.confetti.burst(t.x, t.y, t.z, this.deps.ragdoll.material.color.getHex());
      this.deps.ragdoll.setVisible(false);
      this.deps.ragdoll.respawn(this.deps.spawnPoint);
      this.deps.ragdoll.setVisible(true);
      this.state = 'SPAWN_PROTECT';
      this.stateEnteredAt = now;
      this.killerSession = null;
    } else if (this.state === 'SPAWN_PROTECT' && dt >= SPAWN_PROTECT_DURATION_S * 1000) {
      this.state = 'ALIVE';
    }
  }

  // R-key / out-of-bounds. No kill credit, no `died` message — straight to
  // spawn-protect so a quick recovery isn't immediately punished.
  forceRespawn(): void {
    this.deps.grapple.release();
    this.deps.ragdoll.respawn(this.deps.spawnPoint);
    this.state = 'SPAWN_PROTECT';
    this.stateEnteredAt = performance.now();
    this.killerSession = null;
  }
}
