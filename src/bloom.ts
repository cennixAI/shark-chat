import type { Scene, SceneOptions } from "./scene";
import type { Theme } from "./renderer";

export const bloomSettings = { paused: false, color: true, detail: 180 };

/** The supplied flower film is only a sampler. Every visible mark is a text glyph. */
export class BloomScene implements Scene {
  time = 0;
  pointer = { x: 0, y: 0, active: false };
  private video = document.createElement("video");
  private sample = document.createElement("canvas");
  private pixels = this.sample.getContext("2d", { willReadFrequently: true })!;
  private ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private theme: Theme;
  private lastFrame = -1;
  private dirty = true;
  private disposed = false;
  private failed = false;
  private motion = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private canvas: HTMLCanvasElement, private options: SceneOptions) {
    this.ctx = canvas.getContext("2d")!;
    this.theme = options.theme;
    this.video.muted = true;
    this.video.loop = true;
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.addEventListener("loadeddata", this.onReady);
    this.video.addEventListener("seeked", this.repaint);
    this.video.addEventListener("error", this.onError);
    document.addEventListener("visibilitychange", this.syncPlayback);
    this.motion.addEventListener("change", this.syncPlayback);
    this.video.src = `${import.meta.env.BASE_URL}media/bloom.mp4`;
    this.syncPlayback();
  }

  private onReady = () => {
    if (this.disposed) return;
    // The still also has an open flower when reduced motion is enabled.
    if (this.motion.matches) this.video.currentTime = 2;
    this.repaint();
    this.syncPlayback();
  };
  private onError = () => { this.failed = true; this.repaint(); };
  private syncPlayback = () => {
    if (this.disposed) return;
    if (bloomSettings.paused || this.motion.matches || document.hidden) this.video.pause();
    else if (this.video.paused) void this.video.play().catch(() => {
      if (!this.disposed && !document.hidden && !this.motion.matches && !bloomSettings.paused) {
        bloomSettings.paused = true;
        window.dispatchEvent(new Event("bloom-playback-blocked"));
      }
    });
  };
  refresh() { this.dirty = true; this.syncPlayback(); this.render(); }
  private repaint = () => { this.dirty = true; this.render(); };
  resize(width: number, height: number, dpr: number) {
    this.width = width; this.height = height; this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.dirty = true;
  }
  setTheme(theme: Theme) { this.theme = theme; this.repaint(); }
  step(dt: number) { this.time += dt; }
  render() {
    if (this.disposed || document.hidden) return;
    const frame = Math.floor(this.video.currentTime * 24);
    if (!this.dirty && frame === this.lastFrame) return;
    this.lastFrame = frame; this.dirty = false;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.theme === "dark" ? "#080a09" : "#fbfbfa";
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.video.readyState < 2 || this.failed) {
      ctx.fillStyle = this.theme === "dark" ? "#b8c5bd" : "#3d4d44";
      ctx.font = `13px ${this.options.fontFamily}`;
      ctx.textAlign = "center";
      ctx.fillText(this.failed ? "Bloom could not load. Reload to retry." : "Loading bloom...", this.width / 2, this.height / 2);
      return;
    }
    const targetColumns = bloomSettings.detail * (this.width < 600 ? 0.4 : 1);
    const cell = Math.max(3.2, this.width / targetColumns);
    const cols = Math.ceil(this.width / cell);
    const rows = Math.ceil(this.height / cell);
    if (this.sample.width !== cols || this.sample.height !== rows) {
      this.sample.width = cols; this.sample.height = rows;
    }
    // Center-crop the empty sides on narrow screens; retain the complete flower.
    const sourceW = this.video.videoWidth, sourceH = this.video.videoHeight;
    const cropW = Math.min(sourceW, Math.max(sourceW * 0.66, sourceH * this.width / this.height));
    const scale = Math.min(this.width / cropW, this.height / sourceH);
    const dw = cropW * scale / cell, dh = sourceH * scale / cell;
    this.pixels.fillStyle = "#111";
    this.pixels.fillRect(0, 0, cols, rows);
    this.pixels.drawImage(this.video, (sourceW - cropW) / 2, 0, cropW, sourceH, (cols - dw) / 2, (rows - dh) / 2, dw, dh);
    const data = this.pixels.getImageData(0, 0, cols, rows).data;
    const glyphs = ".,:;=+*#%@";
    ctx.font = `600 ${cell * 1.12}px ${this.options.fontFamily}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const light = Math.max(0, (r * 0.2126 + g * 0.7152 + b * 0.0722 - 19) / 160);
        if (light < 0.035) continue;
        const value = Math.min(1, Math.pow(light, 0.7));
        if (this.theme === "dark") {
          ctx.fillStyle = bloomSettings.color
            ? `rgb(${Math.min(255, r * 1.65 + 24)} ${Math.min(255, g * 1.65 + 24)} ${Math.min(255, b * 1.65 + 24)})`
            : `rgb(${100 + value * 155} ${111 + value * 144} ${104 + value * 151})`;
        } else {
          ctx.fillStyle = bloomSettings.color ? `rgb(${Math.round(r * 0.35)} ${Math.round(g * 0.35)} ${Math.round(b * 0.35)})` : "#20392e";
        }
        ctx.globalAlpha = Math.min(1, 0.3 + value);
        ctx.fillText(glyphs[Math.min(glyphs.length - 1, Math.floor(value * glyphs.length))], (x + 0.5) * cell, (y + 0.5) * cell);
      }
    }
    ctx.globalAlpha = 1;
  }
  poke() {}
  splash() {}
  nudge() {}
  circle() {}
  scatter() {}
  calm() {}
  dispose() {
    this.disposed = true;
    this.video.pause();
    this.video.removeEventListener("loadeddata", this.onReady);
    this.video.removeEventListener("seeked", this.repaint);
    this.video.removeEventListener("error", this.onError);
    document.removeEventListener("visibilitychange", this.syncPlayback);
    this.motion.removeEventListener("change", this.syncPlayback);
    this.video.removeAttribute("src");
    this.video.load();
  }
}
