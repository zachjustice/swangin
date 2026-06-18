# main.ts refactor — module boundaries

Target: `main.ts` ~80 lines, pure wiring.

Note: spec mentioned EffectComposer / UnrealBloomPass; current `main.ts` has neither. `graphics.ts` covers what's actually there.

## Modules

### `graphics.ts`
```ts
export interface Graphics {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  hemiLight: THREE.HemisphereLight;
  cloudLayer: ReturnType<typeof createCloudLayer>;
}
export function createGraphics(): Graphics;
```
Owns: scene + background, perspective camera, WebGLRenderer (tonemap, pixel ratio, DOM append), CSS2DRenderer DOM, hemi + ambient + directional lights, cloud layer, resize listener. No game state.

`cloudLayer` lives here (not in bootstrap) because it's a scene-graph fixture, not gameplay. Sky-controller takes it as a dep.

### `sky-controller.ts`
```ts
export interface SkyController {
  update(dt: number): void;
  advanceHorizon(): void;          // orb calls this on player entry
  setHorizon(hex: string): void;   // dev-hud entry point
  setZenith(hex: string): void;
  readonly horizonColor: THREE.Color;
}
export function createSkyController(deps: {
  scene: THREE.Scene;
  hemiLight: THREE.HemisphereLight;
  cloudLayer: ReturnType<typeof createCloudLayer>;
}): SkyController;
```
Owns: ROYGBIV index, `skyFrom/To/Current`, `skyZenithCurrent`, `skyT`, lerp, sync to scene.background + hemiLight + cloudLayer.
**Does NOT** own DOM or orb-entry detection. Orb owns entry detection (see Q1 resolution) and calls `advanceHorizon()` on the rising edge.

### `dev-hud.ts` (new)
Wires the optional `#sky-horizon` / `#sky-zenith` color pickers in index.html (currently inline at main.ts:30–44) to `sky.setHorizon`/`setZenith`. Reflects active lerp back into the picker by reading `sky.horizonColor` each frame the lerp is running. DEV-only call site from bootstrap; no-op if elements absent.

### `orb.ts` (extension)
Add `onPlayerEnter(cb: () => void)` and split the per-frame entrypoints:
- `tick(time: number): void` — animation only (used in pre-spawn render path; no detection).
- `checkEntry(torsoPos: { x: number; y: number; z: number }): void` — owns `wasInsideOrb` edge detection and fires `onPlayerEnter` callbacks on the rising edge.

Bootstrap wires `orb.onPlayerEnter(() => sky.advanceHorizon())`. Pre-spawn render calls `orb.tick(time)` only; active-loop preRender calls both.

### `input-controller.ts`
```ts
export interface MovementInput { w: boolean; a: boolean; s: boolean; d: boolean; }
export interface ReelInput { space: boolean; shift: boolean; dashArmed: boolean; }
export interface InputController {
  movement: Readonly<MovementInput>;
  reel: Readonly<ReelInput>;
  onFire(cb: () => void): void;
  onRelease(cb: () => void): void;
  onRespawn(cb: () => void): void;
  onChange(cb: () => void): void;     // fires when reel-relevant keys flip
  onPointerLockClick(cb: () => void): void;  // for tpCamera.lock() relock
}
export function createInputController(target: HTMLElement): InputController;
```
Pure input: tracks key state, double-tap dash latch, mouse fire/release, R-to-respawn, click-to-relock. **No coupling to grapple state.** Movement + reel-mode resolution live in `local-player.ts` (see Q2 resolution).

Preserves:
- `e.preventDefault()` on Space (else page scrolls).
- `dashArmed` reset on space-up.
- **First-transition-only semantics for dash**: keydown auto-repeat must NOT re-arm dash. Track an internal `spaceWasDown` flag and only run the double-tap timing check on the rising edge (`!spaceWasDown && e.code === 'Space'`), mirroring the current `if (!keys.space)` guard at main.ts:516. Same first-transition gate applies to `onChange` — fire it only when the reel-relevant state actually flips, not on every repeat event.

