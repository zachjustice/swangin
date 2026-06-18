import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// Locked world parameters (PLAN.md):
//   20×20×20 lattice, cube edge a bit smaller than the player,
//   pitch 3–4× cube size, central spherical pocket carved.
export const LATTICE_N = 4;
export const CUBE_SIZE = 1;
export const LATTICE_PITCH = 3.0;
export const POCKET_RADIUS = LATTICE_PITCH * 1.05;

// Top of the topmost cube along +Y; spawn sits 5 above this. Spawn is offset
// in X/Z so it's directly above a kept cube column rather than the central
// pocket void — otherwise the ragdoll falls straight through.
const halfExtent = CUBE_SIZE / 2;
const latticeHalfSpan = ((LATTICE_N - 1) * LATTICE_PITCH) / 2;
export const LATTICE_TOP_Y = latticeHalfSpan + halfExtent;
export const SPAWN_POINT = new THREE.Vector3(
  LATTICE_PITCH,
  LATTICE_TOP_Y + 5,
  LATTICE_PITCH,
);

export interface LatticeBuild {
  mesh: THREE.InstancedMesh;
  count: number;
}

// Deterministic — every client builds the identical world.
export function buildLattice(scene: THREE.Scene, world: RAPIER.World): LatticeBuild {
  const geometry = new RoundedBoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE, 4, 0.08)
  const material = new THREE.MeshStandardMaterial({
    color: 0xd9ddf9,
    roughness: 0.5,
    metalness: 0.3,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, 2000);
  const dummy = new THREE.Object3D();

  const colliderBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  let i = 0;
  const pocketSq = POCKET_RADIUS * POCKET_RADIUS;
  for (let ix = 0; ix < LATTICE_N; ix++) {
    const x = (ix - (LATTICE_N - 1) / 2) * LATTICE_PITCH;
    for (let iy = 0; iy < LATTICE_N; iy++) {
      const y = (iy - (LATTICE_N - 1) / 2) * LATTICE_PITCH;
      for (let iz = 0; iz < LATTICE_N; iz++) {
        const z = (iz - (LATTICE_N - 1) / 2) * LATTICE_PITCH;
        if (x * x + y * y + z * z < pocketSq) continue;

        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        world.createCollider(
          RAPIER.ColliderDesc.cuboid(halfExtent, halfExtent, halfExtent).setTranslation(x, y, z),
          colliderBody,
        );

        i++;
      }
    }
  }

  // CYLINDER
  // let i = 0;

  // const cylinderRadius = 10;
  // const cylinderHeight = 20;

  // const radialSteps = 5;
  // const angularSteps = 8;
  // const verticalSteps = 5;

  // for (let ir = 0; ir <= radialSteps; ir++) {
  //   const r = ir * LATTICE_PITCH;

  //   for (let ia = 0; ia < angularSteps; ia++) {
  //     const theta = (ia / angularSteps) * Math.PI * 2;

  //     const x = r * Math.cos(theta);
  //     const z = r * Math.sin(theta);

  //     for (let iy = 0; iy <= verticalSteps; iy++) {
  //       const y = iy * LATTICE_PITCH - cylinderHeight / 2;

  //       dummy.position.set(x, y, z);
  //       dummy.updateMatrix();
  //       mesh.setMatrixAt(i, dummy.matrix);

  //       world.createCollider(
  //         RAPIER.ColliderDesc
  //           .cuboid(halfExtent, halfExtent, halfExtent)
  //           .setTranslation(x, y, z),
  //         colliderBody,
  //       );

  //       i++;
  //     }
  //   }
  // }

  const radius = 18;
  const count = 150;

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let k = 0; k < count; k++) {
    const t = k / (count - 1);

    const y = 1 - 2 * t;
    const r = Math.sqrt(1 - y * y);

    const theta = k * goldenAngle;

    const x = r * Math.cos(theta);
    const z = r * Math.sin(theta);

    dummy.position.set(
      x * radius,
      y * radius,
      z * radius
    );

    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    world.createCollider(
      RAPIER.ColliderDesc
        .cuboid(halfExtent, halfExtent, halfExtent)
        .setTranslation(
          x * radius,
          y * radius,
          z * radius
        ),
      colliderBody,
    );

    i++;
  }

  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;

  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);

  return { mesh, count: i };
}

export function randomSpawnPoint(): THREE.Vector3 {
  const bound = ((LATTICE_N - 1) / 2) * LATTICE_PITCH;
  const x = (Math.random() * 2 - 1) * bound;
  const z = (Math.random() * 2 - 1) * bound;
  return new THREE.Vector3(x, LATTICE_TOP_Y + 5, z);
}
