# CLAUDE.md

## Commands

```bash
npm run dev              # client + server in parallel
npm run dev:client       # Vite dev server only (port 3000)
npm run dev:server       # tsx watch server only (port 3001)
npm run build            # build both workspaces
npm --workspace client run test   # client tests
npm --workspace server run test   # server tests (room.test.ts)
```

## Architecture

**Swangin** is a multiplayer grappling-hook ragdoll game run as a Discord Activity (embedded iframe). Two workspaces:

- `client/` — Three.js + Rapier (WASM physics), Vite bundler, TypeScript
- `server/` — Express + Colyseus (WebSocket rooms), TypeScript, esbuild output

### Networking model

The client is authoritative for its own physics. The server relays pose data and tracks scores — no server-side simulation or reconciliation. Pose messages are binary (~172 bytes) sent at ~20 Hz using a quantized format (smallest-three quaternions + int16 root-relative positions) defined in `client/src/pose-codec.ts`. Remote players are rendered with 100 ms interpolation buffer via snapshot lerp in `multiplayer.ts`.

### Discord integration

`discord.ts` runs the OAuth2 RPC flow: `sdk.authorize()` → POST to `/.proxy/api/token` → server exchanges code for access token → `sdk.authenticate()`. Room scoping is one Colyseus room per Discord `channelId`. Player identity (color hash, display name) comes from Discord user data.

### Physics & gameplay

The ragdoll is a number of Rapier rigid bodies (torso, head, upper/lower arms, upper/lower legs). Bodies are constrained by spherical impulse joints; intra-ragdoll self-collision holds pose via contact forces. PD motor controllers in `ragdoll-motors.ts` return limbs toward a rest pose. Lethal collision rule (in `collision.ts`): victim dies if `max(self_speed, peer_speed) >= 10 m/s` AND `peer_speed - self_speed > 0.5 m/s`.

### Key files

| File | Role |
|---|---|
| `PLAN.d` | Full plan that initially setup the project. May be slightly out of date but more context on original goals and reasoning. |
| `client/src/main.ts` | Entry point: scene setup, game loop, Discord + physics + multiplayer init |
| `client/src/ragdoll.ts` | Ragdoll construction, body management |
| `client/src/grapple.ts` | Hook mechanic (left-click to fire, Space to reel) |
| `client/src/collision.ts` | Kill detection |
| `client/src/lifecycle.ts` | Respawn, tumble state, spawn protection |
| `client/src/multiplayer.ts` | Colyseus client, remote pose interpolation |
| `server/src/room.ts` | SwanginRoom: relay, auth, kill tracking |
| `server/src/schema.ts` | Colyseus Player + SwanginState schema |

## Things to avoid

- Don't add server-side physics — the client-authoritative model is intentional.
- Don't widen Colyseus schema types (Colyseus decorators are strict; server `tsconfig.json` enables decorators via `emitDecoratorMetadata`).
- The `client/tsconfig.json` excludes `*.test.ts` from compilation — keep test files out of the build.
- Physics constants in `client/src/constants.ts` are carefully tuned; don't change them without testing in the running game.

# Goals
- 60 fps
- Smooth gameplay and fluid, intuitive mechanics (avoid model stuttering or flickering, avoid jerky mechanics)
- Keep Colyseus' networking budget low for networking performance. Target ~80 B/tick, ~1.6 KB/s/player at 20 Hz or lower