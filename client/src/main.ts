import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { initDiscord, displayName } from './discord.ts';
import { probePointerLock } from './pointer-lock.ts';

const DARK_BLUE = 0x0a1438;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

const banner = document.getElementById('banner') as HTMLDivElement;
const prompt = document.getElementById('prompt') as HTMLDivElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(DARK_BLUE);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(4, 4, 8);
camera.lookAt(0, 1, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202040, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(5, 8, 4);
scene.add(dir);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = FIXED_DT;

const GROUND_SIZE = 20;
const groundMesh = new THREE.Mesh(
  new THREE.BoxGeometry(GROUND_SIZE, 0.2, GROUND_SIZE),
  new THREE.MeshStandardMaterial({ color: 0x223a7a, roughness: 0.9 }),
);
groundMesh.position.y = -0.1;
scene.add(groundMesh);

const groundBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0),
);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(GROUND_SIZE / 2, 0.1, GROUND_SIZE / 2),
  groundBody,
);

const BOX_HALF = 0.5;
const boxMesh = new THREE.Mesh(
  new THREE.BoxGeometry(BOX_HALF * 2, BOX_HALF * 2, BOX_HALF * 2),
  new THREE.MeshStandardMaterial({ color: 0xff7755, roughness: 0.5, metalness: 0.1 }),
);
scene.add(boxMesh);

const boxBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0.3, 5, 0)
    .setRotation({ x: 0.1, y: 0.2, z: 0.05, w: 1 }),
);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF).setRestitution(0.2),
  boxBody,
);

function syncMeshFromBody(mesh: THREE.Object3D, body: RAPIER.RigidBody) {
  const t = body.translation();
  const r = body.rotation();
  mesh.position.set(t.x, t.y, t.z);
  mesh.quaternion.set(r.x, r.y, r.z, r.w);
}

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

  syncMeshFromBody(boxMesh, boxBody);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

try {
  const session = await initDiscord();
  if (session) {
    banner.textContent = `Hello, ${displayName(session.user)}`;
  } else {
    banner.textContent = 'Standalone mode (open via Discord Activity to test auth)';
  }
} catch (e) {
  banner.textContent = `Auth failed: ${String(e)}`;
  console.error(e);
}

prompt.hidden = false;
prompt.addEventListener('click', async () => {
  prompt.textContent = 'Requesting pointer lock…';
  const result = await probePointerLock(renderer.domElement);
  if (result.ok) {
    prompt.textContent = 'Pointer lock OK — press Esc to release';
    console.log('[pointer-lock] success');
  } else {
    prompt.textContent = `Pointer lock failed: ${result.reason} — using drag-look fallback`;
    console.warn('[pointer-lock] failed:', result.reason);
  }
});
