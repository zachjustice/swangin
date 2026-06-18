import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const PITCH_LIMIT = 1.3; // ~75°, keeps gimbal sane

export class ThirdPersonCamera {
  yaw = 0;
  pitch = -0.15;
  distance = 4.5;
  heightOffset = 0.6;
  followStiffness = 12;
  mouseSensitivity = 0.0025;

  private readonly currentTarget = new THREE.Vector3();
  private readonly tmpDesired = new THREE.Vector3();
  // Per-frame offset scratch — placeCameraImmediate runs every frame; allocating
  // a fresh Vector3 there was measurable GC pressure in the camera path.
  private readonly tmpOffset = new THREE.Vector3();
  private locked = false;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onPointerLockChange: () => void;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    private readonly target: RAPIER.RigidBody,
  ) {
    const t = target.translation();
    this.currentTarget.set(t.x, t.y + this.heightOffset, t.z);

    this.onMouseMove = (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.mouseSensitivity;
      this.pitch += e.movementY * this.mouseSensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    };
    this.onPointerLockChange = () => {
      this.locked = document.pointerLockElement === domElement;
    };
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

    this.placeCameraImmediate();
  }

  dispose(): void {
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  lock(): void {
    this.domElement.requestPointerLock();
  }

  // Aim the camera so its forward axis passes through `worldPoint`. Used at
  // spawn to face the orb instead of staring down +Z.
  pointAt(worldPoint: THREE.Vector3): void {
    const t = this.target.translation();
    this.currentTarget.set(t.x, t.y + this.heightOffset, t.z);
    const dx = worldPoint.x - this.currentTarget.x;
    const dy = worldPoint.y - this.currentTarget.y;
    const dz = worldPoint.z - this.currentTarget.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    const nx = dx / len, ny = dy / len, nz = dz / len;
    this.pitch = THREE.MathUtils.clamp(Math.asin(-ny), -PITCH_LIMIT, PITCH_LIMIT);
    this.yaw = Math.atan2(-nx, -nz);
    this.placeCameraImmediate();
  }

  // `targetPos` is the interpolated world position to follow. main.ts feeds
  // the fixed-step-alpha-interpolated torso translation so the camera doesn't
  // re-introduce the substep aliasing the ragdoll interp eliminated.
  update(dt: number, targetPos: THREE.Vector3): void {
    this.tmpDesired.set(targetPos.x, targetPos.y + this.heightOffset, targetPos.z);
    const lerpAmt = 1 - Math.exp(-this.followStiffness * dt);
    this.currentTarget.lerp(this.tmpDesired, lerpAmt);
    this.placeCameraImmediate();
  }

  private placeCameraImmediate(): void {
    const cosP = Math.cos(this.pitch);
    this.tmpOffset.set(
      Math.sin(this.yaw) * cosP,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosP,
    ).multiplyScalar(this.distance);
    this.camera.position.copy(this.currentTarget).add(this.tmpOffset);
    this.camera.lookAt(this.currentTarget);
  }
}
