# Photorealistic Real-Time Mountain Stream Water Simulation (Three.js / WebGL2)

A physically motivated, GPU-optimized 3D freshwater mountain stream simulation built with **Three.js**, **TypeScript**, **Vite**, and custom **WebGL2 GLSL shaders**.

---

## 1. Local Development & Build Instructions

### Prerequisites
- **Node.js** `>= 18.0` and **npm**

### Install Dependencies
```bash
npm install
```

### Run Development Server (with LAN Access)
```bash
npm run dev
```

### Production Build & Type Check
```bash
npm run build
```

---

## 2. Project Architecture

```text
src/
├── main.ts                    # WebGL2 single-opaque-pass + blitFramebuffer pipeline, adaptive resolution & loop
├── vite-env.d.ts              # GLSL module type declarations
├── scene/
│   ├── Environment.ts         # Procedural mountain valley sky dome & HDR environment cubemap baker
│   ├── Lighting.ts            # Sunlight directional shadows, hemisphere sky-ground light & bounce fill
│   ├── Riverbed.ts            # Domain-warped terrain, welded smooth 3D pebbles, derivative bump & fast caustics
│   └── Rocks.ts               # Welded smooth-normal geological boulders (slate, granite, gneiss, basalt)
├── water/
│   ├── FlowField.ts           # Spatial velocity field, obstacle SDF, chute hydraulics & GPU DataTextures
│   ├── WaterMaterial.ts       # Custom ShaderMaterial wrapper & quality/toggle uniform synchronization
│   ├── WaterSurface.ts        # Stream surface mesh
│   ├── FoamSystem.ts          # Flow-advected instanced organic foam patches & bubble trails
│   ├── RippleSystem.ts        # GPU ping-pong 2D wave solver + active-only dispersive capillary wave rings
│   └── Waterfall.ts           # 7 separated pouring water chutes, refractive upper lip & compact collision spray
├── shaders/
│   ├── water.vert.glsl        # Multi-frequency surface wave displacement using uNoiseTex & active ripple count
│   ├── water.frag.glsl        # Band-limited normals, Fresnel, depth-rejected refraction, Beer-Lambert & organic foam
│   ├── foam.vert.glsl         # Flow-aligned, surface-riding instanced foam vertex deformation
│   └── foam.frag.glsl         # Organic domain-warped bubble clusters & progressive downstream dissipation
├── ui/
│   ├── DebugPanel.ts          # Quality presets, camera presets, feature toggles, adaptive scale & 5s benchmark
│   └── PerformanceMonitor.ts  # Real-time FPS, 1% low FPS, frame/GPU time, draw calls, triangles & benchmark runner
└── utils/
    ├── ProceduralTextures.ts  # Precomputed 256x256 mipmapped RGBA texture (FBM, organic foam, caustics, grain)
    └── QualityPresets.ts      # Calibrated Performance, Balanced & Ultra rendering configurations
```

---

## 3. Rendering Pipeline & GPU Optimization Architecture

1. **Single-Pass Opaque Scene + Native WebGL2 `gl.blitFramebuffer`**:
   - Opaque geometry (sky, riverbed, instanced pebbles, and boulders) is rendered **only once per frame** into `postTarget` (which has an attached `FloatType` hardware `DepthTexture`).
   - Color and depth buffers are copied to `refractionTarget` via hardware `gl.blitFramebuffer` (`COLOR_BUFFER_BIT` + `DEPTH_BUFFER_BIT`) with **zero geometry draw calls and zero fragment shader re-execution**.
   - Transparent water, waterfall sheets, spray, and foam then render directly onto `postTarget` (`autoClear = false`), reading `refractionTarget` without WebGL feedback loops.
2. **Static Directional Shadow Caching (`shadowMap.autoUpdate = false`)**:
   - Since the sun and boulders are static, the directional `PCFSoftShadowMap` is rendered once at startup (and on preset/shadow toggle changes) rather than re-rendering every frame.
3. **Precomputed Mipmapped Procedural Texture (`uNoiseTex`)**:
   - Replaces expensive per-pixel nested $3 \times 3$ Voronoi loops and multi-octave hash evaluations with hardware-filtered, mipmapped texture lookups (`LinearMipmapLinearFilter`), reducing fragment ALU load and automatically band-limiting distant surface normal detail.
4. **Welded Smooth Geometry & Distance-Aware Subdivision**:
   - Rock and pebble geometries weld shared vertices prior to `computeVertexNormals()`, eliminating flat low-poly triangle facets while reducing per-pebble triangle count by 75% (`80` triangles per pebble vs. `320` unindexed triangles).
5. **Optional Adaptive Resolution & Reproducible 5s Benchmark**:
   - Optional hysteresis-controlled Adaptive Resolution (`55%–100%` scale) adjusts internal rendering resolution based on exponentially smoothed frame times.
   - Built-in **Run Fixed 5s Benchmark** locks the camera to the `Cinematic` view, disables adaptive scaling, runs a `1.5s` warm-up followed by a `5.0s` measurement window, and reports verified metrics in the HUD.
