/**
 * A campfire at night. The flames are a heat field rising off crossed logs, drawn as glyphs that run
 * from dull red to white-hot; sparks float up and smoke curls above, inside a ring of stones under
 * two dark pines. While the agent thinks the fire builds; the answer throws a shower of sparks.
 * Click to toss on a stick.
 */
import { GridScene, rgba, type GridPalette, type RGB } from "./grid";
import { clamp, hash3, rand, valueNoise } from "./math";
import type { Theme } from "./renderer";

interface FirePalette extends GridPalette {
  /** Flame colour from coolest to hottest. */
  flame: RGB[];
  /** Glow behind the hottest cells. */
  glow: number;
  log: RGB;
  logInk: RGB;
  stone: RGB;
  smoke: RGB;
  pine: RGB;
  star: RGB | null;
}

const FIRE: Record<Theme, FirePalette> = {
  dark: {
    background: "#06050a",
    grid: "rgba(255,255,255,0.03)",
    flame: [[110, 22, 12], [196, 46, 18], [250, 116, 30], [255, 196, 70], [255, 244, 206]],
    glow: 0.22,
    log: [70, 44, 28],
    logInk: [150, 100, 64],
    stone: [72, 70, 76],
    smoke: [110, 108, 118],
    pine: [14, 20, 18],
    star: [160, 166, 196],
  },
  light: {
    background: "#f4efe6",
    grid: "rgba(60,40,20,0.04)",
    flame: [[220, 150, 130], [214, 96, 60], [214, 92, 24], [196, 70, 16], [150, 44, 10]],
    glow: 0.12,
    log: [150, 112, 82],
    logInk: [90, 60, 38],
    stone: [190, 186, 180],
    smoke: [170, 168, 172],
    pine: [176, 192, 176],
    star: null,
  },
};

/** Upright glyphs, so the flames read as tongues rather than stripes. */
const RAMP = " .':;!|*#@";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  span: number;
}

export class CampfireScene extends GridScene {
  /** Heat per fire cell, bottom row first. */
  private heat = new Float32Array(0);
  private fw = 0;
  private fh = 0;
  private left = 0;
  private base = 0;
  private tick = 0;
  private intensity = 1;
  private target = 1;
  private flare = 0;
  private sparks: Particle[] = [];
  private smoke: Particle[] = [];
  private stars: { col: number; row: number; phase: number }[] = [];

  protected palette() {
    return FIRE[this.theme];
  }

  protected layout() {
    const { cols, rows, width: W, height: H, cw, ch } = this;
    this.fw = clamp(Math.round(Math.min(W * 0.22, 300) / cw), 14, 38);
    this.fh = Math.round((H * 0.42) / ch);
    this.left = Math.round(cols / 2 - this.fw / 2);
    this.base = Math.round((H * 0.84) / ch);
    this.heat = new Float32Array(this.fw * this.fh);
    this.stars = [];
    for (let i = 0; i < (cols * rows) / 110; i++) {
      this.stars.push({ col: Math.floor(hash3(i, 1, 71) * cols), row: Math.floor(hash3(i, 2, 71) * rows * 0.5), phase: hash3(i, 3, 71) * 6.3 });
    }
  }

  step(dt: number) {
    this.time += dt;
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * 0.7);
    this.flare = Math.max(0, this.flare - dt * 0.5);
    const strength = this.intensity + this.flare;

    // The flames move at a steady thirty frames a second, which suits fire better than sixty.
    this.tick += dt;
    while (this.tick >= 1 / 30) {
      this.tick -= 1 / 30;
      this.burn(strength);
    }

    // Sparks off the top of the fire, more of them as it builds.
    if (Math.random() < dt * 5 * strength) this.spark(1);
    if (Math.random() < dt * 3) {
      this.smoke.push({ x: this.centreX() + rand(-20, 20), y: (this.base - this.fh * 0.7) * this.ch, vx: rand(-4, 4), vy: rand(-22, -14), life: 0, span: rand(4, 7) });
    }
    for (const s of this.sparks) {
      s.life += dt;
      s.vx += (valueNoise(s.x * 0.02, this.time, 3) - 0.5) * 120 * dt;
      s.vy -= 10 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (const s of this.smoke) {
      s.life += dt;
      s.x += (s.vx + Math.sin(this.time * 0.8 + s.span) * 8) * dt;
      s.y += s.vy * dt;
    }
    this.sparks = this.sparks.filter((s) => s.life < s.span);
    this.smoke = this.smoke.filter((s) => s.life < s.span);
  }

  private centreX() {
    return (this.left + this.fw / 2) * this.cw;
  }

  /** One update of the heat field: fresh heat on the logs, each cell fed from below and cooling as it rises. */
  private burn(strength: number) {
    const { heat, fw, fh, time } = this;
    for (let i = 0; i < fw; i++) {
      const centre = 1 - Math.abs(i - fw / 2) / (fw / 2);
      heat[i] = Math.min(1.2, strength * centre ** 0.6 * (0.6 + 0.4 * Math.random()));
    }
    for (let r = fh - 1; r >= 1; r--) {
      for (let i = 0; i < fw; i++) {
        const below = (r - 1) * fw;
        const twoBelow = Math.max(0, r - 2) * fw;
        // Each cell draws mostly from one cell below, picked with a little sideways wander.
        const from = clamp(i + Math.round((Math.random() - 0.5) * 2.2), 0, fw - 1);
        const sum = heat[below + from] * 3 + heat[below + i] + heat[twoBelow + i];
        // Cooling varies with a rising noise, which is what makes the flames lick.
        const lick = valueNoise(i * 0.45, r * 0.22 - time * 2.6, 9);
        const cool = 0.008 + (0.09 * lick * lick) / Math.max(0.6, strength);
        heat[r * fw + i] = Math.max(0, (sum / 5) * (0.985 - 0.02 * Math.random()) - cool);
      }
    }
  }

