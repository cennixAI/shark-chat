/**
 * A dry garden. Raked gravel runs in quiet lines that curve into rings around a few stones. The
 * garden breathes: the gravel brightens for four seconds and dims for six, a pace to breathe along
 * with. Click to set a stone (or lift one), and the rake works new rings out around it. While the
 * agent thinks, ripples travel out through the rings; when the answer lands, one ripple spreads from
 * the reply. Now and then a maple leaf drifts down.
 */
import { GridScene, rgba, type GridPalette, type RGB } from "./grid";
import { clamp, hash3, rand, smoothstep, TAU, valueNoise } from "./math";
import type { Theme } from "./renderer";

interface GardenPalette extends GridPalette {
  groove: RGB;
  stone: RGB;
  moss: RGB;
  leaf: RGB[];
  ripple: RGB;
}

const GARDEN: Record<Theme, GardenPalette> = {
  dark: {
    background: "#0b0c0f",
    grid: "rgba(255,255,255,0.03)",
    groove: [118, 124, 136],
    stone: [150, 154, 162],
    moss: [70, 112, 62],
    leaf: [[206, 82, 52], [222, 132, 50]],
    ripple: [176, 196, 214],
  },
  light: {
    background: "#efebe1",
    grid: "rgba(60,50,30,0.04)",
    groove: [150, 140, 122],
    stone: [138, 136, 132],
    moss: [112, 150, 92],
    leaf: [[198, 74, 40], [214, 128, 40]],
    ripple: [96, 86, 70],
  },
};

/** The ramp the sharks' skin uses: sparse where a stone catches the light, dense in its shadow. */
const SKIN = ":;t%SX8#@";
/** Gravel lines are this far apart. */
const SPACING = 24;
/** How far out around a stone the rake draws rings. */
const RINGS = 5;
const SUN = [-0.5, -0.65, 0.6];

interface Stone {
  x: number;
  y: number;
  rx: number;
  ry: number;
  seed: number;
  at: number;
}

interface Ripple {
  x: number;
  y: number;
  at: number;
  speed: number;
  life: number;
}

interface Leaf {
  x: number;
  y: number;
  land: number;
  phase: number;
  landedAt: number | null;
  tint: number;
}

export class ZenScene extends GridScene {
  private stones: Stone[] = [];
  /** Per cell: the gravel glyph ("" for none), and when the rake reaches it. */
  private grooves: string[] = [];
  private rakedAt = new Float32Array(0);
  private ripples: Ripple[] = [];
  private leaves: Leaf[] = [];
  private nextLeaf = 6;
  private thinking = false;
  private nextPulse = 0;
  /** The settled gravel, drawn once and reused until a stone moves or the theme changes. */
  private cache = document.createElement("canvas");
  private cacheReady = false;

  protected palette() {
    return GARDEN[this.theme];
  }

  setTheme(theme: Theme) {
    super.setTheme(theme);
    this.cacheReady = false;
  }

  protected layout(first: boolean) {
    const { width: W, height: H } = this;
    if (first) {
      const base = Math.min(W, H);
      this.stones = [
        [0.2, 0.3, 0.05],
        [0.8, 0.24, 0.035],
        [0.7, 0.76, 0.045],
        [0.26, 0.78, 0.03],
      ].map(([fx, fy, size], i) => ({ x: W * fx, y: H * fy, rx: base * size, ry: base * size * 0.72, seed: i + 1, at: -10 }));
    }
    this.rake(-10);
  }

