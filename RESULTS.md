# Torso-Leg Crease Elimination Log

Threshold for PASS: smoothness score < 0.35 px (peak 2nd-derivative of silhouette).

## Baseline

- Score: **0.994** (front_L=0.994, front_R=0.500, side_L=0.749, side_R=0.751)
- PASS: false
- Screenshots: `screenshots/runs/00-baseline-{front,side}.png`
- Observation: Side view shows a teardrop torso that pinches to a point at Y≈-0.3, with the much thinner thigh tube hanging below. The transition between torso surface (curving inward) and thigh surface (constant tube) has a hard 2nd-derivative spike. Front view: same story, plus a horizontal jump where the torso bottom narrows past the thigh's outer X position.

## Hypothesis 1 — smooth-blend the lower torso profile to thigh radii

Reasoning: the torso side+front profiles taper toward (0, -0.3); the thighs are constant-radius tubes that start at Y≈-0.19. The silhouette's peak 2nd-derivative happens where the torso curve's slope meets the thigh tube's zero-slope. If the torso profile smoothly transitions to (thigh side radius, hipOffsetX + thigh front radius) at the hip and stays constant below, the silhouette becomes one continuous curve.

Code change: inside `buildRagdollSkinnedMesh`, apply a smoothstep blend to the torso profile bottom before emitting it, with `targetSideX = thigh.radius` (side) and `targetFrontX = hipOffsetX + thigh.front.top` (front), `blendStartY = +0.05`, `blendEndY = thigh-world-top`.
