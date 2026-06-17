import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { initDiscord, displayName } from './discord.ts';
import { buildLattice, addSpawnMarker, SPAWN_POINT } from './world.ts';
import { createRagdoll } from './ragdoll.ts';
import { ThirdPersonCamera } from './third-person-camera.ts';
import { CubeReticle } from './reticle.ts';
import { Grapple } from './grapple.ts';
import { Multiplayer, colorFromUserId } from './multiplayer.ts';
import { encodePose } from './pose-codec.ts';
import { createOrb, ORB_RADIUS } from './orb.ts';
import { createCloudLayer } from './sky-clouds.ts';
import { MOVE_IMPULSE, MOVE_MAX_SPEED, GRAPPLE_REEL_DOUBLE_TAP_MS, SKY, SKY_ZENITH, ROYGBIV, SKY_TRANSITION_DURATION, FIXED_DT, MAX_SUBSTEPS, RESPAWN_Y, WORLD_HALF, POSE_SEND_HZ } from './constants.ts';
import { Collision, type CollisionContext } from './collision.ts';
import { Confetti } from './confetti.ts';
import { PlayerLifecycle } from './lifecycle.ts';
import { DevDummy } from './dev-dummy.ts';
import { PerfHud } from './perf-hud.ts';
import { LATTICE_TOP_Y, CUBE_SIZE } from './world.ts';

let skyIndex = 4;
const skyFrom = new THREE.Color(SKY);
const skyTo = new THREE.Color(SKY);
const skyCurrent = new THREE.Color(SKY);
const skyZenithCurrent = new THREE.Color(SKY_ZENITH);
let skyT = 1.0;

// Picker is optional — index.html may comment it out for production.
const horizonInput = document.getElementById('sky-horizon') as HTMLInputElement | null;
const zenithInput = document.getElementById('sky-zenith') as HTMLInputElement | null;

horizonInput?.addEventListener('input', () => {
  skyT = 1.0;
  skyCurrent.set(horizonInput.value);
  scene.background = skyCurrent;
  (scene.fog as THREE.Fog).color.copy(skyCurrent);
  cloudLayer.setSkyColors(skyCurrent, skyZenithCurrent);
});

zenithInput?.addEventListener('input', () => {
  skyZenithCurrent.set(zenithInput.value);
  hemiLight.color.copy(skyZenithCurrent);
  cloudLayer.setSkyColors(skyCurrent, skyZenithCurrent);
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 30, 120);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  500,
);
camera.position.copy(SPAWN_POINT).add(new THREE.Vector3(6, 0, 6));
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.75;
document.body.appendChild(renderer.domElement);

const cloudLayer = createCloudLayer(scene);
cloudLayer.setSkyColors(skyCurrent, skyZenithCurrent);

// CSS2D layer for name labels — positioned absolutely over the WebGL canvas,
// transparent and pointer-event-disabled so it doesn't intercept clicks.
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.left = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

const hemiLight = new THREE.HemisphereLight(0xbfd4ff, 0x5a6a8a, 0.5);
hemiLight.color.copy(skyZenithCurrent);
scene.add(hemiLight);

// ambient lighting from everywhere
const light = new THREE.AmbientLight(0xfff4e0, .65);
scene.add(light);
// a tasteful amount of shadows
const dir = new THREE.DirectionalLight(0xfff4e0, 0.3);
dir.position.set(0, 18, 0);
scene.add(dir);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = FIXED_DT;
// 8 iterations vs the default 4 keeps joint constraints convergent at the
// high velocities the grapple can produce. Paired with the per-body speed
// cap in the substep loop below.
world.numSolverIterations = 8;
// Event queue for cross-player collision events. drained each substep by
// collision.drain after world.step(eventQueue).
const eventQueue = new RAPIER.EventQueue(true);
const collision = new Collision();

const { count: cubeCount } = buildLattice(scene, world);
addSpawnMarker(scene);
console.log(`[world] ${cubeCount} cubes built`);

const orb = createOrb(scene, new THREE.Vector3(0, 0, 0));

const ragdoll = createRagdoll(scene, world, SPAWN_POINT, collision);
let spawned = false;
ragdoll.setVisible(false);

const tpCamera = new ThirdPersonCamera(camera, renderer.domElement, ragdoll.torso);
const reticle = new CubeReticle(scene, world);
const grapple = new Grapple(scene, world, ragdoll.grappleHand, ragdoll.handLocalOffset);

const confetti = new Confetti(scene);

