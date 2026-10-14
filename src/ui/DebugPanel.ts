import { FeatureToggles, QualityPresetName } from '../utils/QualityPresets';

export type CameraPresetName = 'cinematic' | 'closeup' | 'cascade' | 'overhead';

export interface DebugPanelCallbacks {
  onPresetChange: (preset: QualityPresetName) => void;
  onToggleChange: (key: keyof FeatureToggles, value: boolean) => void;
  onCameraPreset: (cameraPreset: CameraPresetName) => void;
  onHudToggle: (visible: boolean) => void;
  onPauseToggle: (paused: boolean) => void;
  onRunBenchmark: () => void;
}

export class DebugPanel {
  private readonly container: HTMLElement;
  private readonly callbacks: DebugPanelCallbacks;
  private checkboxMap: Partial<Record<keyof FeatureToggles, HTMLInputElement>> = {};
  private presetButtons: Partial<Record<QualityPresetName, HTMLButtonElement>> = {};
  private benchBtn!: HTMLButtonElement;
  private collapsed = false;

  constructor(
    initialPreset: QualityPresetName,
    initialToggles: FeatureToggles,
    callbacks: DebugPanelCallbacks
  ) {
    this.callbacks = callbacks;
    this.container = document.createElement('div');
    this.buildDom(initialPreset, initialToggles);
    document.body.appendChild(this.container);
  }

