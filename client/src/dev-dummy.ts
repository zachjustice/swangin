import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { createRemoteRagdoll, RemoteRagdoll } from './remote-ragdoll.ts';
import { POSE_PART_ORDER } from './ragdoll-proportions.ts';
import type { PeerSpeedInfo } from './collision.ts';
import type { Confetti } from './confetti.ts';
import { GRAPPLE_COLOR, GRAPPLE_LINE_WIDTH } from './constants.ts';

// Dev-only test target. Hangs a stationary remote ragdoll from a fixed world
// anchor by a static visible line. Registers as a "peer" with lastSpeed=0
// and lastVel=0 so the collision drain sees the local player as the
// clearly-faster party — but our collision rule is victim-authoritative, so
// the dummy normally wouldn't react. Instead the dummy listens on the
// `onLocalFasterHit` hook in CollisionContext and runs a small local-only
// death sequence (confetti + hide + auto-respawn) when struck.
//
// Not gameplay-relevant: the dummy is only constructed when
// `import.meta.env.DEV` is true.

const DUMMY_RESPAWN_MS = 2000;

export class DevDummy implements PeerSpeedInfo {
  readonly sessionId: string;
  readonly ragdoll: RemoteRagdoll;
  readonly lastSpeed = 0;
  readonly lastVel = { x: 0, y: 0, z: 0 };
  private readonly line: Line2;
  private readonly attachPoint: THREE.Vector3;
  private readonly hangPoint: THREE.Vector3;
  private readonly color: number;
  private respawnAt = 0;

  constructor(
    scene: THREE.Scene,
    world: RAPIER.World,
    attachPoint: THREE.Vector3,
    hangLength: number,
    color: number,
    name: string,
    sessionId = '__dev-dummy__',
  ) {
    this.sessionId = sessionId;
    this.color = color;
    this.attachPoint = attachPoint.clone();
    this.hangPoint = attachPoint.clone();
    this.hangPoint.y -= hangLength;

    this.ragdoll = createRemoteRagdoll(scene, world, sessionId, color, name, this.hangPoint);

    // The visual grapple line. World-units thickness so it tapers naturally
    // with distance — matches the player grapple style.
    const lineGeom = new LineGeometry();
    lineGeom.setPositions([
      this.attachPoint.x, this.attachPoint.y, this.attachPoint.z,
      this.hangPoint.x,   this.hangPoint.y,   this.hangPoint.z,
    ]);
    this.line = new Line2(
      lineGeom,
      new LineMaterial({
        color: GRAPPLE_COLOR,
        linewidth: GRAPPLE_LINE_WIDTH,
        worldUnits: true,
        transparent: true,
      }),
    );
    this.line.frustumCulled = false;
    scene.add(this.line);

    this.applyStaticPose();
  }

  // Called from collision.drain via the CollisionContext.onLocalFasterHit
  // hook. Idempotent during the respawn window.
  onHit(confetti: Confetti): void {
    if (this.respawnAt > 0) return;
    const t = this.ragdoll.parts[0].body.translation(); // torso = first
    confetti.burst(t.x, t.y, t.z, this.color);
    this.ragdoll.setVisible(false);
    this.line.visible = false;
    this.respawnAt = performance.now() + DUMMY_RESPAWN_MS;
  }

  // Call each render frame; auto-respawns after DUMMY_RESPAWN_MS.
  update(now: number): void {
    if (this.respawnAt > 0 && now >= this.respawnAt) {
      this.respawnAt = 0;
      this.applyStaticPose();
      this.ragdoll.setVisible(true);
      this.line.visible = true;
    }
  }

  dispose(): void {
    this.line.parent?.remove(this.line);
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
    this.ragdoll.dispose();
  }

  // Drive the kinematic bodies to their default rest layout under the
  // hangPoint. Calling this also populates lastSpeed (0) and lastVel (0) on
  // the underlying remote ragdoll so collision.drain doesn't skip the peer
  // for missing pose data.
  private applyStaticPose(): void {
    const pose = new Array<number>(POSE_PART_ORDER.length * 7);
    for (let i = 0; i < this.ragdoll.parts.length; i++) {
      const part = this.ragdoll.parts[i];
      const t = part.body.translation();
      const o = i * 7;
      // Identity rotation — the ragdoll spawned in an upright rest pose,
      // and we want it to stay that way.
      pose[o + 0] = t.x;
      pose[o + 1] = t.y;
      pose[o + 2] = t.z;
      pose[o + 3] = 0;
      pose[o + 4] = 0;
      pose[o + 5] = 0;
      pose[o + 6] = 1;
    }
    this.ragdoll.applyPose(pose, 0, [0, 0, 0], [0, 0, 0, 0]);
  }
}
