import * as THREE from 'three';

// Cloud dome: a large BackSide sphere the player is inside of, so clouds
// appear in all directions — above, sides, and below the horizon.
// Uses 3D FBM noise (no UV projection distortion) with domain warp for wisps.
// All output stays in [0,1] so it never triggers the bloom pass.

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform float uTime;

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i),               hash3(i + vec3(1,0,0)), u.x),
          mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
      mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
          mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y),
      u.z
    );
  }

  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
      v += a * noise3(p);
      p = p * 2.2 + vec3(1.7, 9.2, 5.4);
      a *= 0.45;
    }
    return v;
  }

  void main() {
    float scale = 5.0;
    vec3 p = vDir * scale + vec3(uTime * 0.018, 0.0, uTime * 0.009);

    float n1 = fbm(p);
    float n2 = fbm(p + vec3(5.2, 1.3, 2.4));

    // Domain warp: n2 distorts n1 sampling point for wispy tendrils
    float cloud = fbm(p + vec3(n2 * 0.55, n1 * 0.40, n2 * 0.30));
    cloud = smoothstep(0.45, 0.68, cloud);

    // Fade clouds out below the horizon so they don't paint the ground
    float horizonFade = smoothstep(-0.25, 0.08, vDir.y);
    cloud *= horizonFade;

    // Cloud peak softened off pure white so it stays well below the bloom
    // threshold; base tint is the hazy sky color so thin wisps blend in.
    // Underside shade: clouds near the horizon read slightly darker than
    // clouds overhead, selling soft overhead light without dimming the scene.
    float lit = mix(0.82, 1.0, smoothstep(-0.1, 0.6, vDir.y));
    vec3 peak = vec3(0.92, 0.94, 0.96) * lit;
    vec3 base = vec3(0.78, 0.84, 0.92);
    vec3 color = mix(base, peak, cloud);
    gl_FragColor = vec4(color, cloud * 0.28);
  }
`;

export interface CloudLayer {
  update(time: number): void;
  dispose(): void;
}

export function createCloudLayer(scene: THREE.Scene): CloudLayer {
  // Radius 450 — fills the view in all directions, stays within camera.far=500
  const geo = new THREE.SphereGeometry(450, 32, 16);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  return {
    update(time: number) { mat.uniforms.uTime.value = time; },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
