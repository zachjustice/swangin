import { Schema, MapSchema, type } from '@colyseus/schema';

// Identity only. Pose ships through room messages so the client can timestamp
// and interpolate it directly — there's no need for the server to hold pose
// state (no late-join replay, no server-side physics).
export class Player extends Schema {
  @type('string') userId = '';
  @type('string') name = '';
  @type('uint32') color = 0xffffff;
}

export class SwanginState extends Schema {
  // Server-clock seed (Date.now() at room creation). Clients subtract from
  // their own Date.now() to compute roomTime — drives the orb swirl so every
  // client sees the same phase. Small NTP-drift skew (~ms) is fine for a
  // slow visual animation.
  @type('float64') startedAt = 0;

  @type({ map: Player }) players = new MapSchema<Player>();
}
