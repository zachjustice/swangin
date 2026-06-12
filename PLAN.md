# Grapple Ragdoll — Discord Activity Prototype Plan

A multiplayer grappling-hook hangout game (inspired by Shopify Party): little ragdoll
people swing on rigid grapple lines around a lattice of cubes, around a glowing orb,
as a Discord Activity.

## How to use this plan

This is written to be executed by an LLM coding assistant, commit by commit, with a
human collaborator. Each commit ends in something demo-able (even if that's just "a box
falls" or "the reticle locks"). Don't move to the next commit until the current one runs.

A few things only the **human** can do — they're flagged inline as **[HUMAN]**:
- Create/configure the Discord application in the Developer Portal (OAuth2, URL mappings, testers).
- Run a local tunnel (e.g. `cloudflared`) so Discord can load the local dev server.
- Provide a second client/person for real multiplayer testing.
- Make subjective tuning calls (feel, colors, motor stiffness).
- Host the Colyseus server somewhere reachable for non-local testing and register its URL mapping.

Three points are explicit **verify-here** risk checkpoints (C3, C8, C10) — confirm them
before building further on top.

---

## Locked decisions (architecture & parameters)

**Stack**
- TypeScript + **Three.js** (render) + **Rapier** (`@dimforge/rapier3d-compat`, the
  Vite-friendly build) for physics + **Vite** (bundler).
- **@discord/embedded-app-sdk** for the Activity, **@robojs/patch** (Vite plugin) for
  Discord proxy/CSP compliance.
- **Colyseus** (self-hosted) for rooms/state, started from the official
  `colyseus/discord-activity` template. WebSocket transport (the only transport Discord
  Activities support — WebRTC/UDP is unavailable).
- **@geckos.io/snapshot-interpolation** for smoothing remote players.

**Networking model (client-authoritative — same as Shopify Party's Normcore model)**
- Each client simulates **only its own** ragdoll and broadcasts the result. Server is a
  relay + room-state holder; no server-side physics. No reconciliation (you own your player).
- Server structured as **relay + an (initially empty) authoritative game-state module**, so
  scores/levels/achievements can bolt on later without re-architecting.
- Physics at **60 Hz** fixed timestep locally; network send **~20 Hz**; remote players
  rendered **~100 ms in the past** with snapshot interpolation; local player rendered live.
- Per-tick payload: full ragdoll pose (~10 body transforms, quantized — smallest-three
  quaternion, root-relative positions) + grapple state (`isGrappling` bool + anchor point).
  Fallback if throughput is tight: **root-only sync** (send torso transform; drape limbs locally).
- Sent once on join via Colyseus schema: player id, display name, color.
- Room scoped by Discord **channelId**. Identity via the template auth flow
  (`ready()` → `authorize({scope:['identify']})` → POST code to `/.proxy/api/token` →
  `authenticate()`). Name = `global_name` (fallback `username`). Color = hash(user id) → bright HSL hue.
- Ownerless animation (the orb) driven by the Colyseus **server clock / room-time** so it's
  identical for everyone.

**Character**
- **Active ragdoll** is the goal; **passive ragdoll first** is the path.
- ~9–10 rigid bodies: head, torso, 2 arms (upper + forearm/hand), 2 legs (thigh + shin/foot),
  connected by spherical joints.
- Active pose via Rapier joint **motors** (PD controller: target angle + stiffness/damping).
  Fallback if spherical-joint motors misbehave: apply corrective torques manually each frame.
- Visual layer = simple **primitive meshes** parented to each physics body (sphere head,
  tapered cylinders for limbs/torso, sphere hands, little feet), transforms copied each frame.
  No Blender, no rig, no authored animation. Eye dots on the head; mouth optional.
- Flat single color per player. **CSS2DRenderer** name labels billboarding above each head.

**Grapple**
- **Rigid fixed-length** distance constraint (rigid-vs-slack exposed as an early tuning knob).
- Aim by raycast from camera through the **center reticle** (pointer-lock mouselook).
- Attach at the **surface hit point** on the cube; small snap tolerance for near-misses.
- Connects to the **hand**; the arm motor reaches toward the anchor. **One** grapple at a time.
- **Hold** to stay attached, **release** to let go. Lines are visual-only (never colliders),
  which satisfies "no collision between grapple lines" for free.
- Locomotion is **gravity + grapple only** — no WASD, no air control in v0.

**World**
- **20×20×20 regular lattice = 8,000 identical static cubes**, each edge a bit smaller than
  the player; center-to-center **pitch 3–4× the cube size**.
- Rendered with one `THREE.InstancedMesh`; all cubes are **static Rapier colliders**.
- Deterministic/identical for every client (no world sync). Orb sits at the exact center;
  **carve a small spherical pocket** (remove central cubes) around it.
- **Spawn 5 units above top-center**; out-of-bounds / falling respawns there.

**Camera & controls**
- **Third-person** camera orbiting the ragdoll's torso (damped follow). **Pointer-lock
  mouselook** turns it; center reticle. Left-click-hold = grapple.
- Primary input path = Pointer Lock API (confirmed usable in Discord Activities). Keep a
  **drag-to-look** fallback stub in case a context blocks pointer lock.

**Orb**
- Atmospheric, **non-colliding**. Emissive sphere ~2× player size in the central pocket.
- Glow via `EffectComposer` + `UnrealBloomPass`. Swirl via a noise shader drifting between
  light-blue and light-purple, driven by room-time. One or two colored point lights at center
  + low ambient/hemisphere light so the dark-blue scene reads.

**Player–player collision**
- Resolved **locally** against the interpolated remote bodies ("good enough, a little chaotic").
  Perfectly consistent contact would need server-authoritative physics — out of scope for v0.

---

## Commit sequence

### Phase 0 — Foundations & de-risking

**C1 — Scaffold + render loop.**
Vite + TypeScript project. Three.js scene: dark-blue background, perspective camera, basic
lighting, one spinning cube, resize handling, render loop.
*Demo:* a spinning cube on a dark-blue background in the browser.

**C2 — Rapier physics integration.**
Add `@dimforge/rapier3d-compat` (async WASM init before the loop starts). Create a physics
world with gravity, a static ground, and a dynamic box; copy body transforms to meshes each
frame at a fixed 60 Hz step (with an accumulator).
*Demo:* a box falls and comes to rest on the ground in-browser. (Proves Rapier loads & steps.)

**C3 — Discord Activity shell + auth + pointer-lock probe. [HUMAN] [VERIFY]**
Restructure to the `colyseus/discord-activity` layout (client + server packages). Add
`@discord/embedded-app-sdk` and the `@robojs/patch` Vite plugin. **[HUMAN]** create the Discord
app, set OAuth2 + URL mappings, run `cloudflared`. Implement the auth flow
(`ready` → `authorize` `identify` → server `/.proxy/api/token` exchange → `authenticate`) and
render "Hello, {global_name}". Then **probe `requestPointerLock()` inside the real Discord
iframe**: show a center reticle, log success; if it fails, switch on the drag-look fallback stub.
*Demo:* the app launches **as a Discord Activity**, greets you by name, and pointer lock is
confirmed working in-iframe. **Do not proceed until this loads inside Discord.**

### Phase 1 — Single-player core (the swing toy)

**C4 — The cube world.**
Deterministically generate the 20×20×20 lattice; render as one `InstancedMesh`; create 8,000
static box colliders; carve the central spherical pocket. Add a visible spawn marker 5 units
above top-center. Temporary free-fly debug camera.
*Demo:* fly through the lattice; cubes are solid to raycasts/collisions.

**C5 — Passive ragdoll.**
Build the ~10-body skeleton with spherical joints. Parent primitive visual meshes (sized to
the specced proportions: big head, tapered limbs, sphere hands, little feet, eye dots), copy
transforms each frame, flat color. Spawn above the lattice with motors **off**.
*Demo:* a little ragdoll drops in and flops/crumples onto the cubes — wobbly limbs visible.

**C6 — Third-person camera + pointer-lock mouselook.**
Replace the debug camera with a damped third-person camera following the ragdoll's torso;
mouse (pointer-locked) controls yaw/pitch; center reticle; raycast-from-reticle helper that
highlights the cube under the reticle.
*Demo:* look around your flopped ragdoll with mouselook; the targeted cube highlights.

**C7 — The grapple (rigid). — first "fun" milestone.**
Left-click-hold → reticle raycast → if it hits a cube, create a rigid fixed-length distance
constraint from the hand to the surface point; draw the visual line; release removes it.
Gravity + swing physics. Out-of-bounds/fall → respawn at spawn point. Expose the rigid-vs-slack
knob.
*Demo:* you swing around the lattice on rigid grapple lines, ragdoll flopping — the core toy works (single-player).

**C8 — Active ragdoll motors. — aesthetic milestone. [VERIFY]**
Add PD-controller joint motors pulling limbs toward a default upright pose; the grapple arm
reaches toward the anchor. Tune stiffness/damping. **If spherical-joint motors are unstable,
switch to the manual corrective-torque fallback.**
*Demo:* the guy holds a humanoid shape, reaches for the line, limbs lag and swing — the
Gang-Beasts/Human-Fall-Flat feel.

### Phase 2 — Multiplayer

**C9 — Colyseus room by channelId + presence.**
Stand up the Colyseus server (single process). Room keyed by Discord `channelId`; join/leave;
identity (id, name, color) in the room schema. Client connects through the Discord proxy.
Render **other** players as placeholder capsules at a synced root position (no ragdoll yet).
*Demo:* two tabs / two Discord users share a room and see each other's placeholder move; names
and colors correct. **[HUMAN]** provide the second client.

**C10 — Full-pose sync + interpolation. — multiplayer milestone. [VERIFY]**
Broadcast the local ragdoll's ~10 quantized transforms at 20 Hz; reconstruct remote players as
kinematic bodies smoothed with `@geckos.io/snapshot-interpolation` (~100 ms buffer). Broadcast
grapple state and draw remote grapple lines. Add CSS2D name labels above every head.
**If full-pose throughput is a problem, drop to root-only sync (local limb drape).**
*Demo:* players swing around together, each seeing the others' wobbling ragdolls + grapple
lines + floating usernames — the screenshot.

**C11 — Player–player collision.**
Enable local collision between your ragdoll and the interpolated remote bodies.
*Demo:* players bump and shove each other mid-swing.

### Phase 3 — Atmosphere & polish

**C12 — The glowing orb.**
Emissive sphere (~2× player) in the central pocket; `EffectComposer` + `UnrealBloomPass`;
swirl shader (light-blue ↔ light-purple) driven by room-time; one or two colored point lights
+ low ambient.
*Demo:* a glowing, swirling orb lighting the scene, animating identically across clients.

**C13 — Tuning & polish pass.**
Grapple feel (rigid-vs-slack), motor stiffness, camera damping, spawn/respawn flow, color
hashing, name-label styling, perf/draw-call check, finalize the drag-look fallback.
*Demo:* the cohesive v0 experience.

---

## Deferred (post-v0)

- Server-authoritative game-state module fleshed out: scores, levels, achievements,
  leaderboards (Colyseus schema is the home for this; client-auth movement is unaffected).
- Per-room world seeds (instead of one fixed layout).
- Dual/both-hand grapples; air control.
- Camera-vs-cube collision; mobile/touch controls.
- Character customization (colors/cosmetics).
- Multi-process server scaling (note the known Colyseus + Discord CSP wrinkle when scaling
  past one process — stay single-process until you need more).

## Known risks to watch

- **Pointer lock in-iframe (C3):** confirmed usable, but verify in the real Activity before building controls on it.
- **Spherical-joint motor stability (C8):** Rapier's spherical motors have historically been
  finicky; manual corrective torques are the fallback for the active-ragdoll look.
- **Full-pose bandwidth (C10):** ~10 transforms × 20 Hz × N players; quantize hard, and fall
  back to root-only sync if rooms feel heavy.