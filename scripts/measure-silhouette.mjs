// Score the silhouette smoothness of the isolated ragdoll screenshots.
//
// Reads:
//   screenshots/current/measure-front.png   (torso + LEFT leg only)
//   screenshots/current/measure-side.png    (torso + LEFT leg only, side view)
//   screenshots/current/bounds.json         (pixel anchors from getScreenBounds)
//   client/src/ragdoll-config.json          (for the current torsoRadius)
//
// For each view, scan rows in [torsoTopPx, footBottomPx], find the LEFT and
// RIGHT silhouette edges (sub-pixel via linear interpolation between the last
// background pixel and the first foreground pixel along the row), and compute
// an RMS second-difference smoothness score on each of the four series.
// Combine with max(): a single kink anywhere fails the goal.
//
// Prints one canonical stdout line so Claude Code's /goal checker can read it:
//   SMOOTHNESS_SCORE=<x> (...) torsoRadius=<r> threshold=<t> PASS=<bool>
//
// torsoRadius bounds guard: refuses to score if torsoRadius is outside the
// ±5% band [0.114, 0.126] and exits 2.

import { readFile } from 'fs/promises';
import { PNG } from 'pngjs';

const THRESHOLD = 0.35;
const TORSO_MIN = 0.114;
const TORSO_MAX = 0.126;

// Color distance (squared euclidean RGB). A row pixel counts as foreground
// when this exceeds BG_THRESHOLD^2 against the sampled background corner.
const BG_THRESHOLD = 24;
const BG_THRESHOLD_SQ = BG_THRESHOLD * BG_THRESHOLD;

async function decodePng(path) {
  const buf = await readFile(path);
  return await new Promise((resolve, reject) => {
    new PNG().parse(buf, (err, png) => err ? reject(err) : resolve(png));
  });
}

// Returns [r, g, b] tuple of pixel (x, y).
function pixelAt(png, x, y) {
  const o = (y * png.width + x) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2]];
}

function colorDistSq(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

// Scan one row left→right. Returns the sub-pixel X where the silhouette
// starts (or null if the row is entirely background). The interpolation
// resolves the AA-blended edge to ~0.1 px so the smoothness score is not
// dominated by the integer quantization of pixel scanning.
function findLeftEdge(png, y, bg) {
  if (y < 0 || y >= png.height) return null;
  let prev = bg;
  for (let x = 0; x < png.width; x++) {
    const px = pixelAt(png, x, y);
    const d = colorDistSq(px, bg);
    if (d > BG_THRESHOLD_SQ) {
      if (x === 0) return 0;
      const prevD = Math.sqrt(colorDistSq(prev, bg));
      const curD = Math.sqrt(d);
      // Linear interp: where does the distance cross BG_THRESHOLD?
      const t = (BG_THRESHOLD - prevD) / (curD - prevD);
      return (x - 1) + Math.max(0, Math.min(1, t));
    }
    prev = px;
  }
  return null;
}

function findRightEdge(png, y, bg) {
  if (y < 0 || y >= png.height) return null;
  let prev = bg;
  for (let x = png.width - 1; x >= 0; x--) {
    const px = pixelAt(png, x, y);
    const d = colorDistSq(px, bg);
    if (d > BG_THRESHOLD_SQ) {
      if (x === png.width - 1) return png.width - 1;
      const prevD = Math.sqrt(colorDistSq(prev, bg));
      const curD = Math.sqrt(d);
      const t = (BG_THRESHOLD - prevD) / (curD - prevD);
      return (x + 1) - Math.max(0, Math.min(1, t));
    }
    prev = px;
  }
  return null;
}

// Sample the background colour from a near-corner pixel that should be safely
// outside the ragdoll silhouette (the isolation pass clears arms / head so
// (4, 4) is reliably empty in both views).
function sampleBg(png) {
  return pixelAt(png, 4, 4);
}

// 3-tap Gaussian smoothing: [1, 2, 1] / 4. Reduces single-pixel AA jitter
// without flattening real curvature (the smooth band is ~1 px wide).
function gaussSmooth(arr) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a == null) continue;
    const l = i > 0 ? arr[i - 1] : null;
    const r = i < arr.length - 1 ? arr[i + 1] : null;
    if (l != null && r != null) out[i] = (l + 2 * a + r) / 4;
    else out[i] = a;
  }
  return out;
}

