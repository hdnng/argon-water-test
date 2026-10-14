import * as THREE from 'three';
import { QualityPresetName } from '../utils/QualityPresets';

export interface BenchmarkResult {
  preset: QualityPresetName;
  resolution: string;
  renderScalePct: number;
  avgFps: number;
  avgFrameTimeMs: number;
  onePercentLowFps: number;
  gpuTimeMs: number | null;
  drawCalls: number;
  triangles: number;
  durationSec: number;
}

export class PerformanceMonitor {
  private readonly container: HTMLElement;
  private visible = true;
  private windowSeconds = 3.0;

  private readonly frameTimes: number[] = [];
  private readonly frameTimestamps: number[] = [];
  private lastFrameTime = performance.now();
  private lastHudUpdateTime = 0;
  public smoothedFrameTimeMs = 16.67;

  // WebGL2 EXT_disjoint_timer_query_webgl2 state
  private gl: WebGL2RenderingContext | null = null;
  private timerExt: any = null;
  private pendingQuery: WebGLQuery | null = null;
  private queryInFlight = false;
  private gpuTimeMs: number | null = null;

  // Reproducible Benchmark state
  private benchmarkActive = false;
  private benchmarkStartTime = 0;
  private readonly warmupSec = 1.5;
  private readonly measureSec = 5.0;
  private benchFrameTimes: number[] = [];
  private benchGpuTimes: number[] = [];
  private onBenchmarkComplete: ((res: BenchmarkResult) => void) | null = null;

  // DOM Elements
  private elFps!: HTMLElement;
  private elAvgFps!: HTMLElement;
  private elFrameTime!: HTMLElement;
  private elOnePercentLow!: HTMLElement;
  private elDrawCalls!: HTMLElement;
  private elTriangles!: HTMLElement;
  private elResolution!: HTMLElement;
  private elScale!: HTMLElement;
  private elPreset!: HTMLElement;
  private elGpuTime!: HTMLElement;
  private elBenchStatus!: HTMLElement;

  constructor(renderer: THREE.WebGLRenderer) {
    const ctx = renderer.getContext();
    if (ctx instanceof WebGL2RenderingContext) {
      this.gl = ctx;
      this.timerExt = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
    }

    this.container = document.createElement('div');
    this.setupDom();
    document.body.appendChild(this.container);
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
      line-height: 1.55;
      color: #d8e6f2;
      min-width: 262px;
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
        <span style="color:#8da2b5;">Current FPS:</span><span id="hud-fps" style="font-weight:600; color:#56e39f;">--</span>
        <span style="color:#8da2b5;">Rolling Avg FPS:</span><span id="hud-avg-fps">--</span>
        <span style="color:#8da2b5;">Frame Time:</span><span id="hud-frametime">--</span>
        <span style="color:#8da2b5;">1% Low FPS (P99):</span><span id="hud-1plow">--</span>
        <span style="color:#8da2b5;">GPU Time:</span><span id="hud-gpu">--</span>
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
    this.elOnePercentLow = this.container.querySelector('#hud-1plow')!;
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

  public startBenchmark(onComplete: (res: BenchmarkResult) => void): void {
    this.benchmarkActive = true;
    this.benchmarkStartTime = performance.now();
    this.benchFrameTimes = [];
    this.benchGpuTimes = [];
    this.onBenchmarkComplete = onComplete;
    this.elBenchStatus.style.display = 'block';
    this.elBenchStatus.style.color = '#f4c95d';
    this.elBenchStatus.textContent = 'Benchmark: Warming up (1.5s)...';
  }

  public get isBenchmarkRunning(): boolean {
    return this.benchmarkActive;
  }

  public beginGpuFrame(): void {
    if (!this.gl || !this.timerExt) return;

    if (this.pendingQuery) {
      const available = this.gl.getQueryParameter(
        this.pendingQuery,
        this.gl.QUERY_RESULT_AVAILABLE
      );
      const disjoint = this.gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);

      if (available && !disjoint) {
        const timeElapsedNs = this.gl.getQueryParameter(
          this.pendingQuery,
          this.gl.QUERY_RESULT
        );
        this.gpuTimeMs = timeElapsedNs / 1e6;
      }
      if (available || disjoint) {
        this.gl.deleteQuery(this.pendingQuery);
        this.pendingQuery = null;
      }
    }

    if (!this.pendingQuery && !this.queryInFlight) {
      const q = this.gl.createQuery();
      if (q) {
        this.pendingQuery = q;
        this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
        this.queryInFlight = true;
      }
    }
  }

