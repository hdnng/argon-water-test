import * as THREE from 'three';
import { QualityPresetName } from '../utils/QualityPresets';

export type BenchmarkScenarioName = 'overview' | 'waterfall' | 'boulders' | 'orbit';

export interface BenchmarkOptions {
  scenario?: BenchmarkScenarioName;
  warmupSec?: number;
  measureSec?: number;
}

export interface BenchmarkResult {
  scenario: BenchmarkScenarioName;
  preset: QualityPresetName;
  resolution: string;
  renderScalePct: number;
  avgFps: number;
  avgFrameTimeMs: number;
  medianFrameTimeMs: number;
  p95FrameTimeMs: number;
  p99FrameTimeMs: number;
  onePercentLowFps: number;
  cpuTimeMs: number;
  gpuTimeMs: number | null;
  drawCalls: number;
  triangles: number;
  warmupSec: number;
  durationSec: number;
  sampleCount: number;
}

const RING_CAPACITY = 4096;
const BENCH_CAPACITY = 16384;
const GPU_QUERY_POOL_SIZE = 4;

export class PerformanceMonitor {
  private readonly container: HTMLElement;
  private visible = true;
  private windowSeconds = 3.0;
  private readonly hudUpdateIntervalMs = 250;

  // Zero-allocation circular ring buffers for rolling telemetry
  private readonly frameTimeRing = new Float64Array(RING_CAPACITY);
  private readonly cpuTimeRing = new Float64Array(RING_CAPACITY);
  private readonly timestampRing = new Float64Array(RING_CAPACITY);
  private readonly sortScratch = new Float64Array(BENCH_CAPACITY);
  private ringWriteIdx = 0;
  private ringCount = 0;

  private lastFrameTime = performance.now();
  private cpuFrameStart = performance.now();
  private lastHudUpdateTime = 0;
  public smoothedFrameTimeMs = 16.67;

  // Pooled WebGL2 EXT_disjoint_timer_query_webgl2 state (zero per-frame query allocations)
  private gl: WebGL2RenderingContext | null = null;
  private timerExt: any = null;
  private readonly queryPool: WebGLQuery[] = [];
  private readonly pendingQueries: WebGLQuery[] = [];
  private activeQuery: WebGLQuery | null = null;
  private gpuTimeMs: number | null = null;
  private smoothedGpuTimeMs: number | null = null;

  // Zero-allocation Reproducible Benchmark state
  private benchmarkActive = false;
  private benchmarkScenario: BenchmarkScenarioName = 'overview';
  private benchmarkStartTime = 0;
  private warmupSec = 10.0;
  private measureSec = 30.0;
  private readonly benchFrameTimes = new Float64Array(BENCH_CAPACITY);
  private readonly benchCpuTimes = new Float64Array(BENCH_CAPACITY);
  private readonly benchGpuTimes = new Float64Array(BENCH_CAPACITY);
  private benchSampleCount = 0;
  private benchGpuSampleCount = 0;
  private lastBenchCountdownDeci = -1;
  private onBenchmarkComplete: ((res: BenchmarkResult) => void) | null = null;

  // DOM Elements & dirty-check cache
  private elFps!: HTMLElement;
  private elAvgFps!: HTMLElement;
  private elFrameTime!: HTMLElement;
  private elPercentiles!: HTMLElement;
  private elOnePercentLow!: HTMLElement;
  private elCpuTime!: HTMLElement;
  private elGpuTime!: HTMLElement;
  private elDrawCalls!: HTMLElement;
  private elTriangles!: HTMLElement;
  private elResolution!: HTMLElement;
  private elScale!: HTMLElement;
  private elPreset!: HTMLElement;
  private elBenchStatus!: HTMLElement;
  private readonly domCache: Record<string, string> = {};

  constructor(renderer: THREE.WebGLRenderer) {
    const ctx = renderer.getContext();
    if (ctx instanceof WebGL2RenderingContext) {
      this.gl = ctx;
      this.timerExt = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
      if (this.timerExt) {
        for (let i = 0; i < GPU_QUERY_POOL_SIZE; i++) {
          const q = ctx.createQuery();
          if (q) this.queryPool.push(q);
        }
      }
    }

    this.container = document.createElement('div');
    this.setupDom();
    document.body.appendChild(this.container);
  }

