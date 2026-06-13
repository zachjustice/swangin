import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { initDiscord, displayName } from './discord.ts';
import { buildLattice, addSpawnMarker, SPAWN_POINT } from './world.ts';
import { createRagdoll } from './ragdoll.ts';
import { ThirdPersonCamera } from './third-person-camera.ts';
import { CubeReticle } from './reticle.ts';
import { Grapple } from './grapple.ts';
import { Multiplayer, colorFromUserId } from './multiplayer.ts';

const DARK_BLUE = 0x0a1438;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

const RESPAWN_Y = -15;
const WORLD_HALF = 30;
const SLACK_MIN = 0.85;
const SLACK_MAX = 1.6;
const SLACK_STEP = 0.05;
const MOTOR_STEP = 0.1;
const MOTOR_MIN = 0;
const MOTOR_MAX = 3.0;

const banner = document.getElementById('banner') as HTMLDivElement;
const prompt = document.getElementById('prompt') as HTMLDivElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(DARK_BLUE);
scene.fog = new THREE.Fog(DARK_BLUE, 30, 120);

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
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202040, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(20, 40, 10);
scene.add(dir);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = FIXED_DT;

const { count: cubeCount } = buildLattice(scene, world);
addSpawnMarker(scene);
console.log(`[world] ${cubeCount} cubes built`);

const ragdoll = createRagdoll(scene, world, SPAWN_POINT);

const tpCamera = new ThirdPersonCamera(camera, renderer.domElement, ragdoll.torso);
const reticle = new CubeReticle(scene, world);
const grapple = new Grapple(scene, world, ragdoll.grappleHand, ragdoll.handLocalOffset);

let userLabel = '…';
let peerCount = 0;
function refreshBanner() {
  const slack = grapple.slackFactor.toFixed(2);
  const motors = ragdoll.motors.enabled
    ? ragdoll.motors.globalMultiplier.toFixed(2)
    : 'off';
  banner.textContent =
    `${userLabel} — ${cubeCount} cubes · ${peerCount} peer(s) · LMB grapple · K/L slack=${slack} · ,/. motors=${motors} · M off`;
}
refreshBanner();

let last = performance.now() / 1000;
let accumulator = 0;

function checkRespawn() {
  const t = ragdoll.torso.translation();
  const oob =
    t.y < RESPAWN_Y ||
    Math.abs(t.x) > WORLD_HALF ||
    Math.abs(t.z) > WORLD_HALF;
  if (!oob) return;
  console.warn(
    `[respawn] torso at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})`,
  );
  grapple.release();
  ragdoll.respawn(SPAWN_POINT);
}

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
    world.step();
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_SUBSTEPS) accumulator = 0;

  checkRespawn();
  ragdoll.sync();
  grapple.update();
  tpCamera.update(frameTime);
  reticle.update(camera);

  renderer.render(scene, camera);
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
refreshBanner();

const multiplayer = new Multiplayer({
  scene,
  channelId,
  userId,
  name: userName,
  color: myColor,
  onPeerCountChange: (n) => {
    peerCount = n;
    refreshBanner();
  },
});

multiplayer.connect().then(() => {
  console.log(`[mp] joined room (channelId=${channelId})`);
  // 20 Hz position broadcast — torso world position only (full pose is C10).
  setInterval(() => {
    const t = ragdoll.torso.translation();
    multiplayer.sendPosition(t.x, t.y, t.z);
  }, 50);
}).catch((err) => {
  console.error('[mp] failed to join room', err);
  userLabel = `${userLabel} · MP failed`;
  refreshBanner();
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
  if (e.code === 'KeyK') {
    grapple.slackFactor = Math.max(SLACK_MIN, grapple.slackFactor - SLACK_STEP);
    refreshBanner();
  } else if (e.code === 'KeyL') {
    grapple.slackFactor = Math.min(SLACK_MAX, grapple.slackFactor + SLACK_STEP);
    refreshBanner();
  } else if (e.code === 'Comma') {
    ragdoll.motors.globalMultiplier = Math.max(
      MOTOR_MIN,
      ragdoll.motors.globalMultiplier - MOTOR_STEP,
    );
    refreshBanner();
  } else if (e.code === 'Period') {
    ragdoll.motors.globalMultiplier = Math.min(
      MOTOR_MAX,
      ragdoll.motors.globalMultiplier + MOTOR_STEP,
    );
    refreshBanner();
  } else if (e.code === 'KeyM') {
    ragdoll.motors.enabled = !ragdoll.motors.enabled;
    refreshBanner();
  } else if (e.code === 'KeyR') {
    grapple.release();
    ragdoll.respawn(SPAWN_POINT);
  }
});
