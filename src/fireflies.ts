/**
 * A meadow at night. Grass sways along the bottom; fireflies drift above it, each flashing on its
 * own clock. While the agent thinks they fall into step and flash together, as real fireflies do
 * (each nudges its rhythm toward its neighbours', the Kuramoto model), and when the answer lands
 * they scatter up into the dark.
 */
import { GridScene, rgba, type GridPalette, type RGB } from "./grid";
import { clamp, hash3, rand, TAU, valueNoise } from "./math";
import type { Theme } from "./renderer";

interface MeadowPalette extends GridPalette {
  /** Grass, far to near. */
  grass: RGB[];
  bloom: RGB;
  glow: RGB;
  ember: RGB;
  star: RGB | null;
}

const MEADOW: Record<Theme, MeadowPalette> = {
  dark: {
    background: "#04070a",
    grid: "rgba(255,255,255,0.035)",
    grass: [[24, 54, 38], [34, 74, 50], [48, 98, 62]],
    bloom: [156, 128, 196],
    glow: [214, 255, 120],
    ember: [132, 156, 78],
    star: [150, 160, 190],
  },
  light: {
    background: "#f4f2ea",
    grid: "rgba(0,0,0,0.03)",
    grass: [[176, 194, 166], [136, 164, 128], [98, 132, 94]],
    bloom: [200, 120, 160],
    glow: [206, 140, 18],
    ember: [184, 160, 104],
    star: null,
  },
};

interface Fly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  /** Where it is in its flash cycle, in cycles. */
  phase: number;
  /** Flashes per second. */
  freq: number;
  seed: number;
}

interface Blade {
  height: number;
  depth: number;
  bloom: boolean;
}

/** How long a flash lasts, as a fraction of the cycle. */
const FLASH = 0.2;

export class FirefliesScene extends GridScene {
  private flies: Fly[] = [];
  private blades: Blade[] = [];
  private stars: { col: number; row: number; phase: number }[] = [];
  /** How strongly the flies pull each other into step: 0 free, 1 in unison. */
  private sync = 0;
  private syncTarget = 0;
  private lure: { x: number; y: number; until: number } | null = null;

  protected palette() {
    return MEADOW[this.theme];
  }

  protected layout(first: boolean) {
    const { cols, rows, width: W, height: H } = this;
    // Not every column has a blade, so the meadow reads as grass rather than hatching.
    this.blades = Array.from({ length: cols }, (_, c) => ({
      height: hash3(c, 9, 4) < 0.62 ? Math.round(rows * (0.05 + 0.11 * valueNoise(c * 0.07, 0, 3) + 0.04 * hash3(c, 1, 4))) : 0,
      depth: Math.floor(hash3(c, 2, 4) * 3),
      bloom: hash3(c, 3, 4) < 0.05,
    }));
    this.stars = [];
    for (let i = 0; i < (cols * rows) / 90; i++) {
      this.stars.push({ col: Math.floor(hash3(i, 5, 6) * cols), row: Math.floor(hash3(i, 7, 6) * rows * 0.45), phase: hash3(i, 8, 6) * TAU });
    }
    if (first) {
      const count = clamp(Math.round((W * H) / 8000), 50, 200);
      this.flies = Array.from({ length: count }, (_, i) => ({
        x: rand(0, W),
        y: rand(H * 0.22, H * 0.9),
        vx: 0,
        vy: 0,
        heading: rand(0, TAU),
        phase: Math.random(),
        freq: rand(0.32, 0.5),
        seed: i,
      }));
    } else {
      for (const f of this.flies) {
        f.x = clamp(f.x, 0, W);
        f.y = clamp(f.y, 0, H);
      }
    }
  }

  step(dt: number) {
    const { flies, width: W, height: H, time } = this;
    this.time += dt;
    this.sync += (this.syncTarget - this.sync) * Math.min(1, dt * 0.6);
    if (this.lure && time > this.lure.until) this.lure = null;

    // The flock's average rhythm, which each fly leans toward as the sync strengthens.
    let cx = 0;
    let cy = 0;
    for (const f of flies) {
      cx += Math.cos(f.phase * TAU);
      cy += Math.sin(f.phase * TAU);
    }
    const order = Math.hypot(cx, cy) / flies.length;
    const mean = Math.atan2(cy, cx) / TAU;
    const coupling = 3.5 * this.sync;

    for (const f of flies) {
      f.phase += (f.freq + ((coupling * order) / TAU) * Math.sin(TAU * (mean - f.phase))) * dt;
      f.phase -= Math.floor(f.phase);

      // A lazy wander, a little bob, and a pull back toward the meadow when they stray.
      f.heading += (valueNoise(time * 0.35, f.seed, 7) - 0.5) * dt * 3;
      const speed = 10 + 8 * valueNoise(time * 0.2, f.seed, 9);
      let ax = Math.cos(f.heading) * speed - f.vx;
      let ay = Math.sin(f.heading) * speed * 0.6 + Math.sin(time * 1.3 + f.seed) * 4 - f.vy;
      if (f.y < H * 0.18) ay += (H * 0.18 - f.y) * 0.8;
      if (f.y > H * 0.94) ay -= (f.y - H * 0.94) * 0.8;
      if (f.x < 0 || f.x > W) ax += (W / 2 - f.x) * 0.2;

      const pull = this.lure ?? (this.pointer.active ? { x: this.pointer.x, y: this.pointer.y } : null);
      if (pull) {
        const dx = pull.x - f.x;
        const dy = pull.y - f.y;
        const d = Math.hypot(dx, dy);
        const reach = this.lure ? 340 : 180;
        if (d < reach && d > 20) {
          ax += (dx / d) * 30 * (1 - d / reach);
          ay += (dy / d) * 30 * (1 - d / reach);
        }
      }
      f.vx += ax * Math.min(1, dt * 1.5);
      f.vy += ay * Math.min(1, dt * 1.5);
      f.x += f.vx * dt;
      f.y += f.vy * dt;
    }
  }

