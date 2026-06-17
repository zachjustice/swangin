// Frame-time HUD for catching stutter. Records the last N frame durations
// (ms) in a ring buffer, reports min / avg / p99 / max, and draws a sparkline
// of recent frames so spikes are visible at a glance. Average smooths over
// the full window; p99/max surface the tail-latency that mean hides.

const WINDOW = 120;
const SPARK_W = 160;
const SPARK_H = 28;
// y-axis ceiling on the sparkline (ms). Frames above this clip to the top.
const SPARK_MAX_MS = 50;

export class PerfHud {
  private root: HTMLDivElement;
  private text: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private samples = new Float32Array(WINDOW);
  private idx = 0;
  private filled = 0;
  private lastFlushMs = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position: fixed',
      'top: 8px',
      'left: 8px',
      'padding: 6px 8px',
      'background: rgba(0,0,0,0.55)',
      'color: #0f0',
      'font: 700 12px ui-monospace, SFMono-Regular, Menlo, monospace',
      'line-height: 1.35',
      'pointer-events: none',
      'z-index: 10',
      'border-radius: 4px',
      'min-width: 176px',
    ].join(';');

    this.text = document.createElement('div');
    this.canvas = document.createElement('canvas');
    this.canvas.width = SPARK_W;
    this.canvas.height = SPARK_H;
    this.canvas.style.cssText = `display:block;margin-top:4px;width:${SPARK_W}px;height:${SPARK_H}px;background:#111`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('perf-hud: 2d context unavailable');
    this.ctx = ctx;

    this.root.appendChild(this.text);
    this.root.appendChild(this.canvas);
    document.body.appendChild(this.root);
  }

  sample(frameMs: number): void {
    this.samples[this.idx] = frameMs;
    this.idx = (this.idx + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;

    // Throttle DOM/canvas updates to ~5Hz so the HUD itself doesn't perturb
    // what it's measuring. The ring buffer keeps recording every frame.
    const now = performance.now();
    if (now - this.lastFlushMs < 200) return;
    this.lastFlushMs = now;
    this.flush();
  }

  private flush(): void {
    const n = this.filled;
    if (n === 0) return;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const sorted = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = this.samples[i];
      sorted[i] = v;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    sorted.sort();
    const p99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
    const avg = sum / n;
    const fps = 1000 / avg;

    this.text.textContent =
      `${fps.toFixed(0)} fps  ${avg.toFixed(1)}ms\n` +
      `min ${min.toFixed(1)}  p99 ${p99.toFixed(1)}  max ${max.toFixed(1)}`;
    this.text.style.whiteSpace = 'pre';
    // Color-code on p99 to make stutter obvious without staring at numbers.
    this.text.style.color = p99 > 33 ? '#f55' : p99 > 20 ? '#ff0' : '#0f0';

    this.drawSpark();
  }

  private drawSpark(): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);

    // 16.6ms (60fps) reference line.
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    const yRef = SPARK_H - (16.6 / SPARK_MAX_MS) * SPARK_H;
    ctx.moveTo(0, yRef);
    ctx.lineTo(SPARK_W, yRef);
    ctx.stroke();

    ctx.strokeStyle = '#0f0';
    ctx.beginPath();
    const n = this.filled;
    const stepX = SPARK_W / WINDOW;
    // Walk samples oldest-to-newest. When the ring isn't full yet, samples
    // are laid out [0..filled); once full, oldest sits at idx.
    for (let i = 0; i < n; i++) {
      const sampleIdx = this.filled < WINDOW ? i : (this.idx + i) % WINDOW;
      const v = Math.min(this.samples[sampleIdx], SPARK_MAX_MS);
      const x = i * stepX;
      const y = SPARK_H - (v / SPARK_MAX_MS) * SPARK_H;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