  private setText(key: string, el: HTMLElement, text: string): void {
    if (this.domCache[key] !== text) {
      this.domCache[key] = text;
      el.textContent = text;
    }
  }

  private setupDom(): void {
    this.container.style.cssText = `
      position: fixed;
      top: 14px;
      left: 14px;
      z-index: 100;
      background: rgba(10, 15, 22, 0.82);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(160, 200, 235, 0.18);
      border-radius: 8px;
      padding: 10px 14px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11.5px;
      line-height: 1.52;
      color: #d8e6f2;
      min-width: 278px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      pointer-events: auto;
    `;

    this.container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; padding-bottom:4px; border-bottom:1px solid rgba(255,255,255,0.1);">
        <span style="font-weight:700; color:#7cc4fa; letter-spacing:0.05em;">GPU TELEMETRY HUD</span>
        <select id="perf-window-select" title="Averaging Interval" style="background:#141e28; color:#bcd0e2; border:1px solid rgba(255,255,255,0.18); border-radius:4px; font-size:10px; padding:1px 4px; cursor:pointer;">
          <option value="1">1s Avg</option>
          <option value="3" selected>3s Avg</option>
          <option value="5">5s Avg</option>
          <option value="10">10s Avg</option>
        </select>
      </div>
      <div style="display:grid; grid-template-columns: 1fr auto; column-gap: 14px;">
        <span style="color:#8da2b5;">Instantaneous FPS:</span><span id="hud-fps" style="font-weight:600; color:#56e39f;">--</span>
        <span style="color:#8da2b5;">Rolling Avg FPS:</span><span id="hud-avg-fps">--</span>
        <span style="color:#8da2b5;">Frame Time (Avg / Med):</span><span id="hud-frametime">--</span>
        <span style="color:#8da2b5;">P95 / P99 Frame Time:</span><span id="hud-percentiles">--</span>
        <span style="color:#8da2b5;">1% Low FPS (P99):</span><span id="hud-1plow">--</span>
        <span style="color:#8da2b5;">CPU Frame Time:</span><span id="hud-cpu">--</span>
        <span style="color:#8da2b5;">GPU Time (Async):</span><span id="hud-gpu">--</span>
        <span style="color:#8da2b5;">Draw Calls:</span><span id="hud-draws">--</span>
        <span style="color:#8da2b5;">Triangles:</span><span id="hud-tris">--</span>
        <span style="color:#8da2b5;">Internal Res:</span><span id="hud-res">--</span>
        <span style="color:#8da2b5;">Render Scale / DPR:</span><span id="hud-scale">--</span>
        <span style="color:#8da2b5;">Active Preset:</span><span id="hud-preset" style="color:#7cc4fa; font-weight:600;">--</span>
      </div>
      <div id="hud-bench-status" style="display:none; margin-top:8px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.12); color:#f4c95d; font-size:10.5px;"></div>
    `;

    this.elFps = this.container.querySelector('#hud-fps')!;
    this.elAvgFps = this.container.querySelector('#hud-avg-fps')!;
    this.elFrameTime = this.container.querySelector('#hud-frametime')!;
    this.elPercentiles = this.container.querySelector('#hud-percentiles')!;
    this.elOnePercentLow = this.container.querySelector('#hud-1plow')!;
    this.elCpuTime = this.container.querySelector('#hud-cpu')!;
    this.elGpuTime = this.container.querySelector('#hud-gpu')!;
    this.elDrawCalls = this.container.querySelector('#hud-draws')!;
    this.elTriangles = this.container.querySelector('#hud-tris')!;
    this.elResolution = this.container.querySelector('#hud-res')!;
    this.elScale = this.container.querySelector('#hud-scale')!;
    this.elPreset = this.container.querySelector('#hud-preset')!;
    this.elBenchStatus = this.container.querySelector('#hud-bench-status')!;

    const select = this.container.querySelector('#perf-window-select') as HTMLSelectElement;
    select.addEventListener('change', () => {
      this.windowSeconds = parseFloat(select.value) || 3.0;
    });
  }

  public startBenchmark(
    onComplete: (res: BenchmarkResult) => void,
    options?: BenchmarkOptions
  ): void {
    this.benchmarkScenario = options?.scenario ?? 'overview';
    this.warmupSec = options?.warmupSec ?? 10.0;
    this.measureSec = options?.measureSec ?? 30.0;
    this.benchmarkActive = true;
    this.benchmarkStartTime = performance.now();
    this.benchSampleCount = 0;
    this.benchGpuSampleCount = 0;
    this.lastBenchCountdownDeci = -1;
    this.onBenchmarkComplete = onComplete;
    this.elBenchStatus.style.display = 'block';
    this.elBenchStatus.style.color = '#f4c95d';
    this.elBenchStatus.textContent = `Benchmark [${this.benchmarkScenario.toUpperCase()}]: Warming up (${this.warmupSec.toFixed(1)}s)...`;
  }

  public get isBenchmarkRunning(): boolean {
    return this.benchmarkActive;
  }

  public get currentBenchmarkScenario(): BenchmarkScenarioName {
    return this.benchmarkScenario;
  }

  public get benchmarkElapsedSec(): number {
    if (!this.benchmarkActive) return 0;
    return (performance.now() - this.benchmarkStartTime) / 1000.0;
  }

  public beginCpuFrame(): void {
    this.cpuFrameStart = performance.now();
  }

  public beginGpuFrame(): void {
    if (!this.gl || !this.timerExt) return;

    // Poll oldest completed query asynchronously without stalling the GPU pipeline
    while (this.pendingQueries.length > 0) {
      const q = this.pendingQueries[0];
      const available = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE);
      if (!available) break;

      this.pendingQueries.shift();
      const disjoint = this.gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const timeElapsedNs = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT);
        const ms = timeElapsedNs / 1e6;
        this.gpuTimeMs = ms;
        this.smoothedGpuTimeMs =
          this.smoothedGpuTimeMs === null ? ms : this.smoothedGpuTimeMs * 0.85 + ms * 0.15;
      }
      this.queryPool.push(q);
    }

    if (!this.activeQuery && this.queryPool.length > 0) {
      const q = this.queryPool.pop()!;
      this.activeQuery = q;
      this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    }
  }

  public endGpuFrame(): void {
    if (!this.gl || !this.timerExt || !this.activeQuery) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    this.pendingQueries.push(this.activeQuery);
    this.activeQuery = null;
  }

  public endFrame(
    renderer: THREE.WebGLRenderer,
    presetName: QualityPresetName,
    activeWidth: number,
    activeHeight: number,
    activeDpr: number,
    renderScale: number,
    adaptiveEnabled: boolean
  ): void {
    const now = performance.now();
    const dtMs = Math.max(0.1, now - this.lastFrameTime);
    const cpuDtMs = Math.max(0.01, now - this.cpuFrameStart);
    this.lastFrameTime = now;

    this.smoothedFrameTimeMs = this.smoothedFrameTimeMs * 0.92 + dtMs * 0.08;

    // Write into fixed-size circular ring buffer (zero heap allocations)
    this.frameTimeRing[this.ringWriteIdx] = dtMs;
    this.cpuTimeRing[this.ringWriteIdx] = cpuDtMs;
    this.timestampRing[this.ringWriteIdx] = now;
    this.ringWriteIdx = (this.ringWriteIdx + 1) % RING_CAPACITY;
    if (this.ringCount < RING_CAPACITY) {
      this.ringCount++;
    }

    // Handle reproducible benchmark state machine
    if (this.benchmarkActive) {
      const elapsedSec = (now - this.benchmarkStartTime) / 1000.0;
      if (elapsedSec < this.warmupSec) {
        const remDeci = Math.ceil((this.warmupSec - elapsedSec) * 5);
        if (remDeci !== this.lastBenchCountdownDeci) {
          this.lastBenchCountdownDeci = remDeci;
          this.elBenchStatus.textContent = `Benchmark [${this.benchmarkScenario.toUpperCase()}] Warm-up: ${(this.warmupSec - elapsedSec).toFixed(1)}s...`;
        }
      } else if (elapsedSec < this.warmupSec + this.measureSec) {
        if (this.benchSampleCount < BENCH_CAPACITY) {
          this.benchFrameTimes[this.benchSampleCount] = dtMs;
          this.benchCpuTimes[this.benchSampleCount] = cpuDtMs;
          this.benchSampleCount++;
        }
        if (this.gpuTimeMs !== null && this.benchGpuSampleCount < BENCH_CAPACITY) {
          this.benchGpuTimes[this.benchGpuSampleCount] = this.gpuTimeMs;
          this.benchGpuSampleCount++;
        }
        const remDeci = Math.ceil((this.warmupSec + this.measureSec - elapsedSec) * 5);
        if (remDeci !== this.lastBenchCountdownDeci) {
          this.lastBenchCountdownDeci = remDeci;
          const rem = this.warmupSec + this.measureSec - elapsedSec;
          this.elBenchStatus.textContent = `Benchmark [${this.benchmarkScenario.toUpperCase()}] Measuring: ${rem.toFixed(1)}s...`;
        }
      } else {
        this.benchmarkActive = false;
        this.finishBenchmark(
          renderer,
          presetName,
          activeWidth,
          activeHeight,
          renderScale
        );
      }
    }

    if (!this.visible || now - this.lastHudUpdateTime < this.hudUpdateIntervalMs) return;
    this.lastHudUpdateTime = now;

    // Collect samples within rolling window without allocating arrays
    const cutoff = now - this.windowSeconds * 1000.0;
    let windowCount = 0;
    let sumMs = 0;
    let sumCpuMs = 0;

    for (let i = 0; i < this.ringCount; i++) {
      const idx = (this.ringWriteIdx - 1 - i + RING_CAPACITY) % RING_CAPACITY;
      if (this.timestampRing[idx] < cutoff && windowCount >= 2) {
        break;
      }
      const ft = this.frameTimeRing[idx];
      sumMs += ft;
      sumCpuMs += this.cpuTimeRing[idx];
      this.sortScratch[windowCount] = ft;
      windowCount++;
    }

    const validCount = Math.max(1, windowCount);
    const avgFrameMs = sumMs / validCount;
    const avgCpuMs = sumCpuMs / validCount;
    const avgFps = 1000.0 / avgFrameMs;
    const currentFps = 1000.0 / dtMs;

    // Native C++ typed-array sort on subarray view (zero JS callback or allocation overhead)
    const activeView = this.sortScratch.subarray(0, validCount);
    activeView.sort();

    const p50FrameMs = activeView[Math.floor(validCount * 0.50)] || dtMs;
    const p95FrameMs = activeView[Math.min(validCount - 1, Math.floor(validCount * 0.95))] || dtMs;
    const p99FrameMs = activeView[Math.min(validCount - 1, Math.floor(validCount * 0.99))] || dtMs;
    const onePercentLowFps = 1000.0 / p99FrameMs;

    this.setText('fps', this.elFps, `${currentFps.toFixed(1)}`);
    const fpsColor = currentFps >= 50 ? '#56e39f' : currentFps >= 30 ? '#f4c95d' : '#ff6b6b';
    if (this.domCache['fpsColor'] !== fpsColor) {
      this.domCache['fpsColor'] = fpsColor;
      this.elFps.style.color = fpsColor;
    }

    this.setText('avgFps', this.elAvgFps, `${avgFps.toFixed(1)} (${this.windowSeconds}s)`);
    this.setText('frameTime', this.elFrameTime, `${avgFrameMs.toFixed(2)} / ${p50FrameMs.toFixed(2)} ms`);
    this.setText('percentiles', this.elPercentiles, `${p95FrameMs.toFixed(2)} / ${p99FrameMs.toFixed(2)} ms`);
    this.setText('onePercentLow', this.elOnePercentLow, `${onePercentLowFps.toFixed(1)}`);
    this.setText('cpuTime', this.elCpuTime, `${avgCpuMs.toFixed(2)} ms`);
    this.setText('drawCalls', this.elDrawCalls, `${renderer.info.render.calls}`);
    this.setText('triangles', this.elTriangles, renderer.info.render.triangles.toLocaleString());
    this.setText('res', this.elResolution, `${activeWidth} × ${activeHeight}`);
    const scalePct = Math.round(renderScale * 100);
    this.setText(
      'scale',
      this.elScale,
      `${scalePct}% (${activeDpr.toFixed(2)}x${adaptiveEnabled ? ' Auto' : ''})`
    );
    this.setText('preset', this.elPreset, presetName.toUpperCase());

    if (this.timerExt && this.smoothedGpuTimeMs !== null) {
      this.setText('gpuTime', this.elGpuTime, `${this.smoothedGpuTimeMs.toFixed(2)} ms`);
    } else {
      this.setText('gpuTime', this.elGpuTime, 'N/A (Ext unavailable)');
    }
  }

  private finishBenchmark(
    renderer: THREE.WebGLRenderer,
    preset: QualityPresetName,
    width: number,
    height: number,
    renderScale: number
  ): void {
    const n = Math.max(1, this.benchSampleCount);
    let sum = 0;
    let sumCpu = 0;
    for (let i = 0; i < this.benchSampleCount; i++) {
      const ft = this.benchFrameTimes[i];
      sum += ft;
      sumCpu += this.benchCpuTimes[i];
      this.sortScratch[i] = ft;
    }

    const avgFrameTimeMs = sum / n;
    const cpuTimeMs = sumCpu / n;
    const avgFps = 1000.0 / avgFrameTimeMs;

    const sorted = this.sortScratch.subarray(0, this.benchSampleCount);
    sorted.sort();

    const medianFrameTimeMs =
      sorted[Math.floor(sorted.length * 0.50)] || avgFrameTimeMs;
    const p95FrameTimeMs =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || avgFrameTimeMs;
    const p99FrameTimeMs =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] || avgFrameTimeMs;
    const onePercentLowFps = 1000.0 / p99FrameTimeMs;

    let gpuAvg: number | null = null;
    if (this.benchGpuSampleCount > 0) {
      let gpuSum = 0;
      for (let i = 0; i < this.benchGpuSampleCount; i++) {
        gpuSum += this.benchGpuTimes[i];
      }
      gpuAvg = gpuSum / this.benchGpuSampleCount;
    }

    const result: BenchmarkResult = {
      scenario: this.benchmarkScenario,
      preset,
      resolution: `${width} × ${height}`,
      renderScalePct: Math.round(renderScale * 100),
      avgFps,
      avgFrameTimeMs,
      medianFrameTimeMs,
      p95FrameTimeMs,
      p99FrameTimeMs,
      onePercentLowFps,
      cpuTimeMs,
      gpuTimeMs: gpuAvg,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      warmupSec: this.warmupSec,
      durationSec: this.measureSec,
      sampleCount: this.benchSampleCount
    };

    this.elBenchStatus.style.color = '#56e39f';
    this.elBenchStatus.innerHTML = `
      <div style="font-weight:700; margin-bottom:2px;">BENCHMARK [${result.scenario.toUpperCase()}] (${result.preset.toUpperCase()})</div>
      <div>Avg FPS: <b>${result.avgFps.toFixed(1)}</b> | 1% Low: <b>${result.onePercentLowFps.toFixed(1)}</b></div>
      <div>Med / P95 / P99: <b>${result.medianFrameTimeMs.toFixed(2)} / ${result.p95FrameTimeMs.toFixed(2)} / ${result.p99FrameTimeMs.toFixed(2)} ms</b></div>
      <div>CPU: <b>${result.cpuTimeMs.toFixed(2)} ms</b> | GPU: <b>${result.gpuTimeMs !== null ? result.gpuTimeMs.toFixed(2) + ' ms' : 'N/A'}</b></div>
      <div>Draws: <b>${result.drawCalls}</b> | Tris: <b>${result.triangles.toLocaleString()}</b></div>
    `;

    if (this.onBenchmarkComplete) {
      this.onBenchmarkComplete(result);
    }
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.container.style.display = visible ? 'block' : 'none';
  }

  public dispose(): void {
    if (this.gl) {
      if (this.activeQuery) this.gl.deleteQuery(this.activeQuery);
      for (const q of this.pendingQueries) this.gl.deleteQuery(q);
      for (const q of this.queryPool) this.gl.deleteQuery(q);
    }
    this.container.remove();
  }
}
