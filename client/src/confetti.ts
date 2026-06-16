import * as THREE from 'three';
import {
  CONFETTI_COUNT, CONFETTI_LIFETIME_S,
  CONFETTI_GRAVITY, CONFETTI_DRAG,
  CONFETTI_INIT_SPEED_MIN, CONFETTI_INIT_SPEED_MAX,
} from './constants.ts';

// Confetti bursts. Single InstancedMesh of CONFETTI_COUNT tiny quads with
// per-instance position/velocity/spin/ttl tracked in plain Float32Arrays.
// JS-integrated each render frame — no physics interaction with the lattice
// (pieces pass through cubes; 1.8 s lifetime makes that imperceptible).
//
// Free-list: instances with ttl <= 0 are reusable. A burst that asks for
// more slots than free recycles the oldest. update() runs every render
// frame; burst() can be called from anywhere with a world-space position.

const PIECE_SIZE = 0.08;
const SPIN_MAX = 12.0; // rad/s
const UP_BIAS = 2.0;   // m/s added to the upward velocity component on spawn

export class Confetti {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly axis: Float32Array; // unit axis of rotation per instance
  private readonly ang: Float32Array;  // current angle, rad
  private readonly angVel: Float32Array;
  private readonly ttl: Float32Array;

  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private readonly tmpAxis = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();

  // Track per-instance "burst hue offset" so the burst reads as a coherent
  // splash of the victim's color with some variation, rather than rainbow.
  // Recomputed when slots are reused on a new burst.

  constructor(scene: THREE.Scene) {
    const geom = new THREE.PlaneGeometry(PIECE_SIZE, PIECE_SIZE * 1.6);
    // Slight bevel on the material so back-faces also render — pieces tumble.
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geom, mat, CONFETTI_COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = CONFETTI_COUNT;

    this.pos = new Float32Array(CONFETTI_COUNT * 3);
    this.vel = new Float32Array(CONFETTI_COUNT * 3);
    this.axis = new Float32Array(CONFETTI_COUNT * 3);
    this.ang = new Float32Array(CONFETTI_COUNT);
    this.angVel = new Float32Array(CONFETTI_COUNT);
    this.ttl = new Float32Array(CONFETTI_COUNT);

    // Hide everything: zero-scale matrix. setColorAt requires the buffer to
    // exist, so seed it once with a transparent color.
    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    const black = new THREE.Color(0, 0, 0);
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      this.mesh.setMatrixAt(i, zeroMat);
      this.mesh.setColorAt(i, black);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    scene.add(this.mesh);
  }