// Dev-only static dummy hanging from the bottom face of the top-center cube
// (world y = LATTICE_TOP_Y, which is the cube CENTER, so attach at top - halfExtent).
// Hang length is tuned so the dummy's feet stay clear of the next-layer cube
// tops; adjust if proportions change.
let devDummy: DevDummy | null = null;
let devSpeedHud: HTMLDivElement | null = null;
let perfHud: PerfHud | null = null;
if (import.meta.env.DEV) {
  perfHud = new PerfHud();
  devSpeedHud = document.createElement('div');
  devSpeedHud.style.cssText = [
    'position: fixed',
    'top: 8px',
    'right: 12px',
    'color: #000',
    'font: 700 16px ui-monospace, SFMono-Regular, Menlo, monospace',
    'pointer-events: none',
    'z-index: 10',
  ].join(';');
  document.body.appendChild(devSpeedHud);
}

// Multiplayer state — assigned after auth resolves below; tick() guards on null.
let multiplayer: Multiplayer | null = null;

// Lifecycle is constructed up front but depends on multiplayer at the moment
// of sendDied. The closure reads `multiplayer` at call time so we don't need
// to construct lifecycle behind the auth promise.
const lifecycle = new PlayerLifecycle({
  ragdoll,
  grapple,
  multiplayer: {
    sendDied: (killer: string, x: number, y: number, z: number) => {
      multiplayer?.sendDied(killer, x, y, z);
    },
  },
  confetti,
  spawnPoint: SPAWN_POINT,
});

let wasInsideOrb = false;

const keys = { w: false, a: false, s: false, d: false, space: false, shiftLeft: false, shiftRight: false };
let lastSpaceDownTime = -Infinity;
let dashArmed = false;

function updateReelMode(): void {
  if (!grapple.isActive) {
    grapple.setReelMode({ direction: null, dash: false });
    return;
  }
  if (keys.space) {
    grapple.setReelMode({ direction: 'in', dash: dashArmed });
  } else if (keys.shiftLeft || keys.shiftRight) {
    grapple.setReelMode({ direction: 'out', dash: false });
  } else {
    grapple.setReelMode({ direction: null, dash: false });
  }
}

let last = performance.now() / 1000;
let accumulator = 0;
// Pose send is driven from the fixed-step substep loop so the cadence stays
// locked to physics regardless of tab throttling or frame-rate drift. Each
// substep adds FIXED_DT; when the bucket fills past POSE_SEND_INTERVAL_S the
// current pose is broadcast and the bucket drains by one interval.
const POSE_SEND_INTERVAL_S = 1 / POSE_SEND_HZ;
let sendAccumulator = 0;

function checkRespawn() {
  if (!spawned) return;
  const t = ragdoll.torso.translation();
  const oob =
    t.y < RESPAWN_Y ||
    Math.abs(t.x) > WORLD_HALF ||
    Math.abs(t.z) > WORLD_HALF;
  if (!oob) return;
  lifecycle.forceRespawn();
}

function applyMovementImpulse() {
  if (!lifecycle.canControl()) return;
  if (!keys.w && !keys.a && !keys.s && !keys.d) return;
  const yaw = tpCamera.yaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let dx = 0, dz = 0;
  if (keys.w) { dx += fx; dz += fz; }
  if (keys.s) { dx -= fx; dz -= fz; }
  if (keys.d) { dx += rx; dz += rz; }
  if (keys.a) { dx -= rx; dz -= rz; }
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len === 0) return;
  dx /= len; dz /= len;
  const v = ragdoll.torso.linvel();
  if (Math.sqrt(v.x ** 2 + v.z ** 2) >= MOVE_MAX_SPEED) return;
  ragdoll.torso.applyImpulse({ x: dx * MOVE_IMPULSE, y: 0, z: dz * MOVE_IMPULSE }, true);
}

// Local torso linvel sampled BEFORE world.step() each substep — used by
// collision.drain to compute closing speed along the contact normal. After
// the step Rapier has already absorbed some of the impact, so the post-step
// vector systematically under-estimates the hit; sampling pre-step keeps the
// knockback proportional to the actual approach.
const preStepLocalVel = { x: 0, y: 0, z: 0 };

// Collision context: rebuilt each drain call so multiplayer / lifecycle stay
// fresh. cheap — just object literal allocation. The dev dummy is merged
// into getPeer's lookup so the collision rule sees it the same way it sees
// a real Colyseus peer.
function collisionCtx(): CollisionContext {
  return {
    localRagdoll: {
      smoothedSpeed: ragdoll.smoothedSpeed,
      torso: ragdoll.torso,
      vel: preStepLocalVel,
    },
    lifecycle,
    getPeer: (sid) => {
      const real = multiplayer?.getPeer(sid);
      if (real) return real;
      if (devDummy && devDummy.sessionId === sid) return devDummy;
      return undefined;
    },
    onLocalFasterHit: devDummy
      ? (sid) => { if (devDummy && sid === devDummy.sessionId) devDummy.onHit(confetti); }
      : undefined,
    // Dummy-only: real peers move on their own machine and stream back, so
    // we don't wire this for them.
    onPeerImpulse: devDummy
      ? (sid, impulse) => { if (devDummy && sid === devDummy.sessionId) devDummy.kick(impulse); }
      : undefined,
  };
}

