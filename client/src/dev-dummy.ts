import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { createRemoteRagdoll, RemoteRagdoll } from './remote-ragdoll.ts';
import { POSE_PART_ORDER, PART_MASS } from './ragdoll-proportions.ts';
import type { Collision, PeerSpeedInfo } from './collision.ts';
import type { Confetti } from './confetti.ts';
import { GRAPPLE_COLOR, GRAPPLE_LINE_WIDTH } from './constants.ts';

// Dev-only test target. Hangs a stationary remote ragdoll from a fixed world
// anchor by a static visible line. Registers as a "peer" with lastSpeed=0
// and lastVel=0 so the collision drain sees the local player as the
// clearly-faster party — but our collision rule is victim-authoritative, so
// the dummy normally wouldn't react. Instead the dummy listens on the
// `onLocalFasterHit` hook in CollisionContext and runs a small local-only
// death sequence (confetti + hide + auto-respawn) when struck. It also
// listens on `onPeerImpulse` to translate the collision module's "I would
// have pushed the peer back this hard" hint into a local kinematic shove
// (spring-damped offset on all 10 parts) so sub-lethal hits visibly swing
// the dummy. Real peers do NOT use this hook — their reaction is driven by
// their own client's drain + the streamed pose.
//
// Not gameplay-relevant: the dummy is only constructed when
// `import.meta.env.DEV` is true.

const DUMMY_RESPAWN_MS = 2000;
// Frozen empty vel/grap arrays shared across applyPose calls — we never have
// non-zero velocity for the static dummy, so per-frame literal allocations
// were pure garbage.
const DEV_DUMMY_ZERO3: number[] = [0, 0, 0];
const DEV_DUMMY_ZERO4: number[] = [0, 0, 0, 0];
// Kinematic spring used to settle the kick offset back to rest. Underdamped
// gives the dummy a satisfying swing; values picked by eye for ~0.5–1 s
// return time at the impulses produced by KNOCKBACK_GAIN.
const KICK_SPRING = 40.0;
const KICK_DAMPING = 20.0;

export class DevDummy implements PeerSpeedInfo {
  readonly sessionId: string;
  readonly ragdoll: RemoteRagdoll;
  readonly lastSpeed = 0;
  readonly lastVel = { x: 0, y: 0, z: 0 };
  get torso(): RAPIER.RigidBody { return this.ragdoll.torso; }
  private readonly line: Line2;
  private readonly lineGeom: LineGeometry;
  private readonly attachPoint: THREE.Vector3;
  private readonly hangPoint: THREE.Vector3;
  private readonly color: number;
  // Per-part world-space rest positions captured at construction. The kinematic
  // bodies' translations get rewritten every frame to restPositions[i] + kickOffset,
  // so reading the body's current translation would feed the offset back into itself.
  private readonly restPositions: { x: number; y: number; z: number }[] = [];
  // Synthetic kinematic shove. Integrated as a damped harmonic oscillator
  // toward zero each frame in update(). Applied to ALL parts as a rigid
  // translation on top of the rest pose.
  private readonly kickOffset = { x: 0, y: 0, z: 0 };
  private readonly kickVel = { x: 0, y: 0, z: 0 };
  // Pose payload handed to applyPose every frame. Identity rotation is
  // written once in the constructor; per-frame updates only rewrite the
  // translation triplet.
  private readonly posePayload = new Array<number>(POSE_PART_ORDER.length * 7);
  private respawnAt = 0;