  // Spawn a burst of up to ~CONFETTI_COUNT pieces centered at (x,y,z), tinted
  // around `color` (hex). Pieces fly outward, fall under gravity, spin, fade
  // via scale-to-zero in the final 20% of their life.
  burst(x: number, y: number, z: number, color: number): void {
    // How many pieces? Use a generous fraction of the total but cap so a
    // rapid-fire double-burst doesn't completely steal all slots.
    const desired = Math.min(CONFETTI_COUNT, Math.floor(CONFETTI_COUNT * 0.85));
    const slots = this.acquireSlots(desired);

    const baseColor = this.tmpColor.setHex(color);
    const baseHSL: { h: number; s: number; l: number } = { h: 0, s: 0, l: 0 };
    baseColor.getHSL(baseHSL);

    for (let n = 0; n < slots.length; n++) {
      const i = slots[n];
      const o = i * 3;
      // Position at the burst center, with a tiny random offset so pieces
      // don't visibly z-fight in the first frame.
      this.pos[o + 0] = x + (Math.random() - 0.5) * 0.05;
      this.pos[o + 1] = y + (Math.random() - 0.5) * 0.05;
      this.pos[o + 2] = z + (Math.random() - 0.5) * 0.05;

      // Random outward direction on the unit sphere, plus an upward bias so
      // pieces arc above the burst point before falling.
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dx = r * Math.cos(t);
      const dy = u;
      const dz = r * Math.sin(t);
      const speed = CONFETTI_INIT_SPEED_MIN
        + Math.random() * (CONFETTI_INIT_SPEED_MAX - CONFETTI_INIT_SPEED_MIN);
      this.vel[o + 0] = dx * speed;
      this.vel[o + 1] = dy * speed + UP_BIAS;
      this.vel[o + 2] = dz * speed;

      // Random rotation axis.
      const au = Math.random() * 2 - 1;
      const at = Math.random() * Math.PI * 2;
      const ar = Math.sqrt(1 - au * au);
      this.axis[o + 0] = ar * Math.cos(at);
      this.axis[o + 1] = au;
      this.axis[o + 2] = ar * Math.sin(at);

      this.ang[i] = Math.random() * Math.PI * 2;
      this.angVel[i] = (Math.random() * 2 - 1) * SPIN_MAX;
      this.ttl[i] = CONFETTI_LIFETIME_S;

      // Per-instance color: jitter hue around the base, vary lightness,
      // occasional pure white for sparkle.
      let c: THREE.Color;
      if (Math.random() < 0.18) {
        c = this.tmpColor.setRGB(1, 1, 1);
      } else {
        const h = (baseHSL.h + (Math.random() - 0.5) * 0.18 + 1) % 1;
        const s = Math.min(1, Math.max(0.4, baseHSL.s + (Math.random() - 0.5) * 0.2));
        const l = Math.min(0.85, Math.max(0.35, baseHSL.l + (Math.random() - 0.5) * 0.25));
        c = this.tmpColor.setHSL(h, s, l);
      }
      this.mesh.setColorAt(i, c);
    }

    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const dampLin = Math.exp(-CONFETTI_DRAG * dt);
    const dampAng = Math.exp(-CONFETTI_DRAG * 0.6 * dt);
    let dirty = false;

    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const o = i * 3;
      const ttl = this.ttl[i];
      if (ttl <= 0) continue;

      this.vel[o + 0] *= dampLin;
      this.vel[o + 1] = this.vel[o + 1] * dampLin + CONFETTI_GRAVITY * dt;
      this.vel[o + 2] *= dampLin;

      this.pos[o + 0] += this.vel[o + 0] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;

      this.angVel[i] *= dampAng;
      this.ang[i] += this.angVel[i] * dt;

      const newTtl = ttl - dt;
      this.ttl[i] = newTtl;

      // Compose matrix: translate then rotate. Scale fades to 0 over the last 20%.
      let s = 1;
      const fadePoint = CONFETTI_LIFETIME_S * 0.2;
      if (newTtl < fadePoint) s = Math.max(0, newTtl / fadePoint);
      this.tmpAxis.set(this.axis[o + 0], this.axis[o + 1], this.axis[o + 2]);
      this.tmpQuat.setFromAxisAngle(this.tmpAxis, this.ang[i]);
      this.tmpPos.set(this.pos[o + 0], this.pos[o + 1], this.pos[o + 2]);
      this.tmpScale.set(s, s, s);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.mesh.setMatrixAt(i, this.tmpMat);
      dirty = true;

      if (newTtl <= 0) {
        // Snap to hidden on the very next frame.
        this.tmpMat.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.tmpMat);
      }
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.parent?.remove(this.mesh);
  }

  // Pick `need` slot indices. Prefer free ones (ttl <= 0); if not enough,
  // sort the in-use ones by remaining lifetime and recycle the oldest.
  private acquireSlots(need: number): number[] {
    const free: number[] = [];
    for (let i = 0; i < CONFETTI_COUNT && free.length < need; i++) {
      if (this.ttl[i] <= 0) free.push(i);
    }
    if (free.length >= need) return free;
    // Need to recycle. Collect in-use slots sorted by ascending ttl (least
    // life left first).
    const inUse: number[] = [];
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      if (this.ttl[i] > 0) inUse.push(i);
    }
    inUse.sort((a, b) => this.ttl[a] - this.ttl[b]);
    const remaining = need - free.length;
    for (let k = 0; k < remaining && k < inUse.length; k++) free.push(inUse[k]);
    return free;
  }
}
