import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import rawConfig from './ragdoll-config.json' with { type: 'json' };
import type { RagdollConfig } from './ragdoll-proportions.ts';
import {
  buildSweepGeometry, resampleSplinesPair, sliceProfileAtY,
  profileHalfHeight, profileMaxRadius, roundedSplinePoints,
  type Spline, type Profile,
} from './ragdoll-spline-sampling.ts';
import { buildFootGeometry } from './ragdoll-visuals.ts';

// Standalone prototype: a static, parametric ragdoll hung in space with a side
// panel of sliders + 3 spline editors (torso, arm, leg). The arm and leg
// editors show a draggable horizontal joint line that splits the silhouette
// into the upper + lower physics segments (elbow / knee).
//
// The DEFAULT_CONFIG is the same JSON the live game reads (ragdoll-config.json).
// Use "Copy JSON" to take a tuned config and paste it back into the file.

type Config = RagdollConfig;
const DEFAULT_CONFIG = rawConfig as unknown as Config;

// ---------- Spline groups + resampling ----------

type CompoundLimb = 'leg';
type GroupName = 'torso' | 'arm' | CompoundLimb;

// Map a group → its two spline keys + two profile keys on the config object.
// Keeps the editor code agnostic to which body part it's editing. For leg the
// silhouette is the WHOLE limb; the joint Y (in jointKey) splits it at the knee.
// Arm is a single segment (no elbow) so it has no jointKey.
const GROUP_KEYS: Record<GroupName, {
  sideSpline:  keyof Config; frontSpline:  keyof Config;
  sideProfile: keyof Config; frontProfile: keyof Config;
  jointKey?:   keyof Config;
}> = {
  torso: { sideSpline: 'torsoSideSpline', frontSpline: 'torsoFrontSpline', sideProfile: 'torsoSideProfile', frontProfile: 'torsoFrontProfile' },
  arm:   { sideSpline: 'armSideSpline',   frontSpline: 'armFrontSpline',   sideProfile: 'armSideProfile',   frontProfile: 'armFrontProfile' },
  leg:   { sideSpline: 'legSideSpline',   frontSpline: 'legFrontSpline',   sideProfile: 'legSideProfile',   frontProfile: 'legFrontProfile',   jointKey: 'legJointY' },
};

// Resample one group's splines into matched-Y profile arrays on the config.
// Called from the editor's pointermove on every drag so the live mesh follows.
function resampleGroup(c: Config, name: GroupName) {
  const k = GROUP_KEYS[name];
  const side  = c[k.sideSpline]  as Spline | undefined;
  const front = c[k.frontSpline] as Spline | undefined;
  if (!side || !front || side.length < 2 || front.length < 2) return;
  const r = resampleSplinesPair(side, front);
  (c as unknown as Record<string, unknown>)[k.sideProfile  as string] = r.side;
  (c as unknown as Record<string, unknown>)[k.frontProfile as string] = r.front;
}

function resampleAll(c: Config) {
  (Object.keys(GROUP_KEYS) as GroupName[]).forEach((g) => resampleGroup(c, g));
}

// Seed missing splines from their profile counterparts (mostly a migration
// helper if the JSON is partial). Limbs ship with splines authored, so this
// only really fires when the user clears them somehow.
function ensureSplinesSeeded(c: Config) {
  function seedFrom(src: Profile | undefined, fallback: Spline): Spline {
    if (!src || src.length < 5) return fallback;
    const idxs = [0, Math.floor(src.length * 0.25), Math.floor(src.length * 0.5),
                  Math.floor(src.length * 0.75), src.length - 1];
    const out = idxs.map((i) => [src[i][0], src[i][1]] as [number, number]);
    out[0][0] = 0;
    out[out.length - 1][0] = 0;
    return out;
  }
  for (const g of Object.keys(GROUP_KEYS) as GroupName[]) {
    const k = GROUP_KEYS[g];
    if (!(c[k.sideSpline]) || (c[k.sideSpline] as Spline).length < 2) {
      (c as unknown as Record<string, unknown>)[k.sideSpline as string] =
        seedFrom(c[k.sideProfile] as Profile | undefined, [[0, 0.15], [0.04, 0.1], [0.038, 0], [0.036, -0.1], [0, -0.14]]);
    }
    if (!(c[k.frontSpline]) || (c[k.frontSpline] as Spline).length < 2) {
      (c as unknown as Record<string, unknown>)[k.frontSpline as string] =
        seedFrom(c[k.frontProfile] as Profile | undefined, [[0, 0.15], [0.04, 0.1], [0.038, 0], [0.036, -0.1], [0, -0.14]]);
    }
  }
}

