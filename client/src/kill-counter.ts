import * as THREE from 'three';

// Billboarded kill-count digit parented to a ragdoll's torso bone. Drawn into
// a CanvasTexture and refreshed when setCount() is called (rebuilds only when
// the value changes — Colyseus schema diffs can fire stale-equal updates).
// Hidden at count === 0 so unscored players don't carry a "0" everywhere.

const CANVAS_PX = 128;
const SPRITE_WORLD_SIZE = 0.55;

export interface KillCounter {
  sprite: THREE.Sprite;
  setCount(n: number): void;
  dispose(): void;
}

export function createKillCounter(): KillCounter {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('kill-counter: no 2D canvas context');

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  // depthTest off so the digit reads "on the body" from any camera angle —
  // including when the player has their back to camera (otherwise the torso
  // mesh occludes the sprite). Combined with renderOrder it draws cleanly
  // on top of the ragdoll.
  material.depthTest = false;
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 10;
  sprite.scale.set(SPRITE_WORLD_SIZE, SPRITE_WORLD_SIZE, 1);
  sprite.visible = false;

  let current = -1;

  function draw(n: number): void {
    ctx2d!.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    const text = String(n);
    const cx = CANVAS_PX / 2;
    const cy = CANVAS_PX / 2;
    ctx2d!.textAlign = 'center';
    ctx2d!.textBaseline = 'middle';
    // Heavy weight for legibility at distance; tweaks here are safe.
    ctx2d!.font = 'bold 92px ui-sans-serif, system-ui, sans-serif';

    // Dark drop-shadow under the digit improves contrast against any
    // body color the sprite passes in front of.
    ctx2d!.lineWidth = 14;
    ctx2d!.strokeStyle = 'rgba(8, 12, 30, 0.92)';
    ctx2d!.strokeText(text, cx, cy + 4);

    // Main fill — warm-white so it pops on top of saturated player colors.
    ctx2d!.fillStyle = '#fff7e0';
    ctx2d!.fillText(text, cx, cy + 4);

    tex.needsUpdate = true;
  }

  function setCount(n: number): void {
    if (n === current) return;
    current = n;
    if (n <= 0) {
      sprite.visible = false;
      return;
    }
    draw(n);
    sprite.visible = true;
  }

  function dispose(): void {
    sprite.parent?.remove(sprite);
    material.dispose();
    tex.dispose();
  }

  return { sprite, setCount, dispose };
}
