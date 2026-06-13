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
  private locked = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    private readonly target: RAPIER.RigidBody,
  ) {
    const t = target.translation();
    this.currentTarget.set(t.x, t.y + this.heightOffset, t.z);

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.mouseSensitivity;
      this.pitch += e.movementY * this.mouseSensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === domElement;
    });

    this.placeCameraImmediate();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  lock(): void {
    this.domElement.requestPointerLock();
  }

  update(dt: number): void {
    const t = this.target.translation();
    const desired = new THREE.Vector3(t.x, t.y + this.heightOffset, t.z);
    const lerpAmt = 1 - Math.exp(-this.followStiffness * dt);
    this.currentTarget.lerp(desired, lerpAmt);
    this.placeCameraImmediate();
  }

  private placeCameraImmediate(): void {
    const cosP = Math.cos(this.pitch);
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * cosP,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosP,
    ).multiplyScalar(this.distance);
    this.camera.position.copy(this.currentTarget).add(offset);
    this.camera.lookAt(this.currentTarget);
  }
}
