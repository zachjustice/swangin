import * as THREE from 'three';

const DARK_BLUE = 0x0a1438;

const scene = new THREE.Scene();
scene.background = new THREE.Color(DARK_BLUE);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(0, 1, 4);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202040, 0.6);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(3, 5, 2);
scene.add(dir);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0xff7755, roughness: 0.5, metalness: 0.1 }),
);
scene.add(cube);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
function tick() {
  const dt = clock.getDelta();
  cube.rotation.x += dt * 0.7;
  cube.rotation.y += dt * 1.1;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();