// Resolve the upper + lower half profiles for a compound limb (arm or leg)
// from the freshly-resampled full profiles stored on the config.
function compoundHalves(c: Config, group: CompoundLimb): {
  upper: { side: Profile; front: Profile };
  lower: { side: Profile; front: Profile };
} {
  const k = GROUP_KEYS[group];
  const side  = c[k.sideProfile  as string as keyof Config] as Profile;
  const front = c[k.frontProfile as string as keyof Config] as Profile;
  const jointY = c[k.jointKey!   as keyof Config] as number;
  return sliceProfileAtY({ side, front }, jointY);
}

// ---------- Ragdoll assembly (static pose) ----------

function buildRagdoll(c: Config): { root: THREE.Group; material: THREE.Material; eyeMaterial: THREE.Material } {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(c.color),
    roughness: c.roughness,
    metalness: c.metalness,
  });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0f24 });

  // Leg is sliced at its joint Y (knee). Arm is a single segment — its full
  // profile drives one mesh from shoulder to wrist.
  const armSide  = c.armSideProfile  as Profile;
  const armFront = c.armFrontProfile as Profile;
  const leg = compoundHalves(c, 'leg');

  const armHalfH      = profileHalfHeight(armSide);
  const thighHalfH    = profileHalfHeight(leg.upper.side);
  const shinHalfH     = profileHalfHeight(leg.lower.side);

  const armR  = profileMaxRadius(armFront, armSide);
  const shinR = profileMaxRadius(leg.lower.front, leg.lower.side);

  const SHX = c.torsoRadius + armR + c.shoulderGapX;
  const SHY = c.shoulderOffsetY;
  const HX  = c.torsoRadius * c.hipOffsetXRatio;

  const torso = new THREE.Group();
  torso.add(new THREE.Mesh(
    buildSweepGeometry(c.torsoFrontProfile, c.torsoSideProfile, c.torsoRadialSegs),
    mat,
  ));
  root.add(torso);

  // Head — Y is the explicit headOffsetY (decoupled from torsoHalfHeight).
  const head = new THREE.Mesh(new THREE.SphereGeometry(c.headRadius, 20, 16), mat);
  head.position.set(0, c.headOffsetY, 0);
  const eyeR = c.headRadius * c.eyeRRatio;
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeR, 10, 8), eyeMat);
    eye.position.set(side * c.headRadius * 0.4, c.headRadius * 0.18, c.headRadius * 0.86);
    head.add(eye);
  }
  root.add(head);

  function limbMesh(front: Profile, side: Profile): THREE.Mesh {
    return new THREE.Mesh(buildSweepGeometry(front, side, c.radialSegs), mat);
  }

  // Ellipsoid joint ball at a limb seam, sized to the cross-section radii
  // (last-row x of the upper-segment profiles after recentering). Matches the
  // joint ball the live ragdoll adds in ragdoll-visuals.ts.
  function jointBall(parent: THREE.Object3D, yCenter: number,
                     upperFront: Profile, upperSide: Profile) {
    const frontR = upperFront[upperFront.length - 1][0];
    const sideR  = upperSide [upperSide .length - 1][0];
    const r = Math.max(frontR, sideR, 1e-4);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
    ball.scale.set(frontR / r, 1, sideR / r);
    ball.position.set(0, yCenter, 0);
    parent.add(ball);
  }

  // Arms: shoulder-pivoted group, single tapered mesh hangs from shoulder
  // straight to wrist (no elbow).
  for (const side of [-1, 1] as const) {
    const armGroup = new THREE.Group();
    armGroup.position.set(side * SHX, SHY, 0);
    armGroup.rotation.z = side * c.armSpread;

    const armMesh = limbMesh(armFront, armSide);
    armMesh.position.set(0, -armHalfH, 0);
    armGroup.add(armMesh);

    root.add(armGroup);
  }

  // Legs: pivot at hipOffsetY, rotate outward by legSpread.
  for (const side of [-1, 1] as const) {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * HX, c.hipOffsetY, 0);
    legGroup.rotation.z = side * c.legSpread;

    const thigh = limbMesh(leg.upper.front, leg.upper.side);
    thigh.position.set(0, -thighHalfH, 0);
    legGroup.add(thigh);

    const shin = new THREE.Group();
    shin.add(limbMesh(leg.lower.front, leg.lower.side));
    const fw = shinR * c.footW;
    const fh = shinR * c.footH;
    const fd = shinR * c.footD;
    const fr = shinR * c.footCornerRadius;
    const foot = new THREE.Mesh(buildFootGeometry(fw, fh, fd, fr), mat);
    // Top of the dome lands at footTopY (shin-local); mesh is centered, so
    // center sits half-height below that.
    foot.position.set(0, c.footTopY - fh / 2, shinR * (c.footD / 2 - 1));
    shin.add(foot);
    shin.position.set(0, -2 * thighHalfH - shinHalfH, 0);
    legGroup.add(shin);

    jointBall(legGroup, -2 * thighHalfH, leg.upper.front, leg.upper.side);

    root.add(legGroup);
  }

  return { root, material: mat, eyeMaterial: eyeMat };
}

