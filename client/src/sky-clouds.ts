import * as THREE from 'three';

// Animated wispy cloud plane using LDR FBM noise.
// Output stays in [0,1] so it doesn't interact with the bloom pass.

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i),               hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
      v += a * noise(p);
      p = p * 2.3 + vec2(1.7, 9.2);
      a *= 0.45;
    }
    return v;
  }

  void main() {
    vec2 uv1 = vUv * 2.5 + vec2(uTime * 0.008,  uTime * 0.003);
    vec2 uv2 = vUv * 4.2 + vec2(uTime * 0.013, -uTime * 0.004);

    float n1 = fbm(uv1);
    float n2 = fbm(uv2);

    // Domain-warp n1 by n2 for wispy tendrils
    float cloud = fbm(uv1 + vec2(n2 * 0.5, n1 * 0.35));
    cloud = smoothstep(0.50, 0.73, cloud);

    // Soft radial fade so the plane edge never hard-clips
    float d = length(vUv - 0.5) * 2.0;
    cloud *= 1.0 - smoothstep(0.65, 1.0, d);

    vec3 color = mix(vec3(0.88, 0.93, 1.0), vec3(1.0, 1.0, 1.0), cloud);
    gl_FragColor = vec4(color, cloud * 0.5);
  }
`;

export interface CloudLayer {
  update(time: number): void;
  dispose(): void;
}

export function createCloudLayer(scene: THREE.Scene): CloudLayer {
  const geo = new THREE.PlaneGeometry(350, 350);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 80;
  mesh.renderOrder = 1;
  scene.add(mesh);

  return {
    update(time: number) { mat.uniforms.uTime.value = time; },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