// Frame-spike diagnostic. When wall time between frames exceeds SPIKE_MS,
// dump a per-phase breakdown to console so we can see which section spiked.
const SPIKE_MS = 33; // anything over ~2 vsync at 60Hz
const __t = { grap: 0, phys: 0, sky: 0, scene: 0, mp: 0, fx: 0, render: 0, steps: 0 };
function __mark() { return performance.now(); }

// Scratch vector for the interpolated torso world position handed to the camera
// each frame. Reused to avoid per-frame allocation.
const __tmpInterpTorso = new THREE.Vector3();

function tick() {
  const frameStartMs = performance.now();
  const now = frameStartMs / 1000;
  let frameTime = now - last;
  last = now;
  // Sample BEFORE the 0.25s clamp so the HUD reports real stalls instead of
  // a flat 250ms ceiling whenever the tab was backgrounded or a step spiked.
  perfHud?.sample(frameTime * 1000);
  if (frameTime > 0.25) frameTime = 0.25;
  accumulator += frameTime;

  if (!spawned) {
    accumulator = 0;
    cloudLayer.update(now);
    orb.update(multiplayer ? multiplayer.roomTime : performance.now() / 1000);
    multiplayer?.update(frameTime);
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(tick);
    return;
  }

  // Substep ordering invariant:
  //   1. grapple.update() — advances reel, recreates joint, may release.
  //      Must run before motors.update() so grappleAnchor reflects the
  //      current frame's grapple state, not last frame's.
  //   2. motors.update() + world.step() — physics substeps.
  //   3. grapple.syncLine() — visual-only; must run after world.step() so
  //      the rope endpoints match post-step body positions.
  let __m = __mark();
  grapple.update(frameTime);
  __t.grap = __mark() - __m; __m = __mark();
  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
    ragdoll.motors.grappleAnchor = grapple.isActive ? grapple.anchorPos : null;
    ragdoll.motors.update(FIXED_DT);
    applyMovementImpulse();
    const v = ragdoll.torso.linvel();
    preStepLocalVel.x = v.x; preStepLocalVel.y = v.y; preStepLocalVel.z = v.z;
    // Snapshot pre-step state for render interpolation. Must run immediately
    // before world.step so prev = (state at start of this substep) and
    // body.translation() after the loop = (state at end of last substep).
    ragdoll.cachePrevForInterp();
    if (grapple.isActive) grapple.cachePrevForInterp();
    world.step(eventQueue);
    collision.drain(eventQueue, collisionCtx());
    ragdoll.updateSpeed(FIXED_DT);
    accumulator -= FIXED_DT;
    sendAccumulator += FIXED_DT;
    if (sendAccumulator >= POSE_SEND_INTERVAL_S && multiplayer) {
      const grappleAnchor = grapple.isActive ? grapple.anchorPos : null;
      multiplayer.sendPose(encodePose(
        ragdoll.poseBodies,
        ragdoll.smoothedSpeed,
        ragdoll.linvel(),
        grapple.isActive,
        grappleAnchor,
        performance.now(),
      ));
      sendAccumulator -= POSE_SEND_INTERVAL_S;
    }
    steps++;
  }
  if (steps === MAX_SUBSTEPS) {
    accumulator = 0;
    // Don't carry over a stale send tick if we just clamped — fresh start next frame.
    sendAccumulator = 0;
  }
  __t.phys = __mark() - __m; __t.steps = steps; __m = __mark();

  // Fix-Your-Timestep render alpha: fraction of FIXED_DT past the last
  // completed substep. Clamp to [0,1] — the MAX_SUBSTEPS bail-out resets
  // accumulator to 0, so this normally stays in range, but guard anyway.
  const alpha = Math.min(1, accumulator / FIXED_DT);

  cloudLayer.update(now);

  lifecycle.tick(performance.now());
  checkRespawn();
  ragdoll.sync(alpha);

  // Orb passage detection — trigger sky cycle on entry
  {
    const tp = ragdoll.torso.translation();
    const distSq = tp.x * tp.x + tp.y * tp.y + tp.z * tp.z;
    const insideOrb = distSq < ORB_RADIUS * ORB_RADIUS;
    if (insideOrb && !wasInsideOrb) {
      skyIndex = (skyIndex + 1) % ROYGBIV.length;
      skyFrom.copy(skyCurrent);
      skyTo.setHex(ROYGBIV[skyIndex]);
      skyT = 0;
    }
    wasInsideOrb = insideOrb;
  }

  // Sky color transition — ROYGBIV cycles the horizon band only; the
  // zenith stays at whatever the user picked.
  if (skyT < 1.0) {
    skyT = Math.min(1.0, skyT + frameTime / SKY_TRANSITION_DURATION);
    skyCurrent.lerpColors(skyFrom, skyTo, skyT);
    scene.background = skyCurrent;
    (scene.fog as THREE.Fog).color.copy(skyCurrent);
    cloudLayer.setSkyColors(skyCurrent, skyZenithCurrent);
    if (horizonInput) horizonInput.value = '#' + skyCurrent.getHexString();
  }

  __t.sky = __mark() - __m; __m = __mark();

  grapple.syncLine(alpha);
  tpCamera.update(frameTime, ragdoll.getInterpolatedTranslation('torso', alpha, __tmpInterpTorso));
  reticle.update(camera);
  ragdoll.trail.update(frameTime);
  __t.scene = __mark() - __m; __m = __mark();

  multiplayer?.update(frameTime);
  __t.mp = __mark() - __m; __m = __mark();

  devDummy?.update(performance.now(), frameTime);
  if (devSpeedHud) devSpeedHud.textContent = `${ragdoll.smoothedSpeed.toFixed(1)} m/s`;
  orb.update(multiplayer ? multiplayer.roomTime : performance.now() / 1000);
  confetti.update(frameTime);
  __t.fx = __mark() - __m; __m = __mark();

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  __t.render = __mark() - __m;

  const frameMs = performance.now() - frameStartMs;
  const wallMs = frameTime * 1000;
  if (wallMs > SPIKE_MS) {
    const fmt = (n: number) => n.toFixed(1);
    console.warn(
      `[spike] wall=${fmt(wallMs)}ms js=${fmt(frameMs)}ms steps=${__t.steps} | ` +
      `grap=${fmt(__t.grap)} phys=${fmt(__t.phys)} sky=${fmt(__t.sky)} ` +
      `scene=${fmt(__t.scene)} mp=${fmt(__t.mp)} fx=${fmt(__t.fx)} render=${fmt(__t.render)}`
    );
  }

  requestAnimationFrame(tick);
}
tick();