  private buildDom(preset: QualityPresetName, toggles: FeatureToggles): void {
    this.container.style.cssText = `
      position: fixed;
      top: 14px;
      right: 14px;
      z-index: 100;
      width: 274px;
      background: rgba(10, 15, 22, 0.82);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(160, 200, 235, 0.18);
      border-radius: 8px;
      padding: 10px 14px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      color: #d8e6f2;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    `;

    this.container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:5px; border-bottom:1px solid rgba(255,255,255,0.1);">
        <span style="font-weight:700; font-size:11.5px; letter-spacing:0.05em; color:#7cc4fa;">SIMULATION CONTROLS</span>
        <button id="dbg-collapse-btn" style="background:none; border:none; color:#9bb2c7; cursor:pointer; font-size:11px; padding:2px 5px;">Hide</button>
      </div>
      <div id="dbg-body">
        <div style="margin-bottom:10px;">
          <div style="font-size:10.5px; color:#8da2b5; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:5px;">Quality Preset</div>
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:5px;" id="dbg-presets">
            <button data-preset="performance" class="preset-btn">Perf</button>
            <button data-preset="balanced" class="preset-btn">Balanced</button>
            <button data-preset="ultra" class="preset-btn">Ultra</button>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <div style="font-size:10.5px; color:#8da2b5; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:5px;">Camera View</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:5px;">
            <button data-cam="cinematic" class="cam-btn">Cinematic</button>
            <button data-cam="closeup" class="cam-btn">Close-Up</button>
            <button data-cam="cascade" class="cam-btn">Waterfall</button>
            <button data-cam="overhead" class="cam-btn">Stream Overview</button>
          </div>
        </div>

        <div style="margin-bottom:8px;">
          <div style="font-size:10.5px; color:#8da2b5; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:5px;">Feature Passes &amp; Scaling</div>
          <div id="dbg-toggles" style="display:flex; flex-direction:column; gap:4px;"></div>
        </div>

        <div style="margin-bottom:8px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08);">
          <button id="dbg-bench-btn" class="preset-btn" style="width:100%; padding:5px 8px; font-weight:600; color:#7cc4fa; border-color:rgba(124,196,250,0.35);">
            Run Fixed 5s Benchmark
          </button>
        </div>

        <div style="padding-top:6px; border-top:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center; font-size:11px;">
          <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="dbg-hud-chk" checked />
            <span>Perf HUD</span>
          </label>
          <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
            <input type="checkbox" id="dbg-pause-chk" />
            <span>Pause Flow</span>
          </label>
        </div>
        <div style="margin-top:7px; font-size:10px; color:#778d9f; line-height:1.35;">
          Click or drag on water to create ripples. Orbit: Left-drag · Pan: Right-drag · Zoom: Scroll.
        </div>
      </div>
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .preset-btn, .cam-btn {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #c9d8e6;
        border-radius: 5px;
        padding: 4px 6px;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .preset-btn:hover, .cam-btn:hover {
        background: rgba(124, 196, 250, 0.18);
        border-color: rgba(124, 196, 250, 0.45);
      }
      .preset-btn.active {
        background: rgba(79, 172, 254, 0.28);
        border-color: #63b3ed;
        color: #ffffff;
        font-weight: 600;
      }
      .dbg-toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 0;
        cursor: pointer;
      }
      .dbg-toggle-row input {
        cursor: pointer;
        accent-color: #4facfe;
      }
    `;
    this.container.appendChild(styleEl);

    const bodyEl = this.container.querySelector('#dbg-body') as HTMLElement;
    const collapseBtn = this.container.querySelector('#dbg-collapse-btn') as HTMLButtonElement;
    collapseBtn.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      bodyEl.style.display = this.collapsed ? 'none' : 'block';
      collapseBtn.textContent = this.collapsed ? 'Show' : 'Hide';
    });

    const presetBtns = this.container.querySelectorAll('.preset-btn[data-preset]');
    presetBtns.forEach((btn) => {
      const el = btn as HTMLButtonElement;
      const pName = el.dataset.preset as QualityPresetName;
      this.presetButtons[pName] = el;
      if (pName === preset) el.classList.add('active');
      el.addEventListener('click', () => {
        this.callbacks.onPresetChange(pName);
      });
    });

    const camBtns = this.container.querySelectorAll('.cam-btn');
    camBtns.forEach((btn) => {
      const el = btn as HTMLButtonElement;
      const cName = el.dataset.cam as CameraPresetName;
      el.addEventListener('click', () => {
        this.callbacks.onCameraPreset(cName);
      });
    });

    const toggleSpecs: Array<{ key: keyof FeatureToggles; label: string }> = [
      { key: 'reflections', label: 'Reflections (Env + Local Rock)' },
      { key: 'refraction', label: 'Screen-Space Refraction' },
      { key: 'foam', label: 'Organic Foam & Bubbles' },
      { key: 'caustics', label: 'Underwater Caustics' },
      { key: 'waterfallSpray', label: 'Waterfall Mist & Spray' },
      { key: 'shadows', label: 'Static Sun Shadows' },
      { key: 'postprocessing', label: 'Cinematic Postprocessing' },
      { key: 'pointerInteraction', label: 'Interactive Pointer Ripples' },
      { key: 'adaptiveResolution', label: 'Adaptive Resolution Scale' }
    ];

    const togglesWrap = this.container.querySelector('#dbg-toggles') as HTMLElement;
    for (const spec of toggleSpecs) {
      const row = document.createElement('label');
      row.className = 'dbg-toggle-row';
      row.innerHTML = `
        <span>${spec.label}</span>
        <input type="checkbox" ${toggles[spec.key] ? 'checked' : ''} />
      `;
      const input = row.querySelector('input') as HTMLInputElement;
      this.checkboxMap[spec.key] = input;
      input.addEventListener('change', () => {
        this.callbacks.onToggleChange(spec.key, input.checked);
      });
      togglesWrap.appendChild(row);
    }

    this.benchBtn = this.container.querySelector('#dbg-bench-btn') as HTMLButtonElement;
    this.benchBtn.addEventListener('click', () => {
      this.callbacks.onRunBenchmark();
    });

    const hudChk = this.container.querySelector('#dbg-hud-chk') as HTMLInputElement;
    hudChk.addEventListener('change', () => {
      this.callbacks.onHudToggle(hudChk.checked);
    });

    const pauseChk = this.container.querySelector('#dbg-pause-chk') as HTMLInputElement;
    pauseChk.addEventListener('change', () => {
      this.callbacks.onPauseToggle(pauseChk.checked);
    });
  }

  public setBenchmarkRunning(running: boolean): void {
    this.benchBtn.disabled = running;
    this.benchBtn.textContent = running ? 'Benchmark Running...' : 'Run Fixed 5s Benchmark';
    this.benchBtn.style.opacity = running ? '0.6' : '1.0';
  }

  public syncState(preset: QualityPresetName, toggles: FeatureToggles): void {
    (Object.keys(this.presetButtons) as QualityPresetName[]).forEach((k) => {
      const btn = this.presetButtons[k];
      if (btn) {
        btn.classList.toggle('active', k === preset);
      }
    });

    (Object.keys(this.checkboxMap) as Array<keyof FeatureToggles>).forEach((k) => {
      const chk = this.checkboxMap[k];
      if (chk) {
        chk.checked = toggles[k];
      }
    });
  }

  public dispose(): void {
    this.container.remove();
  }
}
