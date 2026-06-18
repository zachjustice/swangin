import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { createConnection } from 'net';

// Ports to probe for an already-running Vite server (vite.config.ts defaults to 3000)
const CANDIDATE_PORTS = [3000, 3001, 3002, 3003, 3004, 5173];
const OUT_DIR = 'screenshots/current';

const ANGLES = {
  front:         { pos: { x: 0,   y: 0.25, z:  2.5 }, target: { x: 0, y: 0.25, z: 0    } },
  side:          { pos: { x: 2.5, y: 0.25, z:  0   }, target: { x: 0, y: 0.25, z: 0    } },
  back:          { pos: { x: 0,   y: 0.25, z: -2.5 }, target: { x: 0, y: 0.25, z: 0    } },
  'above-front': { pos: { x: 0.5, y: 1.8,  z:  1.8 }, target: { x: 0, y: 0.15, z: 0    } },
};

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
  });
}

async function findRunningVite() {
  for (const port of CANDIDATE_PORTS) {
    if (await isPortOpen(port)) return port;
  }
  return null;
}

// Spawn a new Vite server and resolve with the port it actually starts on.
async function spawnVite(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'dev:client'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      shell: true,
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Vite startup timed out'));
    }, timeoutMs);

    proc.stdout?.on('data', (d) => {
      const text = d.toString();
      process.stdout.write(text);
      // Vite prints "Local:   http://localhost:PORT/"
      const m = text.match(/Local:\s+http:\/\/(?:localhost|0\.0\.0\.0):(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: parseInt(m[1], 10) });
      }
    });
    proc.stderr?.on('data', (d) => process.stderr.write(d));
    proc.on('error', reject);
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  let viteProcess = null;
  let vitePort = await findRunningVite();

  if (vitePort) {
    console.log(`Using existing Vite server on port ${vitePort}`);
  } else {
    console.log('Starting Vite dev server...');
    const result = await spawnVite();
    viteProcess = result.proc;
    vitePort = result.port;
    console.log(`Vite ready on port ${vitePort}.`);
  }

  const browser = await chromium.launch({
    args: ['--enable-webgl', '--use-gl=swiftshader', '--enable-accelerated-2d-canvas'],
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page]', msg.text());
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  try {
    await page.goto(`http://localhost:${vitePort}/ragdoll-prototype.html`);
    await page.waitForFunction(() => window.__prototype?.ready === true, { timeout: 15000 });

    // Wait an extra frame after ready so the scene fully paints
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const viewportBox = await page.locator('#viewport').boundingBox();
    for (const [name, angle] of Object.entries(ANGLES)) {
      await page.evaluate(({ pos, target }) => {
        window.__prototype.setCamera(pos, target);
      }, angle);
      // Wait two animation frames so the camera and render settle
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const outPath = `${OUT_DIR}/${name}.png`;
      // Clip to the viewport div, excluding the right-hand control panel (380px)
      await page.screenshot({ path: outPath, clip: viewportBox });
      console.log(`Saved ${outPath}`);
    }

    // Second pass: turn on measurement isolation (torso + LEFT leg only),
    // re-capture front + side at a tighter framing, and emit a bounds.json
    // pinning the torso/hip/foot pixel anchors for the silhouette scorer.
    await page.evaluate(() => window.__prototype.setMeasurementMode(true));
    const bounds = {};
    for (const name of ['front', 'side']) {
      await page.evaluate(({ pos, target }) => {
        window.__prototype.setCamera(pos, target);
      }, ANGLES[name]);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // viewportBox is the screenshot crop in PAGE coords. getScreenBounds()
      // returns coords inside the renderer canvas (which fills #viewport).
      // The two coincide because #viewport sits flush at the page origin.
      bounds[name] = await page.evaluate(() => window.__prototype.getScreenBounds());
      const outPath = `${OUT_DIR}/measure-${name}.png`;
      await page.screenshot({ path: outPath, clip: viewportBox });
      console.log(`Saved ${outPath}`);
    }
    await writeFile(`${OUT_DIR}/bounds.json`, JSON.stringify(bounds, null, 2));
    console.log(`Saved ${OUT_DIR}/bounds.json`);
    await page.evaluate(() => window.__prototype.setMeasurementMode(false));
  } finally {
    await browser.close();
    if (viteProcess) viteProcess.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