  private spark(count: number) {
    for (let k = 0; k < count; k++) {
      this.sparks.push({
        x: this.centreX() + rand(-this.fw * this.cw * 0.25, this.fw * this.cw * 0.25),
        y: (this.base - rand(2, this.fh * 0.5)) * this.ch,
        vx: rand(-20, 20),
        vy: rand(-140, -60),
        life: 0,
        span: rand(0.9, 2.4),
      });
    }
  }

  protected draw() {
    const p = this.palette();
    const { cols, rows, fw, fh, left, base, heat, time } = this;

    if (p.star) for (const s of this.stars) this.glyph(s.col, s.row, ".", rgba(p.star, 0.25 + 0.15 * Math.sin(time + s.phase)));

    // Two pines, one either side, and the ground the fire lights.
    for (const [cx, height] of [[cols * 0.1, rows * 0.42], [cols * 0.9, rows * 0.36]] as const) {
      const top = rows - height;
      for (let r = Math.round(top); r < rows; r++) {
        const half = Math.round(((r - top) / height) * height * 0.32 * (1 + 0.25 * Math.sin(r * 1.7)));
        for (let c = Math.round(cx - half); c <= Math.round(cx + half); c++) {
          this.tile(c, r, rgba(p.pine, 0.95));
          if (Math.abs(c - cx) === half) this.glyph(c, r, c < cx ? "/" : "\\", rgba(p.pine.map((v) => v * (this.light ? 0.8 : 2.4)) as RGB, 0.9));
        }
      }
    }
    for (let c = 0; c < cols; c++) {
      const d = Math.abs(c - (left + fw / 2)) / (fw * 1.6);
      for (let r = base + 1; r < rows; r++) {
        if (d < 1 && hash3(c, r, 73) < 0.25 * (1 - d)) this.glyph(c, r, ".", rgba(p.flame[2], 0.35 * (1 - d) * this.intensity));
      }
    }

    // The fire itself.
    for (let r = 0; r < fh; r++) {
      for (let i = 0; i < fw; i++) {
        const h = heat[r * fw + i];
        if (h < 0.06) continue;
        const col = left + i;
        const row = base - r;
        const shade = Math.min(0.999, h);
        const colour = p.flame[Math.min(p.flame.length - 1, Math.floor(shade * p.flame.length))];
        if (h > 0.45) this.tile(col, row, rgba(colour, p.glow * h));
        this.glyph(col, row, RAMP[Math.floor(shade * RAMP.length)], rgba(colour, clamp(0.35 + h, 0, 1)));
      }
    }

    // Crossed logs at the base, glowing where they burn, inside a ring of stones.
    const mid = left + fw / 2;
    for (let k = -Math.round(fw * 0.42); k <= Math.round(fw * 0.42); k++) {
      for (const sign of [1, -1]) {
        const col = Math.round(mid + k);
        const row = base + 1 + Math.round((sign * k) / (fw * 0.42) + 1) - 1;
        this.tile(col, row, rgba(p.log, 0.95));
        const ember = Math.abs(k) < fw * 0.25 && hash3(col, row, Math.floor(time * 4)) < 0.3;
        this.glyph(col, row, ember ? "*" : Math.abs(k) === Math.round(fw * 0.42) ? "o" : "=", rgba(ember ? p.flame[2] : p.logInk));
      }
    }
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI;
      const col = Math.round(mid + Math.cos(a) * (fw * 0.62));
      const row = base + 2 + Math.round(Math.sin(a) * 1.4);
      this.tile(col, row, rgba(p.stone, 0.95));
      this.glyph(col, row, "o", rgba(p.stone.map((v) => v * (this.light ? 0.7 : 1.8)) as RGB));
    }

    for (const s of this.smoke) {
      const age = s.life / s.span;
      this.glyph(this.col(s.x), this.row(s.y), age < 0.5 ? "~" : ".", rgba(p.smoke, 0.35 * (1 - age)));
    }
    for (const s of this.sparks) {
      const age = s.life / s.span;
      this.glyph(this.col(s.x), this.row(s.y), age < 0.3 ? "*" : age < 0.7 ? "'" : ".", rgba(age < 0.5 ? p.flame[3] : p.flame[1], 1 - age));
    }
  }

  // ── reactions ───────────────────────────────────────────────────────

  /** Click: a stick on the fire; it flares and throws sparks. */
  poke() {
    this.flare = 0.7;
    this.spark(18);
  }

  splash() {
    this.spark(8);
  }

  /** A keystroke: one spark pops. */
  nudge() {
    this.spark(1);
  }

  circle() {
    this.target = 1.55;
  }

  /** The answer: a shower of sparks, and the fire settles back. */
  scatter() {
    this.target = 1;
    this.spark(50);
  }

  calm() {
    this.target = 1;
  }
}