### `local-player.ts`
```ts
export class LocalPlayer {
  constructor(deps: {
    ragdoll: Ragdoll;
    grapple: Grapple;
    lifecycle: PlayerLifecycle;
    tpCamera: ThirdPersonCamera;
    reticle: CubeReticle;
    input: InputController;
  });
  preStep(): void;             // grappleAnchor → motors.update → applyMovementImpulse → sample preStepVel → cachePrevForInterp
  checkRespawn(): void;        // OOB check, calls lifecycle.forceRespawn
  updateReelMode(): void;      // public so tests / future callers can poke it; mostly self-driven via input.onChange
  /**
   * Stable backing object — same reference returned every call. The substep
   * mutates the fields in place. `buildCollisionCtx` captures this reference
   * once at construction time and trusts in-place updates; do NOT swap to a
   * getter that returns a fresh object.
   */
  readonly preStepVel: { x: number; y: number; z: number };
}
```
Owns: input→ragdoll/grapple/lifecycle translation. Absorbs `applyMovementImpulse`, `updateReelMode`, and `checkRespawn` from `main.ts`. Also owns `preStepLocalVel` (currently a module-level mutable object at main.ts:223) and exposes it via the `preStepVel` field — a stable object reference, mutated in place each substep — so `buildCollisionCtx` can capture it once and read it through the lifetime of the run.

Owns reticle-coupled fire because `onFire` needs both `reticle.hitPoint` AND a follow-up `updateReelMode()` call (today at main.ts:494–496); doing it bootstrap-side would force `updateReelMode` to be public and re-cross the boundary. Adding `reticle` as a constructor dep is the cleaner trade.

`preStep()` ordering (load-bearing, mirrors current main.ts:309–318):
1. `ragdoll.motors.grappleAnchor = grapple.isActive ? grapple.anchorPos : null`
2. `ragdoll.motors.update(FIXED_DT)`
3. `applyMovementImpulse()`
4. sample `ragdoll.torso.linvel()` into `preStepVel` (in-place mutation, NOT reassignment)
5. `ragdoll.cachePrevForInterp()`; if `grapple.isActive`, `grapple.cachePrevForInterp()`

`cachePrevForInterp` MUST be the last thing before `world.step` so `prev = state at start of this substep`.

Bootstrap constructs LocalPlayer and calls `preStep()` from the loop's per-substep hook, `checkRespawn()` from `preRender`. Wiring (in LocalPlayer's constructor):
- `input.onFire(() => { if (this.lifecycle.canControl() && this.reticle.hitPoint) { this.grapple.fire(this.reticle.hitPoint); this.updateReelMode(); } })` — fire + immediate reel-mode update so reel-in engages on the same frame when Space is already held (current main.ts:495).
- `input.onRelease(() => this.grapple.release())`
- `input.onRespawn(() => this.lifecycle.forceRespawn())`
- `input.onChange(() => this.updateReelMode())`
- `input.onPointerLockClick(() => { if (!this.tpCamera.isLocked) this.tpCamera.lock(); })` — preserves the `!isLocked` guard from current main.ts:487 so we don't re-request lock on an already-locked element.

### `game-loop.ts`
```ts
export interface LoopHooks {
  preFrame?(frameDt: number): void;      // runs ONCE per frame, before substep loop. grapple.update lives here.
  preStep?(dt: number): void;            // per-substep, ordered: motors → impulse → preStepVel sample → cachePrevForInterp
  postStep?(dt: number): void;           // per-substep: collision.drain → ragdoll.updateSpeed → multiplayer.maybeSendPose
  preRender?(dt: number, alpha: number): void;
  render(dt: number, alpha: number): void;
}
export function startLoop(opts: {
  world: RAPIER.World;
  eventQueue: RAPIER.EventQueue;
  fixedDt: number;
  maxSubsteps: number;
  hooks: LoopHooks;
  onFrame?(rawWallMs: number): void;     // UNCLAMPED wall time, for PerfHud sampling
  onSubstepClamp?(): void;               // for Multiplayer.resetSendAccumulator
}): { stop(): void; setActive(active: boolean): void; readonly isActive: boolean };
```

