precision highp float;

attribute vec3 aOffset;      // x, z world position, y: seed
attribute vec4 aProps;       // x: scaleX, y: scaleZ, z: normalizedAge [0..1], w: kind (0: patch, 1: trail, 2: bubbles)

uniform float uTime;
uniform sampler2D uFlowMap;
uniform sampler2D uTerrainMap;

varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying float vKind;
varying float vObstacleSDF;

vec2 worldToDomainUV(vec2 xz) {
  return vec2(
    (xz.x - (-8.0)) / 16.0,
    (xz.y - (-12.0)) / 24.0
  );
}

void main() {
  vUv = uv;
  vAge = aProps.z;
  vSeed = aOffset.y;
  vKind = aProps.w;

  vec2 centerXZ = aOffset.xz;
  vec2 centerUV = clamp(worldToDomainUV(centerXZ), 0.0, 1.0);
  vec4 centerFlow = texture2D(uFlowMap, centerUV);

  vec2 vel = centerFlow.rg;
  float speed = length(vel);
  vec2 forward = speed > 0.01 ? vel / speed : vec2(0.0, 1.0);
  vec2 right = vec2(forward.y, -forward.x);

  // Foam naturally elongates along the streamline and spreads as it travels downstream
  float spreadScale = 1.0 + vAge * 0.72;
  float stretchZ = aProps.y * (1.0 + min(1.3, speed * 0.42)) * spreadScale;
  float stretchX = aProps.x * (1.0 + vAge * 0.38);

  vec2 worldXZ = centerXZ + right * (position.x * stretchX) + forward * (position.y * stretchZ);
  vec2 vertUV = clamp(worldToDomainUV(worldXZ), 0.0, 1.0);

  vec4 vertTerrain = texture2D(uTerrainMap, vertUV);
  vec4 vertFlow = texture2D(uFlowMap, vertUV);

  vObstacleSDF = vertFlow.a;

  float waveRide = sin(worldXZ.y * 1.9 - uTime * 2.4) * 0.006;
  float worldY = vertTerrain.g + waveRide + 0.006;

  gl_Position = projectionMatrix * viewMatrix * vec4(worldXZ.x, worldY, worldXZ.y, 1.0);
}