  /** Work out the gravel: rings around each stone within reach of it, straight lines elsewhere. */
  private rake(now: number, around?: Stone) {
    const { cols, rows, cw, ch } = this;
    this.grooves = new Array(cols * rows).fill("");
    if (this.rakedAt.length !== cols * rows) this.rakedAt = new Float32Array(cols * rows).fill(-10);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw + cw / 2;
        const y = r * ch + ch / 2;
        let nearest: Stone | null = null;
        let d = Infinity;
        for (const s of this.stones) {
          const e = Math.hypot((x - s.x) / s.rx, (y - s.y) / s.ry);
          const gap = (e - 1) * (s.rx + s.ry) * 0.5;
          if (gap < d) {
            d = gap;
            nearest = s;
          }
        }
        const i = r * cols + c;
        if (nearest && d < 0) continue;
        let glyph = "";
        if (nearest && d < RINGS * SPACING) {
          if ((d / SPACING) % 1 < 0.5) {
            // Along the ring: its direction is square to the line out from the stone.
            const tangent = Math.atan2((y - nearest.y) / nearest.ry ** 2, (x - nearest.x) / nearest.rx ** 2) + Math.PI / 2;
            const a = ((tangent % Math.PI) + Math.PI) % Math.PI;
            glyph = a < 0.45 || a > Math.PI - 0.45 ? "~" : a > Math.PI / 2 - 0.4 && a < Math.PI / 2 + 0.4 ? (x < nearest.x ? "(" : ")") : (a < Math.PI / 2) === (y > nearest.y) ? "/" : "\\";
          }
          if (around === nearest) this.rakedAt[i] = now + d / 110;
        } else if (((y + valueNoise(x * 0.004, 0, 81) * 6) / SPACING) % 1 < 0.5) {
          glyph = "~";
        }
        this.grooves[i] = glyph;
      }
    }
    this.cacheReady = false;
  }

  step(dt: number) {
    this.time += dt;
    const { width: W, height: H } = this;
    if (this.thinking && this.time > this.nextPulse) {
      this.nextPulse = this.time + 2.6;
      this.ripples.push({ x: W / 2, y: H * 0.45, at: this.time, speed: 95, life: 7 });
    }
    this.ripples = this.ripples.filter((r) => this.time - r.at < r.life);

    if (this.time > this.nextLeaf && this.leaves.length < 3) {
      this.nextLeaf = this.time + rand(14, 26);
      this.leaves.push({ x: rand(W * 0.1, W * 0.9), y: -10, land: rand(H * 0.35, H * 0.95), phase: rand(0, TAU), landedAt: null, tint: Math.floor(rand(0, 2)) });
    }
    for (const leaf of this.leaves) {
      if (leaf.landedAt != null) continue;
      leaf.y += 16 * dt;
      leaf.x += Math.sin(this.time * 0.9 + leaf.phase) * 18 * dt;
      if (leaf.y >= leaf.land) leaf.landedAt = this.time;
    }
    this.leaves = this.leaves.filter((l) => l.landedAt == null || this.time - l.landedAt < 12);
  }

  /** Breathing: up over four seconds, down over six. */
  private breath() {
    const t = this.time % 10;
    return t < 4 ? smoothstep(0, 4, t) : 1 - smoothstep(4, 10, t);
  }

  protected draw() {
    const p = this.palette();
    const { cols, grooves, rakedAt, time, ctx } = this;
    const raking = rakedAt.some((t) => t > time);

    // The settled gravel comes from the cache, its brightness rising and falling with the breath.
    ctx.globalAlpha = 0.55 + 0.35 * this.breath();
    if (raking) {
      for (let i = 0; i < grooves.length; i++) {
        if (grooves[i] && rakedAt[i] <= time) this.glyph(i % cols, (i / cols) | 0, grooves[i], rgba(p.groove));
      }
    } else {
      if (!this.cacheReady) this.paintCache(p);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.cache, 0, 0);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    ctx.globalAlpha = 1;

    // Ripples: the gravel brightens where a ring of disturbance passes through it.
    for (const ripple of this.ripples) {
      const age = time - ripple.at;
      const radius = age * ripple.speed;
      const fade = 1 - age / ripple.life;
      const r0 = Math.max(0, this.row(ripple.y - radius - 20));
      const r1 = Math.min(this.rows - 1, this.row(ripple.y + radius + 20));
      for (let r = r0; r <= r1; r++) {
        for (let c = Math.max(0, this.col(ripple.x - radius - 20)); c <= Math.min(cols - 1, this.col(ripple.x + radius + 20)); c++) {
          const g = grooves[r * cols + c];
          if (!g) continue;
          const off = Math.abs(Math.hypot(c * this.cw + this.cw / 2 - ripple.x, r * this.ch + this.ch / 2 - ripple.y) - radius);
          if (off < 18) this.glyph(c, r, g, rgba(p.ripple, (1 - off / 18) * fade * 0.85));
        }
      }
    }

    for (const stone of this.stones) this.drawStone(stone, p);

    for (const leaf of this.leaves) {
      const fade = leaf.landedAt == null ? 1 : clamp(1 - (time - leaf.landedAt) / 12, 0, 1);
      const c = this.col(leaf.x);
      const r = this.row(leaf.y);
      this.tile(c, r, rgba(p.leaf[leaf.tint], 0.3 * fade));
      this.glyph(c, r, "*", rgba(p.leaf[leaf.tint], fade));
    }
  }

  private paintCache(p: GardenPalette) {
    const { cols, grooves, cw, ch, dpr } = this;
    this.cache.width = this.canvas.width;
    this.cache.height = this.canvas.height;
    const g = this.cache.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.width, this.height);
    g.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = rgba(p.groove);
    for (let i = 0; i < grooves.length; i++) {
      if (grooves[i]) g.fillText(grooves[i], (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
    this.cacheReady = true;
  }

  /** A stone, lit from the top left like the sharks, settling in as it's set down, moss on some. */
  private drawStone(s: Stone, p: GardenPalette) {
    const settle = smoothstep(0, 0.6, this.time - s.at);
    const rx = s.rx * (0.6 + 0.4 * settle);
    const ry = s.ry * (0.6 + 0.4 * settle);
    for (let r = this.row(s.y - ry); r <= this.row(s.y + ry); r++) {
      for (let c = this.col(s.x - rx); c <= this.col(s.x + rx); c++) {
        const nx = (c * this.cw + this.cw / 2 - s.x) / rx;
        const ny = (r * this.ch + this.ch / 2 - s.y) / ry;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);
        const lit = (nx * SUN[0] + ny * SUN[1] + nz * SUN[2]) / Math.hypot(...SUN);
        const shade = clamp(0.5 + 0.55 * lit, 0, 1);
        const mossy = s.seed % 2 === 1 && ny < -0.15 && valueNoise(c * 0.6, r * 0.6, s.seed) > 0.45;
        const base = mossy ? p.moss : p.stone;
        const tone = this.light ? 0.75 + 0.45 * shade : 0.35 + 0.75 * shade;
        const tile = base.map((v) => Math.min(255, v * tone)) as RGB;
        this.tile(c, r, rgba(tile, settle));
        const ink = tile.map((v) => (this.light ? v * 0.6 : Math.min(255, v * 1.5 + 20))) as RGB;
        const glyph = mossy ? ":;"[(c + r) % 2] : SKIN[clamp(Math.floor((1 - shade) * 8.99) + Math.floor(hash3(c, r, s.seed) * 3) - 1, 0, 8)];
        this.glyph(c, r, glyph, rgba(ink, settle));
      }
    }
  }

  // ── reactions ───────────────────────────────────────────────────────

  /** Click: set a stone there, or lift the one that's there, and rake around it. */
  poke(x: number, y: number) {
    const hit = this.stones.find((s) => Math.hypot((x - s.x) / s.rx, (y - s.y) / s.ry) < 1);
    if (hit) {
      this.stones.splice(this.stones.indexOf(hit), 1);
      this.rake(this.time);
      return;
    }
    const base = Math.min(this.width, this.height);
    const size = base * rand(0.022, 0.045);
    const stone = { x, y, rx: size, ry: size * rand(0.62, 0.8), seed: Math.floor(rand(1, 999)), at: this.time };
    this.stones.push(stone);
    if (this.stones.length > 7) this.stones.shift();
    this.rake(this.time, stone);
  }

  /** A message out: a ripple from the composer. */
  splash(x: number, y: number) {
    this.ripples.push({ x, y, at: this.time, speed: 110, life: 6 });
  }

  /** A keystroke: the faintest ripple where you're typing. */
  nudge(x: number, y: number) {
    this.ripples.push({ x, y, at: this.time, speed: 70, life: 1.2 });
    if (this.ripples.length > 24) this.ripples.shift();
  }

  circle() {
    this.thinking = true;
    this.nextPulse = this.time;
  }

  /** The answer: one ripple from the reply, and the garden goes still again. */
  scatter(x: number, y: number) {
    this.thinking = false;
    this.ripples.push({ x, y, at: this.time, speed: 120, life: 6 });
  }

  calm() {
    this.thinking = false;
  }
}
