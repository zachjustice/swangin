import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  SPEED_TRAIL_START, SPEED_TRAIL_MAX,
  SPEED_TRAIL_MIN_WIDTH, SPEED_TRAIL_MAX_WIDTH,
  SPEED_TRAIL_MIN_OPACITY, SPEED_TRAIL_MAX_OPACITY,
  TRAIL_SAMPLE_INTERVAL_S, TRAIL_SAMPLES, TRAIL_TELEPORT_MAX_M,
} from './constants.ts';

// Pale-white "air lines" trailing limb extremities when the body moves fast
// enough to kill. One Line2 per anchor, one shared LineMaterial per body
// (linewidth + opacity scale uniformly with speed, so one write per body
// per frame). Anchor positions sampled at TRAIL_SAMPLE_INTERVAL_S regardless
// of render FPS so trail length-in-time is consistent across monitors.

interface Anchor {
  body: RAPIER.RigidBody;
  buf: Float32Array;   // ring buffer of (x,y,z) triples
  head: number;        // index of next slot to write (in samples, 0..TRAIL_SAMPLES)
  count: number;       // number of valid samples (0..TRAIL_SAMPLES)
  line: Line2;
  geom: LineGeometry;
  // Per-anchor flat scratch handed to LineGeometry.setPositions each frame.
  // Must be per-anchor (not shared) because setPositions stashes the Float32Array
  // by reference inside an InstancedInterleavedBuffer that the renderer reads
  // on the subsequent renderer.render() — sharing one scratch across anchors
  // would have the next anchor's overwrite corrupt the previous anchor's data
  // before the GPU upload runs.
  flat: Float32Array;
}

const SPAN = SPEED_TRAIL_MAX - SPEED_TRAIL_START;

export class SpeedTrail {
  private readonly scene: THREE.Scene;
  private readonly group: THREE.Group;
  private readonly material: LineMaterial;
  private readonly anchors: Anchor[];
  private readonly getSpeed: () => number;
  private sampleAcc = 0;

  constructor(scene: THREE.Scene, bodies: RAPIER.RigidBody[], getSpeed: () => number) {
    this.scene = scene;
    this.getSpeed = getSpeed;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.frustumCulled = false;
    this.material = new LineMaterial({
      color: 0xffffff,
      linewidth: SPEED_TRAIL_MIN_WIDTH,
      worldUnits: true,
      transparent: true,
      depthWrite: false,
      opacity: SPEED_TRAIL_MIN_OPACITY,
    });

    this.anchors = bodies.map((body) => {
      const geom = new LineGeometry();
      // Seed with a degenerate segment so the geometry has valid attribute
      // buffers; setPositions() will overwrite on the first visible frame.
      geom.setPositions([0, 0, 0, 0, 0, 0]);
      const line = new Line2(geom, this.material);
      line.frustumCulled = false;
      this.group.add(line);
      return {
        body,
        buf: new Float32Array(TRAIL_SAMPLES * 3),
        head: 0,
        count: 0,
        line,
        geom,
        flat: new Float32Array(TRAIL_SAMPLES * 3),
      };
    });

    scene.add(this.group);
  }

  update(dtSec: number): void {
    this.sampleAcc += dtSec;
    // Drain at most TRAIL_SAMPLES intervals per call so a paused tab returning
    // doesn't loop forever — the ring is full after that anyway.
    let drains = 0;
    while (this.sampleAcc >= TRAIL_SAMPLE_INTERVAL_S && drains < TRAIL_SAMPLES) {
      this.sampleAcc -= TRAIL_SAMPLE_INTERVAL_S;
      this.sampleAll();
      drains++;
    }
    if (this.sampleAcc > TRAIL_SAMPLE_INTERVAL_S * TRAIL_SAMPLES) {
      this.sampleAcc = 0;
    }

    const speed = this.getSpeed();
    if (speed < SPEED_TRAIL_START) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const t = SPAN > 0 ? Math.min(1, (speed - SPEED_TRAIL_START) / SPAN) : 1;
    this.material.linewidth = SPEED_TRAIL_MIN_WIDTH + (SPEED_TRAIL_MAX_WIDTH - SPEED_TRAIL_MIN_WIDTH) * t;
    this.material.opacity = SPEED_TRAIL_MIN_OPACITY + (SPEED_TRAIL_MAX_OPACITY - SPEED_TRAIL_MIN_OPACITY) * t;

    for (const a of this.anchors) {
      if (a.count < 2) {
        a.line.visible = false;
        continue;
      }
      a.line.visible = true;
      this.writeFlat(a);
      a.geom.setPositions(a.flat.subarray(0, a.count * 3));
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  clearAll(): void {
    for (const a of this.anchors) {
      a.head = 0;
      a.count = 0;
      a.line.visible = false;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const a of this.anchors) a.geom.dispose();
    this.material.dispose();
  }

  private sampleAll(): void {
    for (const a of this.anchors) {
      const t = a.body.translation();
      // Teleport guard: compare against the most recent sample.
      if (a.count > 0) {
        const prevIdx = (a.head - 1 + TRAIL_SAMPLES) % TRAIL_SAMPLES;
        const po = prevIdx * 3;
        const dx = t.x - a.buf[po + 0];
        const dy = t.y - a.buf[po + 1];
        const dz = t.z - a.buf[po + 2];
        if (dx * dx + dy * dy + dz * dz > TRAIL_TELEPORT_MAX_M * TRAIL_TELEPORT_MAX_M) {
          a.head = 0;
          a.count = 0;
        }
      }
      const o = a.head * 3;
      a.buf[o + 0] = t.x;
      a.buf[o + 1] = t.y;
      a.buf[o + 2] = t.z;
      a.head = (a.head + 1) % TRAIL_SAMPLES;
      if (a.count < TRAIL_SAMPLES) a.count++;
    }
  }

  // Copy ring buffer to `a.flat` in oldest→newest order.
  private writeFlat(a: Anchor): void {
    // Oldest sample lives at (head - count + TRAIL_SAMPLES) % TRAIL_SAMPLES.
    const start = (a.head - a.count + TRAIL_SAMPLES) % TRAIL_SAMPLES;
    for (let i = 0; i < a.count; i++) {
      const src = ((start + i) % TRAIL_SAMPLES) * 3;
      const dst = i * 3;
      a.flat[dst + 0] = a.buf[src + 0];
      a.flat[dst + 1] = a.buf[src + 1];
      a.flat[dst + 2] = a.buf[src + 2];
    }
  }
}
