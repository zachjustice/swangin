import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { initDiscord, displayName } from './discord.ts';
import { buildLattice, addSpawnMarker, SPAWN_POINT } from './world.ts';
import { createRagdoll } from './ragdoll.ts';
import { ThirdPersonCamera } from './third-person-camera.ts';
import { CubeReticle } from './reticle.ts';
import { Grapple } from './grapple.ts';
import { Multiplayer, colorFromUserId } from './multiplayer.ts';
import { encodePose } from './pose-codec.ts';
import { createOrb } from './orb.ts';
import { createCloudLayer } from './sky-clouds.ts';
import { MOVE_IMPULSE, MOVE_MAX_SPEED } from './constants.ts';

const SKY = 0x3a5a8a;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

const RESPAWN_Y = -15;
const WORLD_HALF = 30;
const POSE_SEND_HZ = 20;

const prompt = document.getElementById('prompt') as HTMLDivElement;

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

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const cloudLayer = createCloudLayer(scene);

// CSS2D layer for name labels — positioned absolutely over the WebGL canvas,
// transparent and pointer-event-disabled so it doesn't intercept clicks.
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.left = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x5a6a8a, 1.4));
const dir = new THREE.DirectionalLight(0xfff4e0, 1.5);
dir.position.set(20, 40, 10);
scene.add(dir);

// EffectComposer pipeline: scene render → UnrealBloomPass. Composer owns final
// blit to screen; CSS2DRenderer stays a separate DOM overlay so labels render
// crisp without going through bloom.
const composer = new EffectComposer(renderer);
composer.setPixelRatio(window.devicePixelRatio);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
// strength, radius, threshold — only pixels above ~0.85 luminance bloom, so
// the orb fragment shader's 1.6× multiplier and rim boost are what bleed.
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.45, 0.4, 0.95,
);
composer.addPass(bloomPass);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = FIXED_DT;

const { count: cubeCount } = buildLattice(scene, world);
addSpawnMarker(scene);
console.log(`[world] ${cubeCount} cubes built`);

const orb = createOrb(scene, new THREE.Vector3(0, 0, 0));

const ragdoll = createRagdoll(scene, world, SPAWN_POINT);

const tpCamera = new ThirdPersonCamera(camera, renderer.domElement, ragdoll.torso);
const reticle = new CubeReticle(scene, world);
const grapple = new Grapple(scene, world, ragdoll.grappleHand, ragdoll.handLocalOffset);

let userLabel = '…';
const keys = { w: false, a: false, s: false, d: false };

let last = performance.now() / 1000;
let accumulator = 0;

function checkRespawn() {
  const t = ragdoll.torso.translation();
  const oob =
    t.y < RESPAWN_Y ||
    Math.abs(t.x) > WORLD_HALF ||
    Math.abs(t.z) > WORLD_HALF;
  if (!oob) return;
  grapple.release();
  ragdoll.respawn(SPAWN_POINT);
}

function applyMovementImpulse() {
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

// Multiplayer state — assigned after auth resolves below; tick() guards on null.
let multiplayer: Multiplayer | null = null;

function tick() {
  const now = performance.now() / 1000;
  let frameTime = now - last;
  last = now;
  if (frameTime > 0.25) frameTime = 0.25;
  accumulator += frameTime;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
    ragdoll.motors.grappleAnchor = grapple.isActive ? grapple.anchorPos : null;
    ragdoll.motors.update(FIXED_DT);
    applyMovementImpulse();
    world.step();
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_SUBSTEPS) accumulator = 0;

  cloudLayer.update(now);

  checkRespawn();
  ragdoll.sync();
  grapple.update();
  tpCamera.update(frameTime);
  reticle.update(camera);
  multiplayer?.update();
  orb.update(multiplayer ? multiplayer.roomTime : performance.now() / 1000);

  composer.render();
  labelRenderer.render(scene, camera);
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
    userLabel = `Hello, ${userName}`;
  } else {
    userLabel = 'Standalone';
  }
} catch (e) {
  userLabel = `Auth failed: ${String(e)}`;
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
});

multiplayer.connect().then(() => {
  // Broadcast full ragdoll pose at 20 Hz; remotes interpolate ~100 ms in the past.
  setInterval(() => {
    if (!multiplayer) return;
    const grappleAnchor = grapple.isActive ? grapple.anchorPos : null;
    multiplayer.sendPose(encodePose(ragdoll.poseBodies, grapple.isActive, grappleAnchor));
  }, Math.round(1000 / POSE_SEND_HZ));
}).catch((err) => {
  console.error('[mp] failed to join room', err);
  userLabel = `${userLabel} · MP failed`;
});

prompt.hidden = true;

renderer.domElement.addEventListener('click', () => {
  if (!tpCamera.isLocked) tpCamera.lock();
});

renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !tpCamera.isLocked) return;
  if (reticle.hitPoint) grapple.fire(reticle.hitPoint);
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) grapple.release();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') {
    grapple.release();
    ragdoll.respawn(SPAWN_POINT);
  } else if (e.code === 'KeyW') {
    keys.w = true;
  } else if (e.code === 'KeyA') {
    keys.a = true;
  } else if (e.code === 'KeyS') {
    keys.s = true;
  } else if (e.code === 'KeyD') {
    keys.d = true;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyW') keys.w = false;
  else if (e.code === 'KeyA') keys.a = false;
  else if (e.code === 'KeyS') keys.s = false;
  else if (e.code === 'KeyD') keys.d = false;
});