function disposeRagdoll(r: { root: THREE.Group; material: THREE.Material; eyeMaterial: THREE.Material }) {
  r.root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      (m.geometry as THREE.BufferGeometry).dispose();
    }
  });
  r.material.dispose();
  r.eyeMaterial.dispose();
}

// ---------- UI ----------

const panel = document.getElementById('panel')!;

function section(title: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = title;
  panel.append(h);
  const div = document.createElement('div');
  panel.append(div);
  return div;
}

function row(parent: HTMLElement, label: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  l.title = label;
  r.append(l);
  parent.append(r);
  return r;
}

function slider(
  parent: HTMLElement,
  label: string,
  min: number, max: number, step: number,
  initial: number,
  onChange: (v: number) => void,
) {
  const r = row(parent, label);
  const s = document.createElement('input');
  s.type = 'range';
  s.min = String(min); s.max = String(max); s.step = String(step);
  s.value = String(initial);
  const n = document.createElement('input');
  n.type = 'number';
  n.min = String(min); n.max = String(max); n.step = String(step);
  n.value = String(initial);
  s.oninput = () => { n.value = s.value; onChange(parseFloat(s.value)); };
  n.onchange = () => { s.value = n.value; onChange(parseFloat(n.value)); };
  r.append(s, n);
}

// ---------- Spline editor widget ----------

interface EditorOptions {
  W?: number; H?: number;
  xMax?: number; yMin?: number; yMax?: number;
}

// Optional joint-line knob for compound limbs (arm/leg). When set, the editor
// draws a horizontal line at jointY that can be dragged up/down to move the
// elbow/knee. The line drives only the physics split; the silhouette itself is
// continuous across it.
interface JointBinding {
  getY: () => number;
  setY: (y: number) => void;
  onChange: () => void;
  label: string;
}

