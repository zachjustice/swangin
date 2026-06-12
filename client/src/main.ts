import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { initDiscord, displayName } from './discord.ts';
import { buildLattice, addSpawnMarker, SPAWN_POINT } from './world.ts';
import { createRagdoll } from './ragdoll.ts';
import { ThirdPersonCamera } from './third-person-camera.ts';
import { CubeReticle } from './reticle.ts';

const DARK_BLUE = 0x0a1438;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

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

let last = performance.now() / 1000;
let accumulator = 0;

function tick() {
  const now = performance.now() / 1000;
  let frameTime = now - last;
  last = now;
  if (frameTime > 0.25) frameTime = 0.25;
  accumulator += frameTime;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
    world.step();
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps === MAX_SUBSTEPS) accumulator = 0;

  ragdoll.sync();
  tpCamera.update(frameTime);
  reticle.update(camera);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

try {
  const session = await initDiscord();
  if (session) {
    banner.textContent = `Hello, ${displayName(session.user)} — ${cubeCount} cubes · click to look around`;
  } else {
    banner.textContent = `Standalone — ${cubeCount} cubes · click to look around`;
  }
} catch (e) {
  banner.textContent = `Auth failed: ${String(e)}`;
  console.error(e);
}

prompt.hidden = true;
renderer.domElement.addEventListener('click', () => {
  if (!tpCamera.isLocked) tpCamera.lock();
});