**Hook ordering contract** (load-bearing, do not relax):
- `preFrame` runs once before the substep while-loop. `grapple.update(frameDt)` MUST be here, not in `preStep` — calling it per-substep would break reel physics (currently main.ts:305, called once before the loop at main.ts:308).
- `preStep` is single-owner (LocalPlayer.preStep). Internal ordering specified in the `local-player.ts` section above; the contract from the loop's perspective is: world.step happens immediately after preStep returns, with no other loop work in between.
- `postStep` runs after `world.step`. The loop does NOT call `collision.drain` itself — it has no `CollisionContext` to pass. Bootstrap's `postStep` body owns the drain: `collision.drain(eventQueue, collisionCtx()) → ragdoll.updateSpeed(dt) → multiplayer?.maybeSendPose(dt)`. The loop only exposes `eventQueue` to bootstrap via closure.
- Loop owns its own `accumulator`. On substep clamp (`steps === MAX_SUBSTEPS`), loop zeros accumulator (so render alpha=0 → fresh state) AND fires `onSubstepClamp` so Multiplayer can reset its send accumulator.
- **`onFrame(rawWallMs)` fires with the UNCLAMPED wall time** — computed as `(now - last) * 1000` BEFORE the loop applies its `> 0.25s` clamp to `frameTime`. This matches current main.ts:280–282 (the comment on line 280 is load-bearing: PerfHud must see real stalls, not a flat 250 ms ceiling).

`setActive(false)` is the pre-spawn path: skip substep loop entirely (no preFrame, preStep, world.step, postStep), still call `preRender` + `render`. Pre-spawn render subset must match main.ts:286–295 exactly: cloudLayer.update, orb.tick (animation only — NO entry detection), multiplayer?.update, renderer.render, labelRenderer.render. The `preRender` hook in bootstrap branches on `loop.isActive` to gate the active-only work.

Spike diagnostic + `__t` breakdown dropped (Q5 resolution).

### `welcome-modal.ts`
```ts
export function showWelcomeModal(opts: {
  onPlay(): void;
}): { hide(): void; markReady(): void };
```
Owns play button DOM + text. `markReady()` toggles "Connecting…" → "Play" and enables the button. Bootstrap renders behind it; modal only gates input handoff (camera lock, respawn, `setActive(true)`).

### `banner.ts` (new, small)
```ts
export function showTransientBanner(text: string, durationMs?: number): void;
```
6-line CSS+timeout currently inlined at main.ts:465–484 (MP failure path). Keeps bootstrap free of DOM strings.

### `bootstrap.ts`
```ts
export async function bootstrap(): Promise<void>;
```
Sequence:
1. `await RAPIER.init()`
2. `graphics = createGraphics()` (includes cloudLayer)
3. Build world, lattice, orb, ragdoll, tpCamera, reticle, grapple, confetti, lifecycle, leaderboardHud, devDummy, perfHud
4. `sky = createSkyController({ scene, hemiLight, cloudLayer })`; if DEV, `wireDevHud(sky)`
5. `input = createInputController(renderer.domElement)`; `localPlayer = new LocalPlayer({ ragdoll, grapple, lifecycle, tpCamera, input })`
6. Wire `orb.onPlayerEnter(() => sky.advanceHorizon())`
7. Build `collisionCtx` (closure pattern unchanged, reads `localPlayer.preStepVel`, `multiplayer`, `devDummy`, `confetti` from bootstrap scope)
8. `loop = startLoop({ ..., hooks: { preFrame, preStep, postStep, preRender, render }, onFrame: ms => perfHud?.sample(ms), onSubstepClamp: () => multiplayer?.resetSendAccumulator() })`; `loop.setActive(false)`
9. `modal = showWelcomeModal({ onPlay: () => { ragdoll.respawn(randomSpawnPoint()); ragdoll.setVisible(true); tpCamera.lock(); loop.setActive(true); modal.hide(); } })`
10. `initDiscord()` (try/catch). On success: `ragdoll.material.color.setHex(colorFromUserId(userId))`, `multiplayer = new Multiplayer({ ..., grapple })`, `multiplayer.connect().catch(err => showTransientBanner('Multiplayer unavailable — playing solo'))`
11. `modal.markReady()`

