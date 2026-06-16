import { Room, Client } from 'colyseus';
import { Player, SwanginState } from './schema.js';

interface JoinOptions {
  channelId?: string;
  userId?: string;
  name?: string;
  color?: number;
}

// Wire format: 70 floats pose (10 parts × 7) + 1 float scalar speed + 3 floats
// velocity vector + 4 floats grapple state. Kept in sync with
// client/src/pose-codec.ts — POSE_FLOATS = 70, the extra speed/vel fields are
// the v0.2 collision feature addition.
const EXPECTED_POSE_FLOATS = 70;
const EXPECTED_VEL_FLOATS = 3;
const EXPECTED_GRAP_FLOATS = 4;

// Server-side dedup window for `died` messages. Mirror of
// SERVER_DEDUP_MS_REF in client/src/constants.ts — keep them aligned by hand.
const SERVER_DEDUP_MS = 750;

interface PoseClientMessage {
  pose: number[]; // 70 floats
  speed: number;  // smoothed torso |linvel|, m/s
  vel: number[];  // 3 floats — torso linvel xyz, m/s
  grap: number[]; // 4 floats — [active, ax, ay, az]
}

interface DiedMessage {
  killerSessionId: string;
  x: number;
  y: number;
  z: number;
}

// Server is a relay: identity lives in schema, pose flows through messages
// the server forwards to every other client tagged with the sender's id.
// Each receiver timestamps on arrival and interpolates ~100 ms in the past.
//
// The one piece of game-state authority lives here: the `died` message
// credits the killer's kills field via the Colyseus schema, with a small
// dedup window to protect against client double-fires.
export class SwanginRoom extends Room<SwanginState> {
  override maxClients = 16;
  private readonly lastDeathAt = new Map<string, number>();

  override onCreate(): void {
    const state = new SwanginState();
    state.startedAt = Date.now();
    this.setState(state);

    this.onMessage<PoseClientMessage>('pose', (client, data) => {
      // No validation beyond shape — clients are authoritative for their own
      // pose by design (PLAN.md: client-authoritative model).
      if (!data) return;
      if (!Array.isArray(data.pose) || data.pose.length !== EXPECTED_POSE_FLOATS) return;
      if (typeof data.speed !== 'number') return;
      if (!Array.isArray(data.vel) || data.vel.length !== EXPECTED_VEL_FLOATS) return;
      if (!Array.isArray(data.grap) || data.grap.length !== EXPECTED_GRAP_FLOATS) return;
      this.broadcast(
        'pose',
        {
          s: client.sessionId,
          pose: data.pose,
          speed: data.speed,
          vel: data.vel,
          grap: data.grap,
        },
        { except: client },
      );
    });

    this.onMessage<DiedMessage>('died', (client, data) => {
      if (!data || typeof data.killerSessionId !== 'string') return;
      if (typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') return;

      const now = Date.now();
      const last = this.lastDeathAt.get(client.sessionId) ?? -Infinity;
      if (now - last < SERVER_DEDUP_MS) return;
      this.lastDeathAt.set(client.sessionId, now);

      const victim = this.state.players.get(client.sessionId);
      if (!victim) return;

      // Killer may have left mid-tumble. Still respawn the victim and
      // broadcast confetti for the visual — just skip the kills++.
      const killer = this.state.players.get(data.killerSessionId);
      if (killer) {
        killer.kills = Math.min(65535, killer.kills + 1);
      } else {
        console.log(`[room] died: killer ${data.killerSessionId} gone, no credit`);
      }
      victim.kills = 0;

      this.broadcast('confetti', {
        victimSession: client.sessionId,
        killerSession: data.killerSessionId,
        color: victim.color,
        x: data.x,
        y: data.y,
        z: data.z,
      });
    });
  }

  override onJoin(client: Client, options: JoinOptions): void {
    const p = new Player();
    p.userId = options.userId ?? '';
    p.name = options.name ?? 'Anon';
    p.color = options.color ?? 0xffffff;
    this.state.players.set(client.sessionId, p);
    console.log(`[room] join ${p.name} (${client.sessionId})`);
  }

  override onLeave(client: Client): void {
    const p = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.lastDeathAt.delete(client.sessionId);
    if (p) console.log(`[room] leave ${p.name} (${client.sessionId})`);
  }
}
