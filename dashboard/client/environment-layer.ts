import type { BlueMapApp, BlueMapColor } from './bluemap.js';
import type { EnvironmentState } from '../server/types.js';
import { environmentView } from './environment-model.js';

/** Update BlueMap's terrain/sky shader lighting; precipitation stays below labels and dashboard UI. */
export class EnvironmentLayer {
  private environment: EnvironmentState | null = null;
  private offset = 0;
  private map: BlueMapApp['mapViewer']['map'] = null;
  private sky: BlueMapColor | null = null;
  private voidColor: BlueMapColor | null = null;
  private initialized = false;
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D | null;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly drops = Array.from({ length: 240 }, () => ({ x: Math.random(), y: Math.random(), speed: 0.65 + Math.random() * 0.7 }));
  constructor(readonly app: BlueMapApp) {
    this.canvas.className = 'md-weather-layer'; this.canvas.hidden = true;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.context = this.canvas.getContext('2d');
    const mapCanvas = app.mapViewer.renderer.domElement;
    mapCanvas.insertAdjacentElement('afterend', this.canvas);
    app.events.addEventListener('bluemapRenderFrame', this.onFrame);
    app.events.addEventListener('bluemapMapChanged', this.onMapChanged);
  }
  sync(environment: EnvironmentState, now: number): void {
    this.environment = environment; this.offset = now - Date.now();
    this.frame(0); this.app.mapViewer.redraw();
  }
  private readonly onMapChanged = (): void => { this.map = null; this.frame(0); };
  private readonly onFrame = (event: Event): void => this.frame((event as CustomEvent<{ delta: number }>).detail.delta);
  private frame(delta: number): void {
    const viewer = this.app.mapViewer;
    if (!this.environment || !viewer.map || viewer.data.mapState !== 'loaded') { this.canvas.hidden = true; return; }
    if (this.map !== viewer.map) {
      this.map = viewer.map;
      // Clone colors: BlueMap aliases its defaults into the uniforms when switching maps.
      this.sky = viewer.map.data.skyColor.clone(); this.voidColor = viewer.map.data.voidColor.clone();
      this.initialized = false;
    }
    const view = environmentView(this.environment, viewer.map.data.id, Date.now() + this.offset);
    const uniforms = viewer.data.uniforms;
    if (view.active) {
      const amount = !this.initialized || this.reducedMotion.matches ? 1 : 1 - Math.exp(-Math.min(delta, 1000) / 550);
      uniforms.sunlightStrength.value += (view.sunlight - uniforms.sunlightStrength.value) * amount;
      uniforms.ambientLight.value += (view.ambient - uniforms.ambientLight.value) * amount;
      for (const [color, target] of [[this.sky!, view.sky], [this.voidColor!, view.voidColor]] as const) {
        color.setRGB(color.r + (target[0] - color.r) * amount, color.g + (target[1] - color.g) * amount, color.b + (target[2] - color.b) * amount);
      }
      uniforms.skyColor.value = this.sky!; uniforms.voidColor.value = this.voidColor!;
      this.initialized = true;
    } else {
      uniforms.sunlightStrength.value = viewer.map.data.skyLight;
      uniforms.ambientLight.value = viewer.map.data.ambientLight;
      uniforms.skyColor.value = viewer.map.data.skyColor; uniforms.voidColor.value = viewer.map.data.voidColor;
      this.initialized = false;
    }
    this.canvas.dataset.weather = view.weather ?? 'unknown'; this.canvas.dataset.phase = view.phase;
    this.canvas.hidden = !view.rain;
    if (view.rain && !document.hidden) this.rain(delta, view.storm);
  }
  private rain(delta: number, storm: number): void {
    const ctx = this.context; const parent = this.canvas.parentElement;
    if (!ctx || !parent) return;
    const width = parent.clientWidth; const height = parent.clientHeight; const ratio = Math.min(1.5, devicePixelRatio || 1);
    if (!width || !height) return;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const haze = ctx.createLinearGradient(0, 0, 0, height);
    haze.addColorStop(0, `rgba(105,125,148,${storm * 0.12})`); haze.addColorStop(1, 'rgba(63,83,108,0.02)');
    ctx.fillStyle = haze; ctx.fillRect(0, 0, width, height);
    const count = storm >= 1 ? 240 : 150;
    const motion = this.reducedMotion.matches ? 0 : Math.min(delta, 80);
    ctx.strokeStyle = 'rgba(177,205,229,0.42)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const drop = this.drops[i]; drop.y = (drop.y + motion * 0.00065 * drop.speed) % 1;
      drop.x = (drop.x + motion * 0.000055 * drop.speed) % 1;
      const x = drop.x * width; const y = drop.y * height; const length = (10 + storm * 10) * drop.speed;
      ctx.moveTo(x, y); ctx.lineTo(x - length * 0.24, y - length);
    }
    ctx.stroke();
  }
  dispose(): void {
    this.app.events.removeEventListener('bluemapRenderFrame', this.onFrame);
    this.app.events.removeEventListener('bluemapMapChanged', this.onMapChanged);
    this.canvas.remove();
  }
}