// Score = MAX(|x[i-1] - 2*x[i] + x[i+1]|) — peak discrete second derivative,
// in pixels, after gentle Gaussian smoothing. A perfectly straight or smoothly
// curved line scores near 0; a localized cliff (e.g. torso bottom abruptly
// stepping inward to a narrower leg) spikes the score sharply. RMS averaging
// was too lenient here: a 1-row step is one big sample diluted by ~hundreds
// of smooth ones, and the kink the user can SEE didn't move the metric.
function peakCurvature(arr) {
  const sm = gaussSmooth(arr);
  let peak = 0;
  for (let i = 1; i < sm.length - 1; i++) {
    const a = sm[i - 1], b = sm[i], c = sm[i + 1];
    if (a == null || b == null || c == null) continue;
    const d = Math.abs(a - 2 * b + c);
    if (d > peak) peak = d;
  }
  return peak;
}

function scanColumn(png, yTop, yBot) {
  const bg = sampleBg(png);
  const y0 = Math.max(0, Math.floor(yTop));
  const y1 = Math.min(png.height - 1, Math.ceil(yBot));
  const left = [], right = [];
  for (let y = y0; y <= y1; y++) {
    left.push(findLeftEdge(png, y, bg));
    right.push(findRightEdge(png, y, bg));
  }
  return { left, right };
}

async function main() {
  const cfg = JSON.parse(await readFile('client/src/ragdoll-config.json', 'utf8'));
  const tr = cfg.torsoRadius;
  if (tr < TORSO_MIN || tr > TORSO_MAX) {
    console.log(`SMOOTHNESS_SCORE=NaN PASS=false ERROR=torsoRadius_out_of_bounds torsoRadius=${tr} bounds=[${TORSO_MIN},${TORSO_MAX}]`);
    process.exit(2);
  }
  const bounds = JSON.parse(await readFile('screenshots/current/bounds.json', 'utf8'));
  const [front, side] = await Promise.all([
    decodePng('screenshots/current/measure-front.png'),
    decodePng('screenshots/current/measure-side.png'),
  ]);

  // Stop at footTopPx so the separate foot primitive doesn't contribute its
  // own step-shaped silhouette discontinuity (which is by design, not a bug
  // we want /goal to chase).
  const f = scanColumn(front, bounds.front.torsoTopPx, bounds.front.footTopPx);
  const s = scanColumn(side, bounds.side.torsoTopPx, bounds.side.footTopPx);

  // Diagnostic: which row produces the front_L peak?
  function peakLocation(arr) {
    const sm = gaussSmooth(arr);
    let peak = 0, idx = -1;
    for (let i = 1; i < sm.length - 1; i++) {
      const a = sm[i - 1], b = sm[i], c = sm[i + 1];
      if (a == null || b == null || c == null) continue;
      const d = Math.abs(a - 2 * b + c);
      if (d > peak) { peak = d; idx = i; }
    }
    return { peak, idx, sm };
  }
  const fl = peakLocation(f.left);
  const fyTop = Math.floor(bounds.front.torsoTopPx);
  console.log(`front_L peak at row=${fyTop + fl.idx} (image-Y) val=${fl.peak.toFixed(3)}`);
  if (fl.idx >= 0) {
    for (let k = -3; k <= 3; k++) {
      const i = fl.idx + k;
      const v = fl.sm[i];
      console.log(`  row ${fyTop + i}: x=${v == null ? 'null' : v.toFixed(2)}`);
    }
  }
  const front_L = peakCurvature(f.left);
  const front_R = peakCurvature(f.right);
  const side_L = peakCurvature(s.left);
  const side_R = peakCurvature(s.right);
  const total = Math.max(front_L, front_R, side_L, side_R);
  const pass = total < THRESHOLD;

  console.log(
    `SMOOTHNESS_SCORE=${total.toFixed(3)} ` +
    `(front_L=${front_L.toFixed(3)} front_R=${front_R.toFixed(3)} ` +
    `side_L=${side_L.toFixed(3)} side_R=${side_R.toFixed(3)}) ` +
    `torsoRadius=${tr} threshold=${THRESHOLD} PASS=${pass}`
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
