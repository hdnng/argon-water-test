precision highp float;

uniform float uTime;
uniform vec3 uSunDir;
uniform sampler2D uNoiseTex;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vKind;
varying float vObstacleSDF;

void main() {
  if (vObstacleSDF < -0.01) discard;

  vec2 centered = vUv * 2.0 - 1.0;

  // Cohesive domain-warped organic patch & longitudinal shear streak synthesis
  vec2 seedOffset = vec2(fract(vSeed * 0.173), fract(vSeed * 0.317));
  vec4 nBase = texture2D(uNoiseTex, vUv * 0.48 + seedOffset);
  vec2 warpedPos = centered + (nBase.rg - 0.5) * 0.56;
  // Anisotropic stretch along the flow axis (vUv.y) as the patch ages downstream
  warpedPos.x *= 1.0 + vAge * 0.28 + vKind * 0.15;

  float radialDistSq = dot(warpedPos, warpedPos);
  if (radialDistSq > 0.94) discard;

  float radialEnvelope = smoothstep(0.94, 0.12, radialDistSq);

  // Smooth fade-in at birth and progressive downstream dissipation
  float fadeIn = smoothstep(0.0, 0.16, vAge);
  float fadeOut = 1.0 - smoothstep(0.35, 1.0, vAge);
  float lifeEnvelope = fadeIn * fadeOut;

  // Medium-scale organic billows and flow-aligned shear ribbons (avoids tiny dot noise)
  vec2 streakUV = vec2(vUv.x * (1.15 + vKind * 0.35), vUv.y * 0.58 - uTime * 0.04) + seedOffset * 1.9 + (nBase.rg - 0.5) * 0.22;
  vec4 nStreak = texture2D(uNoiseTex, streakUV);

  float patchBody = mix(nBase.r, nBase.b, 0.58);
  float streakBody = mix(nStreak.g, nStreak.b, 0.62);
  float structure = smoothstep(0.16, 0.78, patchBody * 0.56 + streakBody * 0.54);

  // Progressive downstream break-up from outer edges inward into irregular organic patches
  float erosionThreshold = 0.14 + vAge * 0.42;
  float alpha = smoothstep(erosionThreshold - 0.08, erosionThreshold + 0.28, structure * radialEnvelope) * lifeEnvelope;

  if (alpha < 0.02) discard;

  float sunFactor = max(0.38, uSunDir.y);
  vec3 shadedFoam = vec3(0.56, 0.67, 0.71) * sunFactor;
  vec3 litFoam = vec3(0.84, 0.89, 0.88) * sunFactor;
  vec3 foamCol = mix(shadedFoam, litFoam, smoothstep(0.24, 0.80, structure * radialEnvelope));

  gl_FragColor = vec4(foamCol, clamp(alpha * 0.42, 0.0, 0.45));
}