let userId = `standalone-${Math.random().toString(36).slice(2, 10)}`;
let userName = 'Standalone';
let channelId = 'standalone';
try {
  const session = await initDiscord();
  if (session) {
    userId = session.user.id;
    userName = displayName(session.user);
    channelId = session.sdk.channelId ?? 'no-channel';
  }
} catch (e) {
  console.error(e);
}

const myColor = colorFromUserId(userId);
ragdoll.material.color.setHex(myColor);

multiplayer = new Multiplayer({
  scene,
  world,
  spawnHint: SPAWN_POINT,
  channelId,
  userId,
  name: userName,
  color: myColor,
  confetti,
  localRagdoll: ragdoll,
  collision,
});

multiplayer.connect().catch((err) => {
  console.error('[mp] failed to join room', err);
});

const welcomeModal = document.getElementById('welcome-modal') as HTMLDivElement;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
playBtn.addEventListener('click', () => {
  spawned = true;
  ragdoll.respawn(SPAWN_POINT);
  ragdoll.setVisible(true);
  welcomeModal.style.display = 'none';
  tpCamera.lock();
});

renderer.domElement.addEventListener('click', () => {
  if (!tpCamera.isLocked) tpCamera.lock();
});

renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !tpCamera.isLocked) return;
  if (!lifecycle.canControl()) return;
  if (reticle.hitPoint) {
    grapple.fire(reticle.hitPoint);
    updateReelMode();
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) grapple.release();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') {
    lifecycle.forceRespawn();
  } else if (e.code === 'KeyW') {
    keys.w = true;
  } else if (e.code === 'KeyA') {
    keys.a = true;
  } else if (e.code === 'KeyS') {
    keys.s = true;
  } else if (e.code === 'KeyD') {
    keys.d = true;
  } else if (e.code === 'Space') {
    e.preventDefault();
    if (!keys.space) {
      const now = performance.now();
      if (now - lastSpaceDownTime < GRAPPLE_REEL_DOUBLE_TAP_MS) dashArmed = true;
      lastSpaceDownTime = now;
    }
    keys.space = true;
    updateReelMode();
  } else if (e.code === 'ShiftLeft') {
    keys.shiftLeft = true;
    updateReelMode();
  } else if (e.code === 'ShiftRight') {
    keys.shiftRight = true;
    updateReelMode();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyW') keys.w = false;
  else if (e.code === 'KeyA') keys.a = false;
  else if (e.code === 'KeyS') keys.s = false;
  else if (e.code === 'KeyD') keys.d = false;
  else if (e.code === 'Space') {
    keys.space = false;
    dashArmed = false;
    updateReelMode();
  } else if (e.code === 'ShiftLeft') {
    keys.shiftLeft = false;
    updateReelMode();
  } else if (e.code === 'ShiftRight') {
    keys.shiftRight = false;
    updateReelMode();
  }
});