  protected draw() {
    const p = this.palette();
    const { rows, time, ctx } = this;

    if (p.star) {
      for (const s of this.stars) {
        const a = 0.25 + 0.2 * Math.sin(time * 0.8 + s.phase);
        this.glyph(s.col, s.row, ".", rgba(p.star, a));
      }
    }

    // Grass: each blade leans with the breeze, the tips most of all.
    this.blades.forEach((blade, c) => {
      const sway = Math.sin(time * 0.9 + c * 0.21) * 0.8 + Math.sin(time * 0.37 + c * 0.05) * 0.5;
      const colour = p.grass[blade.depth];
      for (let k = 0; k < blade.height; k++) {
        const rise = k / blade.height;
        const lean = sway * rise;
        const col = c + Math.round(sway * rise ** 1.5 * 1.6);
        const tip = k === blade.height - 1;
        let glyph = lean > 0.35 ? "/" : lean < -0.35 ? "\\" : "|";
        if (tip) glyph = blade.bloom ? "*" : lean > 0.3 ? "/" : lean < -0.3 ? "\\" : "'";
        this.glyph(col, rows - 1 - k, glyph, rgba(tip && blade.bloom ? p.bloom : colour, (this.light ? 0.4 : 0.55) + 0.45 * rise));
      }
    });

    // Fireflies: a brief flash with a soft halo, then just an ember until the next one.
    for (const f of this.flies) {
      const col = this.col(f.x);
      const row = this.row(f.y);
      const c = f.phase;
      const flash = c < FLASH ? Math.sin((Math.PI * c) / FLASH) : 0;
      if (flash < 0.05) {
        this.glyph(col, row, ".", rgba(p.ember, 0.85));
        continue;
      }
      ctx.fillStyle = rgba(p.glow, (this.light ? 0.18 : 0.22) * flash);
      ctx.fillRect(col * this.cw + 1, row * this.ch + 1, this.cw - 1, this.ch - 1);
      for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        this.glyph(col + dc, row + dr, ".", rgba(p.glow, 0.45 * flash));
      }
      this.glyph(col, row, flash > 0.55 ? "*" : flash > 0.25 ? "+" : ".", rgba(p.glow, 0.5 + 0.5 * flash));
    }
  }

  // ── reactions ───────────────────────────────────────────────────────

  /** Click: the nearby ones flash at once and drift over to the spot. */
  poke(x: number, y: number) {
    this.lure = { x, y, until: this.time + 6 };
    for (const f of this.flies) if (Math.hypot(f.x - x, f.y - y) < 160) f.phase = 0;
  }

  /** A message out: a ring of flashes spreads from it across the meadow. */
  splash(x: number, y: number) {
    for (const f of this.flies) {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d < 700) f.phase = (1 - d / 900) % 1;
    }
  }

  /** A keystroke: the nearest firefly flashes. */
  nudge(x: number, y: number) {
    let best: Fly | null = null;
    let bestD = 260;
    for (const f of this.flies) {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d < bestD && f.phase > FLASH) {
        bestD = d;
        best = f;
      }
    }
    if (best) best.phase = 0;
  }

  circle() {
    this.syncTarget = 1;
  }

  /** The answer: out of step again, and up and away from the reply. */
  scatter(x: number, y: number) {
    this.syncTarget = 0;
    this.sync *= 0.3;
    for (const f of this.flies) {
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy) || 1;
      const push = 70 * Math.max(0, 1 - d / 900);
      f.vx += (dx / d) * push;
      f.vy += (dy / d) * push - 30;
      f.phase = (f.phase + rand(-0.15, 0.15) + 1) % 1;
    }
  }

  calm() {
    this.syncTarget = 0;
  }
}