  constructor(
    scene: THREE.Scene,
    world: RAPIER.World,
    collision: Collision,
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

    this.ragdoll = createRemoteRagdoll(scene, world, sessionId, color, name, this.hangPoint, collision);

    // Snapshot each part's spawn translation as its rest position. This MUST
    // happen before any applyPose call so the captured values are the
    // ragdoll's untouched rest layout.
    for (const part of this.ragdoll.parts) {
      const t = part.body.translation();
      this.restPositions.push({ x: t.x, y: t.y, z: t.z });
    }
    // Identity rotation in every slot — never changes, so write once.
    for (let i = 0; i < POSE_PART_ORDER.length; i++) {
      const o = i * 7;
      this.posePayload[o + 3] = 0;
      this.posePayload[o + 4] = 0;
      this.posePayload[o + 5] = 0;
      this.posePayload[o + 6] = 1;
    }

    // The visual grapple line. World-units thickness so it tapers naturally
    // with distance — matches the player grapple style.
    this.lineGeom = new LineGeometry();
    this.lineGeom.setPositions([
      this.attachPoint.x, this.attachPoint.y, this.attachPoint.z,
      this.hangPoint.x,   this.hangPoint.y,   this.hangPoint.z,
    ]);
    this.line = new Line2(
      this.lineGeom,
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
    const t = this.ragdoll.torso.translation();
    confetti.burst(t.x, t.y, t.z, this.color);
    this.ragdoll.setVisible(false);
    this.line.visible = false;
    this.respawnAt = performance.now() + DUMMY_RESPAWN_MS;
  }

  // Called from CollisionContext.onPeerImpulse with the equal-and-opposite
  // impulse vector the collision module would have transferred to a real
  // peer. Translate impulse → velocity by dividing by the same torso mass
  // the collision module used on the local side.
  kick(impulse: { x: number; y: number; z: number }): void {
    if (this.respawnAt > 0) return;
    const m = PART_MASS.torso;
    this.kickVel.x += impulse.x / m;
    this.kickVel.y += impulse.y / m;
    this.kickVel.z += impulse.z / m;
  }

  // Call each render frame; auto-respawns after DUMMY_RESPAWN_MS, and
  // integrates the kick spring so a sub-lethal hit visibly swings the dummy.
  update(now: number, dt: number): void {
    if (this.respawnAt > 0) {
      if (now >= this.respawnAt) {
        this.respawnAt = 0;
        this.kickOffset.x = 0; this.kickOffset.y = 0; this.kickOffset.z = 0;
        this.kickVel.x = 0;    this.kickVel.y = 0;    this.kickVel.z = 0;
        this.applyStaticPose();
        this.ragdoll.setVisible(true);
        this.line.visible = true;
      }
      return;
    }

    // Damped-spring integration toward zero offset. Semi-implicit Euler is
    // fine here — the dt is tiny and the constants are gentle.
    if (dt > 0) {
      const ax = -this.kickOffset.x * KICK_SPRING - this.kickVel.x * KICK_DAMPING;
      const ay = -this.kickOffset.y * KICK_SPRING - this.kickVel.y * KICK_DAMPING;
      const az = -this.kickOffset.z * KICK_SPRING - this.kickVel.z * KICK_DAMPING;
      this.kickVel.x += ax * dt;
      this.kickVel.y += ay * dt;
      this.kickVel.z += az * dt;
      this.kickOffset.x += this.kickVel.x * dt;
      this.kickOffset.y += this.kickVel.y * dt;
      this.kickOffset.z += this.kickVel.z * dt;
    }

    this.applyStaticPose();
    this.lineGeom.setPositions([
      this.attachPoint.x, this.attachPoint.y, this.attachPoint.z,
      this.hangPoint.x + this.kickOffset.x,
      this.hangPoint.y + this.kickOffset.y,
      this.hangPoint.z + this.kickOffset.z,
    ]);
  }

  dispose(): void {
    this.line.parent?.remove(this.line);
    this.lineGeom.dispose();
    (this.line.material as THREE.Material).dispose();
    this.ragdoll.dispose();
  }

  // Drive the kinematic bodies to the rest layout + kickOffset. Calling this
  // also populates lastSpeed (0) and lastVel (0) on the underlying remote
  // ragdoll so collision.drain doesn't skip the peer for missing pose data.
  private applyStaticPose(): void {
    const pose = this.posePayload;
    for (let i = 0; i < this.ragdoll.parts.length; i++) {
      const rest = this.restPositions[i];
      const o = i * 7;
      pose[o + 0] = rest.x + this.kickOffset.x;
      pose[o + 1] = rest.y + this.kickOffset.y;
      pose[o + 2] = rest.z + this.kickOffset.z;
      // rotation slots set once in the constructor.
    }
    this.ragdoll.applyPose(pose, 0, DEV_DUMMY_ZERO3, DEV_DUMMY_ZERO4);
  }
}