Hook bodies in bootstrap:
- `preFrame(dt) { grapple.update(dt); }`
- `preStep(dt) { localPlayer.preStep(); }` (LocalPlayer handles motors/impulse/preStepVel/cachePrevForInterp ordering internally)
- `postStep(dt) { collision.drain(eventQueue, collisionCtx()); ragdoll.updateSpeed(dt); multiplayer?.maybeSendPose(dt); }`
- `preRender(dt, alpha) { const now = performance.now() / 1000; cloudLayer.update(now); const orbTime = multiplayer ? multiplayer.roomTime : now; if (loop.isActive) { lifecycle.tick(performance.now()); localPlayer.checkRespawn(); ragdoll.sync(alpha); const torsoPos = ragdoll.torso.translation(); orb.checkEntry(torsoPos); orb.tick(orbTime); sky.update(dt); grapple.syncLine(alpha); tpCamera.update(dt, ragdoll.getInterpolatedTranslation('torso', alpha, __tmpInterpTorso)); reticle.update(camera); ragdoll.trail.update(dt); } else { orb.tick(orbTime); } multiplayer?.update(dt); if (multiplayer) leaderboardHud.update(multiplayer.getLeaderboardEntries()); devDummy?.update(performance.now(), dt); perfHud?.setSpeed(ragdoll.smoothedSpeed); confetti.update(dt); }`
- `render() { renderer.render(scene, camera); labelRenderer.render(scene, camera); }`

`buildCollisionCtx` captures `localPlayer.preStepVel` by reference ONCE at construction (`vel: localPlayer.preStepVel`) — same in-place-mutation pattern as today's `preStepLocalVel`.

`main.ts` becomes: `bootstrap().catch(showFatalError)`.

### `Multiplayer` changes (Q4)
- Constructor takes `grapple: Grapple` (in addition to existing `localRagdoll`).
- Owns `sendAccumulator` + `POSE_SEND_INTERVAL_S` (moved from main.ts).
- `maybeSendPose(dt: number): void` — increments accumulator, encodes + sends on tick.
- `resetSendAccumulator(): void` — called by loop on substep clamp.

## Open questions for review

1. **~~`sky-controller` ownership of orb-entry detection~~** — RESOLVED: orb owns entry detection, exposes `onPlayerEnter`, sky exposes `advanceHorizon()`. Bootstrap wires the two.
2. **~~`movement.ts` vs inlining~~** — RESOLVED: neither. `local-player.ts` owns `applyMovementImpulse` and `updateReelMode` together; one cohesive class.
3. **~~Collision context construction~~** — RESOLVED: no change. Move `buildCollisionCtx` + `collisionCtx` into `bootstrap.ts` unchanged; closures over `multiplayer`/`devDummy`/`confetti` keep working because all live in bootstrap's scope.
4. **~~Pose send cadence~~** — RESOLVED: fold into `Multiplayer`. Add `maybeSendPose(dt)` + `resetSendAccumulator()`. Loop calls `multiplayer?.maybeSendPose(FIXED_DT)` from `postStep` and `multiplayer?.resetSendAccumulator()` on substep clamp. `sendAccumulator` + `POSE_SEND_INTERVAL_S` move into `Multiplayer`.
5. **~~Spike HUD~~** — RESOLVED: drop entirely. `__t` accounting, `__mark()`, `SPIKE_MS` console.warn, and the per-phase breakdown all go. `PerfHud` keeps its frame-time sampling via loop's `onFrame(wallMs)` callback.

## Acceptance check

- `main.ts` < 100 lines ✓ (target ~10: just `bootstrap().catch(...)`)
- Single responsibility per module ✓
- Behavior unchanged — verify by playing the game; smoke-test orb sky cycle, dash double-tap, grapple, respawn, MP connect failure banner
- Constants from `constants.ts` — no new magics introduced
- Collision DI — already done (#15)

## Invariant assertions (DEV-only)

`LocalPlayer.preStep()` is order-sensitive and silent on regression. In DEV builds, add lightweight asserts to catch reorder mistakes:

- Bump a per-substep counter in `LocalPlayer.preStep()` and assert in `game-loop.ts` (immediately before `world.step`) that `preStep` ran exactly once this substep.
- Have `ragdoll.cachePrevForInterp()` set a `_cachedThisSubstep` flag (cleared after `world.step`); assert it's true at the top of `world.step` invocation in the loop.
- Have `collision.drain` assert that `localRagdoll.vel` was mutated in the current substep (set a tick-tag on each in-place write in `LocalPlayer.preStep`, check it in drain).

All three are `if (import.meta.env.DEV)` guarded so production has zero overhead. Goal: a misorder during refactor throws loudly instead of silently corrupting interpolation or knockback.