// A 2D canvas inside the right panel for editing ONE silhouette spline.
// Returns a `redraw` so the sibling editor can refresh when this one changes
// the shared top/bottom Y (endpoint Y is kept in sync within a group).
// Top & bottom handles are X-locked at 0; middle handles fully free.
function buildSplineEditor(
  parent: HTMLElement,
  config: Config,
  rebuild: () => void,
  splineKey: keyof Config,
  resample: (c: Config) => void,
  syncEndpoint: (idx: 0 | 'last', y: number) => void,
  fillColor: string,
  strokeColor: string,
  opts: EditorOptions = {},
  joint: JointBinding | null = null,
): { redraw: () => void } {
  const W = opts.W ?? 340;
  const H = opts.H ?? 420;
  const X_MAX = opts.xMax ?? 0.4;
  const Y_MIN = opts.yMin ?? -0.5;
  const Y_MAX = opts.yMax ?? 0.5;
  const PAD_X = 60, PAD_Y = 18;
  const CENTER_X = W / 2;
  const HALF_W = W / 2 - PAD_X;
  const TOP_Y = PAD_Y;
  const BOT_Y = H - PAD_Y;
  const HANDLE_R = 6;
  const HIT_R2 = 14 * 14;
  const DPR = Math.max(1, window.devicePixelRatio || 1);

  const canvas = document.createElement('canvas');
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.style.display = 'block';
  canvas.style.marginTop = '6px';
  canvas.style.background = '#131c45';
  canvas.style.border = '1px solid #2a3458';
  canvas.style.borderRadius = '3px';
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'crosshair';
  parent.append(canvas);

  const ctx = canvas.getContext('2d')!;
  ctx.scale(DPR, DPR);

  function toCanvas(x: number, y: number): [number, number] {
    return [
      CENTER_X + (x / X_MAX) * HALF_W,
      TOP_Y + ((Y_MAX - y) / (Y_MAX - Y_MIN)) * (BOT_Y - TOP_Y),
    ];
  }
  function fromCanvas(cx: number, cy: number): [number, number] {
    return [
      ((cx - CENTER_X) / HALF_W) * X_MAX,
      Y_MAX - ((cy - TOP_Y) / (BOT_Y - TOP_Y)) * (Y_MAX - Y_MIN),
    ];
  }

  function getSpline(): Spline {
    return config[splineKey] as Spline;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Sweep axis + y=0 reference.
    ctx.strokeStyle = '#1f2a52';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CENTER_X, TOP_Y);
    ctx.lineTo(CENTER_X, BOT_Y);
    const [, zeroY] = toCanvas(0, 0);
    ctx.moveTo(PAD_X * 0.5, zeroY);
    ctx.lineTo(W - PAD_X * 0.5, zeroY);
    ctx.stroke();

    const spline = getSpline();
    // Use the same rounded-cap curve the mesh resampler uses, so the on-screen
    // silhouette in the editor matches the rendered body exactly.
    const samples = roundedSplinePoints(spline, 96);

    // Mirrored silhouette fill.
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    samples.forEach((p, i) => {
      const [cx, cy] = toCanvas(p.x, p.y);
      if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    });
    for (let i = samples.length - 1; i >= 0; i--) {
      const [cx, cy] = toCanvas(-samples[i].x, samples[i].y);
      ctx.lineTo(cx, cy);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((p, i) => {
      const [cx, cy] = toCanvas(p.x, p.y);
      if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    });
    ctx.stroke();

    spline.forEach(([x, y], i) => {
      const pinned = i === 0 || i === spline.length - 1;
      const [cx, cy] = toCanvas(x, y);
      ctx.beginPath();
      ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = pinned ? '#0a1438' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = pinned ? '#9fb0e6' : '#0a1438';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    if (joint) {
      const [, jy] = toCanvas(0, joint.getY());
      ctx.save();
      ctx.strokeStyle = '#f7c948';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD_X * 0.4, jy);
      ctx.lineTo(W - PAD_X * 0.4, jy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Tab on the right edge — draggable handle.
      ctx.fillStyle = '#f7c948';
      ctx.beginPath();
      ctx.arc(W - PAD_X * 0.4, jy, HANDLE_R - 1, 0, Math.PI * 2);
      ctx.fill();

      // Label.
      ctx.fillStyle = '#f7c948';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(joint.label, W - PAD_X * 0.4 + HANDLE_R + 2, jy);
      ctx.restore();
    }
  }

  let dragIdx = -1;
  let draggingJoint = false;
  const JOINT_HIT_PX = 8;

  function hitTest(cx: number, cy: number): number {
    const spline = getSpline();
    for (let i = 0; i < spline.length; i++) {
      const [hx, hy] = toCanvas(spline[i][0], spline[i][1]);
      const dx = cx - hx, dy = cy - hy;
      if (dx * dx + dy * dy <= HIT_R2) return i;
    }
    return -1;
  }

  function localXY(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('pointerdown', (e) => {
    const [cx, cy] = localXY(e);
    dragIdx = hitTest(cx, cy);
    if (dragIdx >= 0) {
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (joint) {
      const [, jy] = toCanvas(0, joint.getY());
      if (Math.abs(cy - jy) <= JOINT_HIT_PX) {
        draggingJoint = true;
        canvas.setPointerCapture(e.pointerId);
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragIdx >= 0) {
      const spline = getSpline();
      const last = spline.length - 1;
      const [cx, cy] = localXY(e);
      let [x, y] = fromCanvas(cx, cy);
      const isEnd = dragIdx === 0 || dragIdx === last;
      if (isEnd) x = 0;
      x = Math.max(0, Math.min(X_MAX, x));
      y = Math.max(Y_MIN, Math.min(Y_MAX, y));
      spline[dragIdx] = [x, y];
      if (isEnd) syncEndpoint(dragIdx === 0 ? 0 : 'last', y);
      resample(config);
      draw();
      rebuild();
      return;
    }
    if (draggingJoint && joint) {
      const [, cy] = localXY(e);
      const [, yRaw] = fromCanvas(0, cy);
      // Clamp inside the spline's Y range, leaving a small margin so the
      // upper and lower halves each retain at least one sampled row.
      const spline = getSpline();
      const top = spline[0][1];
      const bot = spline[spline.length - 1][1];
      const margin = Math.max(1e-3, (top - bot) * 0.02);
      const y = Math.max(bot + margin, Math.min(top - margin, yRaw));
      joint.setY(y);
      joint.onChange();
      draw();
      rebuild();
    }
  });

  const endDrag = (e: PointerEvent) => {
    if (dragIdx >= 0 || draggingJoint) {
      canvas.releasePointerCapture(e.pointerId);
      dragIdx = -1;
      draggingJoint = false;
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const INSERT_HIT_PX = 12;
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    if (hitTest(cx, cy) >= 0) return;

    const spline = getSpline();
    const samples = roundedSplinePoints(spline, 200);

    let bestI = -1;
    let bestD2 = INSERT_HIT_PX * INSERT_HIT_PX;
    for (let i = 0; i < samples.length; i++) {
      const [sx, sy] = toCanvas(samples[i].x, samples[i].y);
      const dx = cx - sx, dy = cy - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestI = i; }
    }
    if (bestI < 0) return;

    const t = bestI / (samples.length - 1);
    const segCount = spline.length - 1;
    const segIdx = Math.min(segCount - 1, Math.floor(t * segCount));

    let [px, py] = fromCanvas(cx, cy);
    px = Math.max(0, Math.min(X_MAX, px));
    py = Math.max(Y_MIN, Math.min(Y_MAX, py));

    spline.splice(segIdx + 1, 0, [px, py]);
    resample(config);
    draw();
    rebuild();
  });

  draw();
  return { redraw: draw };
}

// Build a paired Side + Front editor for a group, with endpoint Y synced
// between them. For compound limbs (arm/leg) the same joint-Y line is
// rendered + draggable on both editors, kept in lockstep via JointBinding.
function buildSplinePair(
  parent: HTMLElement,
  config: Config,
  rebuild: () => void,
  group: GroupName,
  opts: EditorOptions = {},
  jointLabel?: string,
) {
  const k = GROUP_KEYS[group];
  let sideEd: { redraw: () => void } | null = null;
  let frontEd: { redraw: () => void } | null = null;
  const resample = (c: Config) => resampleGroup(c, group);

  // Shared joint binding for compound limbs. The same line shows on both
  // editors and dragging on either redraws the other.
  const jointBinding: JointBinding | null = k.jointKey ? {
    getY: () => (config as unknown as Record<string, number>)[k.jointKey as string],
    setY: (y) => { (config as unknown as Record<string, number>)[k.jointKey as string] = y; },
    onChange: () => { sideEd?.redraw(); frontEd?.redraw(); },
    label: jointLabel ?? 'joint',
  } : null;

  const sideLabel = document.createElement('div');
  sideLabel.className = 'hint';
  sideLabel.textContent = 'Side (Z extent) — drag handles, double-click to add.';
  parent.append(sideLabel);
  sideEd = buildSplineEditor(
    parent, config, rebuild, k.sideSpline, resample,
    (idx, y) => {
      const other = config[k.frontSpline] as Spline;
      other[idx === 0 ? 0 : other.length - 1] = [0, y];
      frontEd?.redraw();
    },
    'rgba(196, 85, 119, 0.18)', '#c45577', opts, jointBinding,
  );

  // Copy buttons sit between the two editors. Each makes a deep copy of one
  // spline into the other (keeps both arrays independent so subsequent edits
  // diverge again) and re-resamples + redraws.
  const copyRow = document.createElement('div');
  copyRow.style.cssText = 'display: flex; gap: 6px; margin-top: 12px;';
  function copyBetween(srcKey: keyof Config, dstKey: keyof Config, dstRedraw: () => void) {
    const src = config[srcKey] as Spline;
    (config as unknown as Record<string, unknown>)[dstKey as string] =
      src.map((p) => [p[0], p[1]] as [number, number]);
    resample(config);
    dstRedraw();
    rebuild();
  }
  const copyToFront = document.createElement('button');
  copyToFront.textContent = 'Copy Z → X';
  copyToFront.title = 'Replace the Front (X) spline with the Side (Z) spline.';
  copyToFront.style.flex = '1';
  copyToFront.onclick = () => copyBetween(k.sideSpline, k.frontSpline, () => frontEd?.redraw());

  const copyToSide = document.createElement('button');
  copyToSide.textContent = 'Copy X → Z';
  copyToSide.title = 'Replace the Side (Z) spline with the Front (X) spline.';
  copyToSide.style.flex = '1';
  copyToSide.onclick = () => copyBetween(k.frontSpline, k.sideSpline, () => sideEd?.redraw());

  copyRow.append(copyToFront, copyToSide);
  parent.append(copyRow);

  const frontLabel = document.createElement('div');
  frontLabel.className = 'hint';
  frontLabel.style.marginTop = '12px';
  frontLabel.textContent = 'Front (X extent) — flatten the middle for straight sides.';
  parent.append(frontLabel);
  frontEd = buildSplineEditor(
    parent, config, rebuild, k.frontSpline, resample,
    (idx, y) => {
      const other = config[k.sideSpline] as Spline;
      other[idx === 0 ? 0 : other.length - 1] = [0, y];
      sideEd?.redraw();
    },
    'rgba(106, 138, 255, 0.18)', '#6a8aff', opts, jointBinding,
  );
}

// Collapsible <details> for the arm / leg compound editors. Mirrors the
// torso layout but adds the joint-line draggable handle.
function addCompoundLimbSection(
  panel: HTMLElement,
  config: Config,
  rebuild: () => void,
  group: CompoundLimb,
  label: string,
  jointLabel: string,
  opts: EditorOptions,
) {
  const details = document.createElement('details');
  details.style.cssText = 'margin-top: 14px;';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = label;
  summary.style.cssText = [
    'cursor: pointer',
    'font-size: 11px',
    'font-weight: 600',
    'color: #9fb0e6',
    'text-transform: uppercase',
    'letter-spacing: 0.08em',
    'border-bottom: 1px solid #1f2a52',
    'padding-bottom: 4px',
    'margin-bottom: 6px',
    'list-style: none',
  ].join(';');
  details.append(summary);
  panel.append(details);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = `Drag the yellow line up/down to move the ${jointLabel} along the limb.`;
  details.append(hint);

  buildSplinePair(details, config, rebuild, group, opts, jointLabel);
}

// Collapsible <details> for a single-segment limb editor (arm). No joint slider.
function addSingleLimbSection(
  panel: HTMLElement,
  config: Config,
  rebuild: () => void,
  group: Exclude<GroupName, CompoundLimb | 'torso'>,
  label: string,
  opts: EditorOptions,
) {
  const details = document.createElement('details');
  details.style.cssText = 'margin-top: 14px;';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = label;
  summary.style.cssText = [
    'cursor: pointer',
    'font-size: 11px',
    'font-weight: 600',
    'color: #9fb0e6',
    'text-transform: uppercase',
    'letter-spacing: 0.08em',
    'border-bottom: 1px solid #1f2a52',
    'padding-bottom: 4px',
    'margin-bottom: 6px',
    'list-style: none',
  ].join(';');
  details.append(summary);
  panel.append(details);

  buildSplinePair(details, config, rebuild, group, opts);
}

function buildUI(config: Config, rebuild: () => void) {
  panel.innerHTML = '';

  // Proportions
  let sec = section('Proportions');
  const props: Array<[keyof Config, string, number, number, number]> = [
    ['torsoRadius',     'Torso radius (physics)',  0.05, 0.4, 0.005],
    ['torsoHalfHeight', 'Torso half-h (physics)',  0.05, 0.4, 0.005],
    ['headRadius',      'Head radius',             0.05, 0.4, 0.005],
    ['headOffsetY',     'Head Y',                  0.0,  0.8, 0.005],
    ['hipOffsetY',      'Hip Y',                  -0.5,  0.2, 0.005],
    ['shoulderGapX',    'Shoulder X gap',         -0.1,  0.2, 0.005],
    ['shoulderOffsetY', 'Shoulder Y',             -0.3,  0.4, 0.005],
    ['hipOffsetXRatio', 'Hip X (× torsoR)',        0.0,  1.5, 0.01],
  ];
  for (const [k, label, min, max, step] of props) {
    slider(sec, label, min, max, step, config[k] as number, (v) => {
      (config as unknown as Record<string, unknown>)[k as string] = v;
      rebuild();
    });
  }

  // Torso silhouettes — two splines, sampled to matched-Y profiles.
  sec = section('Torso Silhouettes');
  const torsoHint = document.createElement('div');
  torsoHint.className = 'hint';
  torsoHint.textContent = 'Side = Z extent. Front = X extent. Top/bottom Y are shared across the pair.';
  sec.append(torsoHint);
  buildSplinePair(sec, config, rebuild, 'torso');

  // Limb silhouettes. Arm is a single segment (no elbow). Leg is compound:
  // a draggable horizontal line picks where the knee splits the physics into
  // thigh + shin capsules.
  section('Limb Silhouettes');
  const armOpts: EditorOptions = { W: 280, H: 320, xMax: 0.12, yMin: -0.30, yMax: 0.30 };
  const legOpts: EditorOptions = { W: 280, H: 360, xMax: 0.15, yMin: -0.40, yMax: 0.40 };
  addSingleLimbSection(panel, config, rebuild, 'arm', 'Arm (shoulder → wrist)', armOpts);
  addCompoundLimbSection(panel, config, rebuild, 'leg', 'Leg (hip → ankle)',      'knee',  legOpts);

  // Segmentation
  sec = section('Segmentation');
  slider(sec, 'Limb radial',  6, 48, 1, config.radialSegs,
    (v) => { config.radialSegs = v | 0; rebuild(); });
  slider(sec, 'Torso radial', 6, 64, 1, config.torsoRadialSegs,
    (v) => { config.torsoRadialSegs = v | 0; rebuild(); });

  // Foot
  sec = section('Foot (× shin radius)');
  slider(sec, 'Width',         0, 4, 0.05, config.footW,           (v) => { config.footW = v; rebuild(); });
  slider(sec, 'Height',        0, 2, 0.05, config.footH,           (v) => { config.footH = v; rebuild(); });
  slider(sec, 'Depth',         0, 4, 0.05, config.footD,           (v) => { config.footD = v; rebuild(); });
  slider(sec, 'Corner radius', 0, 1, 0.01, config.footCornerRadius, (v) => { config.footCornerRadius = v; rebuild(); });
  // Direct world-Y (shin-local) of the dome apex — decouples dome top from
  // foot height so you can slide the foot up/down independently.
  slider(sec, 'Top Y (shin-local)', -0.5, 0, 0.005, config.footTopY, (v) => { config.footTopY = v; rebuild(); });

  // Head decoration
  sec = section('Head');
  slider(sec, 'Eye ratio', 0, 0.3, 0.005, config.eyeRRatio,
    (v) => { config.eyeRRatio = v; rebuild(); });

  // Static pose
  sec = section('Pose');
  slider(sec, 'Arm spread',  0, Math.PI / 2, 0.01, config.armSpread,
    (v) => { config.armSpread = v; rebuild(); });
  slider(sec, 'Leg spread', -0.5, 0.8, 0.01, config.legSpread,
    (v) => { config.legSpread = v; rebuild(); });

  // Material
  sec = section('Material');
  const r = row(sec, 'Body color');
  const ci = document.createElement('input');
  ci.type = 'color';
  ci.value = config.color;
  ci.oninput = () => { config.color = ci.value; rebuild(); };
  r.append(ci);
  slider(sec, 'Roughness', 0, 1, 0.01, config.roughness,
    (v) => { config.roughness = v; rebuild(); });
  slider(sec, 'Metalness', 0, 1, 0.01, config.metalness,
    (v) => { config.metalness = v; rebuild(); });

  // Actions
  sec = section('Actions');
  const hintRow = document.createElement('div');
  hintRow.className = 'hint';
  hintRow.textContent = 'Copy JSON → paste into src/ragdoll-config.json → save.';
  sec.append(hintRow);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy JSON';
  copyBtn.onclick = async () => {
    const text = JSON.stringify(config, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1200);
    } catch {
      console.log(text);
      copyBtn.textContent = 'Logged (clipboard denied)';
      setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 1800);
    }
  };
  const logBtn = document.createElement('button');
  logBtn.textContent = 'Log JSON';
  logBtn.onclick = () => console.log(JSON.stringify(config, null, 2));
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.onclick = () => {
    Object.assign(config, structuredClone(DEFAULT_CONFIG));
    ensureSplinesSeeded(config);
    resampleAll(config);
    buildUI(config, rebuild);
    rebuild();
  };
  actions.append(copyBtn, logBtn, resetBtn);
  sec.append(actions);
}

// ---------- Bootstrap ----------

const config: Config = structuredClone(DEFAULT_CONFIG);
ensureSplinesSeeded(config);
resampleAll(config);

const viewport = document.getElementById('viewport')!;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a5a8a);

const camera = new THREE.PerspectiveCamera(
  40,
  viewport.clientWidth / viewport.clientHeight,
  0.01, 100,
);
camera.position.set(1.4, 0.25, 1.4);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
viewport.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 0.4;
controls.maxDistance = 6;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x5a6a8a, 0.9));
const dir = new THREE.DirectionalLight(0xfff4e0, 1.5);
dir.position.set(20, 40, 10);
scene.add(dir);

let current = buildRagdoll(config);
scene.add(current.root);

function rebuild() {
  scene.remove(current.root);
  disposeRagdoll(current);
  current = buildRagdoll(config);
  scene.add(current.root);
}

buildUI(config, rebuild);

window.addEventListener('resize', () => {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
