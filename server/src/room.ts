import { Room, Client } from 'colyseus';
import { Player, SwanginState } from './schema.ts';

interface JoinOptions {
  channelId?: string;
  userId?: string;
  name?: string;
  color?: number;
}

// Wire size of the binary pose payload. Kept in sync by hand with
// client/src/pose-codec.ts → POSE_BYTES. A mismatch here is a wire-format
// drift, so the validator rejects rather than silently re-broadcasting.
const EXPECTED_POSE_BYTES = 172;

// Server-side dedup window for `died` messages. Mirror of
// SERVER_DEDUP_MS_REF in client/src/constants.ts — keep them aligned by hand.
const SERVER_DEDUP_MS = 750;

interface DiedMessage {
  killerSessionId: string;
  x: number;
  y: number;
  z: number;
}

const textEncoder = new TextEncoder();

// Server is a relay: identity lives in schema, pose flows through binary
// messages the server prefixes with the sender's sessionId and forwards to
// every other client. Each receiver timestamps on arrival and interpolates
// ~100 ms in the past.
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

    this.onMessage<Uint8Array>('pose', (client, raw) => {
      // No validation beyond shape — clients are authoritative for their own
      // pose by design (PLAN.md: client-authoritative model). We only check
      // that the byte length matches the documented codec width.
      if (!raw || raw.byteLength !== EXPECTED_POSE_BYTES) return;

      const sidBytes = textEncoder.encode(client.sessionId);
      if (sidBytes.byteLength > 255) return; // sidLen is a uint8
      const envelope = new Uint8Array(1 + sidBytes.byteLength + raw.byteLength);
      envelope[0] = sidBytes.byteLength;
      envelope.set(sidBytes, 1);
      envelope.set(raw, 1 + sidBytes.byteLength);
      this.broadcastBytes('pose', envelope, { except: client });
    });

    this.onMessage<DiedMessage>('died', (client, data) => {
      if (!data || typeof data.killerSessionId !== 'string') return;
      if (typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') return;

      // Reject self-kills.
      if (data.killerSessionId === client.sessionId) return;

      // Killer must be a currently-connected peer.
      const killer = this.state.players.get(data.killerSessionId);
      if (!killer) return;

      const dedupKey = `${client.sessionId}:${data.killerSessionId}`;
      const now = Date.now();
      const last = this.lastDeathAt.get(dedupKey) ?? -Infinity;
      if (now - last < SERVER_DEDUP_MS) return;
      this.lastDeathAt.set(dedupKey, now);

      const victim = this.state.players.get(client.sessionId);
      if (!victim) return;

      killer.kills = Math.min(65535, killer.kills + 1);
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
    const id = client.sessionId;
    for (const key of this.lastDeathAt.keys()) {
      if (key.startsWith(`${id}:`) || key.endsWith(`:${id}`)) {
        this.lastDeathAt.delete(key);
      }
    }
    if (p) console.log(`[room] leave ${p.name} (${client.sessionId})`);
  }
}
