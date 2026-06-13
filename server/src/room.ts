import { Room, Client } from 'colyseus';
import { Player, SwanginState } from './schema.js';

interface JoinOptions {
  channelId?: string;
  userId?: string;
  name?: string;
  color?: number;
}

interface PoseClientMessage {
  pose: number[]; // 70 floats — 10 × (pos.xyz, quat.xyzw) in POSE_PART_ORDER
  grap: number[]; // 4 floats — [active, ax, ay, az]
}

// Server is a relay: identity lives in schema, pose flows through messages
// the server forwards to every other client tagged with the sender's id.
// Each receiver timestamps on arrival and interpolates ~100 ms in the past.
export class SwanginRoom extends Room<SwanginState> {
  override maxClients = 16;

  override onCreate(): void {
    this.setState(new SwanginState());

    this.onMessage<PoseClientMessage>('pose', (client, data) => {
      // No validation beyond array length — clients are authoritative for
      // their own pose by design (PLAN.md: client-authoritative model).
      if (!data || !Array.isArray(data.pose) || data.pose.length !== 70) return;
      if (!Array.isArray(data.grap) || data.grap.length !== 4) return;
      this.broadcast(
        'pose',
        { s: client.sessionId, pose: data.pose, grap: data.grap },
        { except: client },
      );
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
    if (p) console.log(`[room] leave ${p.name} (${client.sessionId})`);
  }
}
