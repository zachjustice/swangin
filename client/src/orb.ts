import * as THREE from 'three';

// Atmospheric orb at the lattice center: emissive sphere shading itself with a
// time-driven swirl between light-blue and light-purple. Bloom (UnrealBloomPass
// in main.ts) does the heavy lifting on glow — the material just provides a
// bright, varying surface for the pass to bleed.
//
// Animation is driven by roomTime so all clients see the same phase
// (Multiplayer.roomTime is derived from the server-broadcast startedAt).

export const ORB_RADIUS = 1.5;
const COLOR_BLUE = new THREE.Color(0x9ecbff);   // light-blue
const COLOR_PURPLE = new THREE.Color(0xc8a8ff); // light-purple

// Swirl: domain-warped sin-based pseudo-noise. Cheap, looks alive, all GPU.
const VERT = /* glsl */`
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  void main() {
    vLocalPos = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vLocalPos;
  varying vec3 vNormal;
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  float swirl(vec3 p, float t) {
    // Domain warp the input so streaks bend instead of going parallel.
    vec3 q = p + 0.5 * vec3(
      sin(p.y * 1.7 + t * 0.6),
      sin(p.z * 1.3 + t * 0.5),
      sin(p.x * 1.1 + t * 0.7)
    );
    float n =
      sin(q.x * 1.3 + t * 0.8) +
      sin(q.y * 1.7 + t * 1.1) +
      sin(q.z * 1.1 + t * 0.6);
    return 0.5 + 0.16667 * n; // / 3 / 2 to keep in roughly [0, 1]
  }

  void main() {
    float s = swirl(vLocalPos * 1.4, uTime);
    s = smoothstep(0.05, 0.95, s);
    vec3 base = mix(uColorA, uColorB, s);

    // Subtle Fresnel rim to bias bright pixels to the silhouette — gives the
    // bloom pass something with edge contrast to grab.
    float rim = pow(1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 2.0);
    vec3 col = base * (1.0 + 0.6 * rim);

    // Bloom threshold is high (~0.95) so only the brighter swirl bands bleed;
    // keep the surface itself closer to its base color.
    col *= 1.05;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface Orb {
  mesh: THREE.Mesh;
  lights: THREE.Light[];
  update(roomTime: number): void;
  dispose(): void;
}

export function createOrb(scene: THREE.Scene, center: THREE.Vector3): Orb {
  const geometry = new THREE.SphereGeometry(ORB_RADIUS, 48, 36);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: COLOR_BLUE },
      uColorB: { value: COLOR_PURPLE },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(center);
  // Non-colliding by design — no Rapier collider. PLAN.md: "atmospheric, non-colliding".
  scene.add(mesh);

  // Single point light, color-averaged between the swirl palette. A second
  // light at decay=1.7 forced a per-fragment BRDF cost on every scene
  // material; one light at linear decay roughly halves that cost while still
  // selling local glow on nearby cubes.
  const orbLight = new THREE.PointLight(0x9bb0ff, 2.0, 16, 1.0);
  orbLight.position.copy(center);
  scene.add(orbLight);

  function update(roomTime: number): void {
    material.uniforms.uTime.value = roomTime;
  }

  function dispose(): void {
    scene.remove(mesh, orbLight);
    geometry.dispose();
    material.dispose();
  }

  return { mesh, lights: [orbLight], update, dispose };
}