  public endGpuFrame(): void {
    if (!this.gl || !this.timerExt || !this.queryInFlight) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    this.queryInFlight = false;
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
    this.lastFrameTime = now;

    this.smoothedFrameTimeMs = this.smoothedFrameTimeMs * 0.92 + dtMs * 0.08;

    this.frameTimes.push(dtMs);
    this.frameTimestamps.push(now);

    const cutoff = now - this.windowSeconds * 1000.0;
    while (this.frameTimestamps.length > 2 && this.frameTimestamps[0] < cutoff) {
      this.frameTimestamps.shift();
      this.frameTimes.shift();
    }

    // Handle reproducible benchmark state machine
    if (this.benchmarkActive) {
      const elapsedSec = (now - this.benchmarkStartTime) / 1000.0;
      if (elapsedSec < this.warmupSec) {
        this.elBenchStatus.textContent = `Benchmark Warm-up: ${(this.warmupSec - elapsedSec).toFixed(1)}s...`;
      } else if (elapsedSec < this.warmupSec + this.measureSec) {
        this.benchFrameTimes.push(dtMs);
        if (this.gpuTimeMs !== null) {
          this.benchGpuTimes.push(this.gpuTimeMs);
        }
        const rem = this.warmupSec + this.measureSec - elapsedSec;
        this.elBenchStatus.textContent = `Benchmark Measuring: ${rem.toFixed(1)}s remaining...`;
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

    if (!this.visible || now - this.lastHudUpdateTime < 150) return;
    this.lastHudUpdateTime = now;

    const currentFps = 1000.0 / dtMs;
    const count = this.frameTimes.length;
    let sumMs = 0;
    for (let i = 0; i < count; i++) {
      sumMs += this.frameTimes[i];
    }
    const avgFrameMs = sumMs / Math.max(1, count);
    const avgFps = 1000.0 / avgFrameMs;

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p99Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
    const p99FrameMs = sorted[p99Index] || dtMs;
    const onePercentLowFps = 1000.0 / p99FrameMs;

    this.elFps.textContent = `${currentFps.toFixed(1)}`;
    this.elFps.style.color = currentFps >= 50 ? '#56e39f' : currentFps >= 30 ? '#f4c95d' : '#ff6b6b';
    this.elAvgFps.textContent = `${avgFps.toFixed(1)} (${this.windowSeconds}s)`;
    this.elFrameTime.textContent = `${avgFrameMs.toFixed(2)} ms`;
    this.elOnePercentLow.textContent = `${onePercentLowFps.toFixed(1)}`;
    this.elDrawCalls.textContent = `${renderer.info.render.calls}`;
    this.elTriangles.textContent = renderer.info.render.triangles.toLocaleString();
    this.elResolution.textContent = `${activeWidth} × ${activeHeight}`;
    const scalePct = Math.round(renderScale * 100);
    this.elScale.textContent = `${scalePct}% (${activeDpr.toFixed(2)}x${adaptiveEnabled ? ' Auto' : ''})`;
    this.elPreset.textContent = presetName.toUpperCase();

    if (this.timerExt && this.gpuTimeMs !== null) {
      this.elGpuTime.textContent = `${this.gpuTimeMs.toFixed(2)} ms`;
    } else {
      this.elGpuTime.textContent = 'N/A (Ext unavailable)';
    }
  }

  private finishBenchmark(
    renderer: THREE.WebGLRenderer,
    preset: QualityPresetName,
    width: number,
    height: number,
    renderScale: number
  ): void {
    const n = Math.max(1, this.benchFrameTimes.length);
    const sum = this.benchFrameTimes.reduce((a, b) => a + b, 0);
    const avgFrameTimeMs = sum / n;
    const avgFps = 1000.0 / avgFrameTimeMs;

    const sorted = [...this.benchFrameTimes].sort((a, b) => a - b);
    const p99Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] || avgFrameTimeMs;
    const onePercentLowFps = 1000.0 / p99Ms;

    const gpuAvg =
      this.benchGpuTimes.length > 0
        ? this.benchGpuTimes.reduce((a, b) => a + b, 0) / this.benchGpuTimes.length
        : null;

    const result: BenchmarkResult = {
      preset,
      resolution: `${width} × ${height}`,
      renderScalePct: Math.round(renderScale * 100),
      avgFps,
      avgFrameTimeMs,
      onePercentLowFps,
      gpuTimeMs: gpuAvg,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      durationSec: this.measureSec
    };

    this.elBenchStatus.style.color = '#56e39f';
    this.elBenchStatus.innerHTML = `
      <div style="font-weight:700; margin-bottom:2px;">BENCHMARK RESULT (${result.preset.toUpperCase()})</div>
      <div>Avg FPS: <b>${result.avgFps.toFixed(1)}</b> | 1% Low: <b>${result.onePercentLowFps.toFixed(1)}</b></div>
      <div>Frame: <b>${result.avgFrameTimeMs.toFixed(2)} ms</b> | GPU: <b>${result.gpuTimeMs !== null ? result.gpuTimeMs.toFixed(2) + ' ms' : 'N/A'}</b></div>
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
    if (this.gl && this.pendingQuery) {
      this.gl.deleteQuery(this.pendingQuery);
    }
    this.container.remove();
  }
}
