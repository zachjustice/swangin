import { Room, Client } from 'colyseus';
import { Player, SwanginState } from './schema.ts';
import { TokenBucket } from './token-bucket.ts';

interface JoinOptions {
  channelId?: string;
  access_token?: string;
}

interface DiscordAuthResult {
  id: string;
  name: string;
}

// Replicates THREE.Color.setHSL(hue/360, 0.7, 0.6).getHex() without the
// THREE dependency, so the server derives the same color as the client.
export function colorFromUserId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  const hDeg = Math.abs(hash) % 360;
  const h = hDeg / 360;
  const s = 0.7;
  const l = 0.6;
  const p = l + s - l * s; // l > 0.5 branch
  const q = 2 * l - p;
  function hue2rgb(p: number, q: number, t: number): number {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
    return p;
  }
  const r = Math.round(hue2rgb(q, p, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(q, p, h) * 255);
  const b = Math.round(hue2rgb(q, p, h - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

// Exported for testing — accepts an optional fetcher so unit tests don't need
// to patch globalThis.fetch.
export async function verifyDiscordToken(
  token: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DiscordAuthResult> {
  const r = await fetcher('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    throw new Error(`Discord token rejected (${r.status})`);
  }
  const user = (await r.json()) as { id: string; global_name?: string | null; username: string };
  return { id: user.id, name: user.global_name ?? user.username };
}

// Wire size of the binary pose payload. Kept in sync by hand with
// client/src/pose-codec.ts → POSE_BYTES. A mismatch here is a wire-format
// drift, so the validator rejects rather than silently re-broadcasting.
const EXPECTED_POSE_BYTES = 172;

// Server-side dedup window for `died` messages. Mirror of
// SERVER_DEDUP_MS_REF in client/src/constants.ts — keep them aligned by hand.
const SERVER_DEDUP_MS = 750;

// Byte offsets of the float32 fields in the pose binary (see pose-codec.ts).
// Only float32 fields can carry NaN/Infinity; int16/uint16 fields are safe.
const POSE_TORSO_POS_OFFSET = 4;   // 3 × float32 — world-space torso xyz
const POSE_GRAP_ANCHOR_OFFSET = 160; // 3 × float32 — grapple anchor xyz


interface DiedMessage {
  killerSessionId: string;
  x: number;
  y: number;
  z: number;
}

// Returns false if any float32 in the pose payload is non-finite.
// Only checks the two float32 regions; int16/uint16 fields can't carry NaN.
export function isPoseValid(raw: Uint8Array): boolean {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(view.getFloat32(POSE_TORSO_POS_OFFSET + i * 4, true))) return false;
    if (!Number.isFinite(view.getFloat32(POSE_GRAP_ANCHOR_OFFSET + i * 4, true))) return false;
  }
  return true;
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
  // Per-client rate limiters. Pose: ~30 Hz cap (20 Hz expected). Died: 5 Hz cap.
  private readonly poseBuckets = new Map<string, TokenBucket>();
  private readonly diedBuckets = new Map<string, TokenBucket>();

  override onCreate(): void {
    const state = new SwanginState();
    state.startedAt = Date.now();
    this.setState(state);

    this.onMessage<Uint8Array>('pose', (client, raw) => {
      if (!raw || raw.byteLength !== EXPECTED_POSE_BYTES) return;

      let bucket = this.poseBuckets.get(client.sessionId);
      if (!bucket) {
        bucket = new TokenBucket(30, 30);
        this.poseBuckets.set(client.sessionId, bucket);
      }
      if (!bucket.allow()) return;

      // Reject if any float32 field is non-finite — NaN/Infinity would crash
      // the receiver's setNextKinematicTranslation call.
      if (!isPoseValid(raw)) return;

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
      if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.z)) return;

      let diedBucket = this.diedBuckets.get(client.sessionId);
      if (!diedBucket) {
        diedBucket = new TokenBucket(5, 5);
        this.diedBuckets.set(client.sessionId, diedBucket);
      }
      if (!diedBucket.allow()) return;

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
      victim.deaths = Math.min(65535, victim.deaths + 1);

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

  override async onAuth(_client: Client, options: JoinOptions): Promise<DiscordAuthResult> {
    if (!options.access_token) {
      // Standalone / dev mode — no Discord token; use session-derived anon identity.
      return { id: `anon-${_client.sessionId}`, name: 'Anon' };
    }
    return verifyDiscordToken(options.access_token);
  }

  override onJoin(client: Client, _options: JoinOptions, auth: DiscordAuthResult): void {
    const p = new Player();
    p.userId = auth.id;
    p.name = auth.name;
    p.color = colorFromUserId(auth.id);
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
    this.poseBuckets.delete(id);
    this.diedBuckets.delete(id);
    if (p) console.log(`[room] leave ${p.name} (${client.sessionId})`);
  }
}
