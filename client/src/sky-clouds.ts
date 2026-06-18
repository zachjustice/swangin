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
  uniform vec3 uSkyHorizon;
  uniform vec3 uSkyZenith;

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
    for (int i = 0; i < 3; i++) {
      v += a * noise3(p);
      p = p * 2.2 + vec3(1.7, 9.2, 5.4);
      a *= 0.45;
    }
    return v;
  }

  void main() {
    // Vertical sky gradient: horizon color near the equator,
    // zenith color overhead. Softened so the band isn't a hard line.
    float gradient = smoothstep(-0.05, 0.7, vDir.y);
    vec3 sky = mix(uSkyHorizon, uSkyZenith, gradient);

    float scale = 5.0;
    vec3 p = vDir * scale + vec3(uTime * 0.018, 0.0, uTime * 0.009);

    // Single fbm call: domain-warp + per-pixel passes were dropped to keep
    // the shader cheap. The wider smoothstep band approximates the softness
    // we used to get from the extra octaves.
    float cloud = fbm(p);
    cloud = smoothstep(0.40, 0.72, cloud);

    // Fade clouds out below the horizon so they don't paint the ground
    float horizonFade = smoothstep(-0.25, 0.08, vDir.y);
    cloud *= horizonFade;

    // Cloud peak softened off pure white so it stays well below the bloom
    // threshold. Underside shade: clouds near the horizon read slightly
    // darker than clouds overhead, selling soft overhead light without
    // dimming the scene.
    float lit = mix(0.82, 1.0, smoothstep(-0.1, 0.6, vDir.y));
    vec3 peak = vec3(0.92, 0.94, 0.96) * lit;
    // 0.28 keeps cloud intensity close to the prior transparent dome.
    vec3 color = mix(sky, peak, cloud * 0.28);
    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface CloudLayer {
  update(time: number): void;
  setSkyColors(horizon: THREE.Color, zenith: THREE.Color): void;
  dispose(): void;
}

export function createCloudLayer(scene: THREE.Scene): CloudLayer {
  // Radius 450 — fills the view in all directions, stays within camera.far=500
  const geo = new THREE.SphereGeometry(450, 32, 16);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uSkyHorizon: { value: new THREE.Vector3(0.42, 0.61, 0.80) },
      uSkyZenith: { value: new THREE.Vector3(0.16, 0.36, 0.72) },
    },
    // Depth-tested sky-last: opaque cubes write depth first, then the sphere
    // only shades pixels the depth buffer still says are background. The
    // expensive FBM never runs on occluded pixels. LessEqualDepth (not the
    // default LessDepth) so the sphere passes the cleared 1.0 depth.
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Draw after all opaques so depthTest can reject occluded sky pixels.
  mesh.renderOrder = 999;
  scene.add(mesh);

  return {
    update(time: number) { mat.uniforms.uTime.value = time; },
    setSkyColors(horizon: THREE.Color, zenith: THREE.Color) {
      mat.uniforms.uSkyHorizon.value.set(horizon.r, horizon.g, horizon.b);
      mat.uniforms.uSkyZenith.value.set(zenith.r, zenith.g, zenith.b);
    },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
