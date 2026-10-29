/**
 * The night sky, turning slowly about a pole star just off the top of the screen: twinkling stars,
 * the faint band of the Milky Way, a line of hills. On paper it becomes a printed star chart.
 * While the agent thinks a constellation draws itself between the brighter stars, connecting the
 * dots; when the answer lands a shooting star leaves from the reply and the figure fades.
 */
import { GridScene, lineGlyph, rgba, type GridPalette, type RGB } from "./grid";
import { clamp, hash3, rand, smoothstep, TAU, valueNoise } from "./math";
import type { Theme } from "./renderer";

interface NightPalette extends GridPalette {
  stars: [RGB, RGB, RGB];
  milky: RGB;
  hills: RGB;
  line: RGB;
  meteor: RGB;
}

const NIGHT: Record<Theme, NightPalette> = {
  dark: {
    background: "#03050c",
    grid: "rgba(255,255,255,0.03)",
    stars: [[180, 205, 255], [236, 238, 250], [255, 214, 170]],
    milky: [126, 124, 176],
    hills: [10, 14, 24],
    line: [94, 234, 212],
    meteor: [255, 248, 232],
  },
  light: {
    background: "#f3eee2",
    grid: "rgba(60,50,30,0.05)",
    stars: [[40, 70, 140], [38, 40, 54], [150, 82, 40]],
    milky: [168, 156, 190],
    hills: [218, 208, 186],
    line: [13, 148, 136],
    meteor: [176, 92, 40],
  },
};

interface Star {
  /** Position with the sky unturned; the drawing turns it about the pole. */
  sx: number;
  sy: number;
  mag: number;
  tint: number;
  phase: number;
  freq: number;
  flare: number;
  /** Put there by a click. */
  added?: boolean;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  until: number;
  trail: [number, number][];
}

/** How fast the sky turns, radians per second. */
const SPIN = 0.0035;

export class SkyScene extends GridScene {
  private stars: Star[] = [];
  private hills: number[] = [];
  private pole = { x: 0, y: 0 };
  private figure: { stars: number[]; start: number; fadeFrom: number | null } | null = null;
  private drawing = false;
  private meteors: Meteor[] = [];
  private nextMeteor = 15;
  private births: { x: number; y: number; at: number }[] = [];

  protected palette() {
    return NIGHT[this.theme];
  }

  protected layout(first: boolean) {
    const { cols, rows, width: W, height: H } = this;
    this.pole = { x: W * 0.82, y: -H * 0.15 };
    this.hills = Array.from({ length: cols }, (_, c) => Math.round(rows * (0.04 + 0.08 * valueNoise(c * 0.02, 0, 21))));
    if (!first && this.stars.length) return;
    // Stars fill a whole ring about the pole, so the turning sky never runs out of them.
    const reach = Math.hypot(Math.max(this.pole.x, W - this.pole.x), H - this.pole.y) + 40;
    const count = Math.round(((Math.PI * reach * reach) / 2200) * 0.6);
    this.stars = Array.from({ length: count }, (_, i) => {
      const a = hash3(i, 1, 31) * TAU;
      const r = Math.sqrt(hash3(i, 2, 31)) * reach;
      return {
        sx: this.pole.x + Math.cos(a) * r,
        sy: this.pole.y + Math.sin(a) * r,
        mag: hash3(i, 3, 31) ** 3,
        tint: Math.floor(hash3(i, 4, 31) * 3),
        phase: hash3(i, 5, 31) * TAU,
        freq: 0.6 + hash3(i, 6, 31) * 2.2,
        flare: 0,
      };
    });
  }

  /** Where a star is on screen now. */
  private place(s: { sx: number; sy: number }) {
    const a = this.time * SPIN;
    const dx = s.sx - this.pole.x;
    const dy = s.sy - this.pole.y;
    return {
      x: this.pole.x + dx * Math.cos(a) - dy * Math.sin(a),
      y: this.pole.y + dx * Math.sin(a) + dy * Math.cos(a),
    };
  }

  /** The inverse: a screen point as a position in the unturned sky. */
  private unplace(x: number, y: number) {
    const a = -this.time * SPIN;
    const dx = x - this.pole.x;
    const dy = y - this.pole.y;
    return { sx: this.pole.x + dx * Math.cos(a) - dy * Math.sin(a), sy: this.pole.y + dx * Math.sin(a) + dy * Math.cos(a) };
  }

  step(dt: number) {
    this.time += dt;
    for (const s of this.stars) s.flare = Math.max(0, s.flare - dt * 1.2);
    if (this.drawing && !this.figure) this.startFigure();
    if (this.figure?.fadeFrom != null && this.time - this.figure.fadeFrom > 3) this.figure = null;

    // Now and then a shooting star of its own.
    if (this.time > this.nextMeteor) {
      this.nextMeteor = this.time + rand(18, 40);
      const fromLeft = Math.random() < 0.5;
      this.launch(fromLeft ? rand(0, this.width * 0.5) : rand(this.width * 0.5, this.width), rand(0, this.height * 0.3), fromLeft ? 1 : -1, 0.35);
    }
    for (const m of this.meteors) {
      m.trail.unshift([m.x, m.y]);
      m.trail.length = Math.min(m.trail.length, 16);
      m.x += m.vx * dt;
      m.y += m.vy * dt;
    }
    this.meteors = this.meteors.filter((m) => m.until > this.time);
    this.births = this.births.filter((b) => this.time - b.at < 0.8);
  }

  private launch(x: number, y: number, dir: number, drop: number) {
    const speed = 760;
    const a = dir > 0 ? drop : Math.PI - drop;
    this.meteors.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, until: this.time + 1.2, trail: [] });
  }

  /** Pick a figure: from a bright star near the middle, hop to the nearest bright neighbours, keeping a heading. */
  private startFigure() {
    const { width: W, height: H } = this;
    const seen = this.stars.map((s, i) => ({ i, ...this.place(s), mag: s.mag }));
    const bright = seen.filter((s) => s.mag > 0.45 && s.x > W * 0.12 && s.x < W * 0.88 && s.y > H * 0.08 && s.y < H * 0.62);
    if (bright.length < 4) return;
    const aim = { x: rand(W * 0.3, W * 0.7), y: rand(H * 0.15, H * 0.4) };
    let at = bright.reduce((a, b) => (Math.hypot(b.x - aim.x, b.y - aim.y) < Math.hypot(a.x - aim.x, a.y - aim.y) ? b : a));
    const path = [at.i];
    let heading = rand(0, TAU);
    for (let k = 0; k < 7; k++) {
      let best: (typeof bright)[number] | null = null;
      let bestScore = Infinity;
      for (const s of bright) {
        if (path.includes(s.i)) continue;
        const d = Math.hypot(s.x - at.x, s.y - at.y);
        if (d < 50 || d > 260) continue;
        const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(s.y - at.y, s.x - at.x) - heading), Math.cos(Math.atan2(s.y - at.y, s.x - at.x) - heading)));
        const score = d * (1 + 0.5 * turn);
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
      if (!best) break;
      heading = Math.atan2(best.y - at.y, best.x - at.x);
      path.push(best.i);
      at = best;
    }
    this.figure = { stars: path, start: this.time, fadeFrom: null };
  }

  protected draw() {
    const p = this.palette();
    const { cols, rows, time } = this;
    const occupied = new Set<number>();

    // The Milky Way: a soft, uneven band across the sky, turning with it.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const { sx, sy } = this.unplace(c * this.cw + this.cw / 2, r * this.ch + this.ch / 2);
        const across = (sx * 0.55 - sy * 0.83 + this.width * 0.1) / (this.height * 0.16);
        const band = Math.exp(-across * across) * valueNoise(sx * 0.012, sy * 0.012, 41);
        if (band < 0.32) continue;
        if (hash3(c, r, 43) > band) continue;
        this.glyph(c, r, band > 0.62 ? ":" : ".", rgba(p.milky, 0.2 + 0.25 * band));
      }
    }

    // Stars: a twinkling dot, cross, or star by brightness; the brightest throw short spikes.
    for (const s of this.stars) {
      const { x, y } = this.place(s);
      const c = this.col(x);
      const r = this.row(y);
      if (!this.inGrid(c, r) || r >= rows - this.hills[c]) continue;
      const b = clamp(s.mag * (0.75 + 0.25 * Math.sin(time * s.freq + s.phase)) + s.flare, 0, 1.4);
      if (b < 0.06) continue;
      occupied.add(r * cols + c);
      const colour = p.stars[s.tint];
      this.glyph(c, r, b < 0.45 ? "." : b < 0.72 ? "+" : "*", rgba(colour, clamp(0.35 + b * 0.65, 0, 1)));
      if (b > 0.9) {
        for (const [dc, dr, g] of [[-1, 0, "-"], [1, 0, "-"], [0, -1, "|"], [0, 1, "|"]] as const) {
          this.glyph(c + dc, r + dr, g, rgba(colour, 0.25 * (b - 0.8) * 4));
        }
      }
    }

    // New stars bloom out of a little ring.
    for (const b of this.births) {
      const age = (time - b.at) / 0.8;
      const ring = 10 + age * 40;
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * TAU;
        this.glyph(this.col(b.x + Math.cos(a) * ring), this.row(b.y + Math.sin(a) * ring * 0.7), ".", rgba(p.stars[1], 0.6 * (1 - age)));
      }
    }

    this.drawFigure(p, occupied);

    for (const m of this.meteors) {
      const life = clamp((m.until - time) / 1.2, 0, 1);
      m.trail.forEach(([x, y], k) => {
        const g = k < 4 ? lineGlyph(Math.atan2(m.vy, m.vx)) : ".";
        this.glyph(this.col(x), this.row(y), g, rgba(p.meteor, life * (1 - k / m.trail.length)));
      });
      this.glyph(this.col(m.x), this.row(m.y), "*", rgba(p.meteor, life));
    }

    // Hills along the bottom, their top edge drawn along the slope.
    for (let c = 0; c < cols; c++) {
      const h = this.hills[c];
      for (let k = 0; k < h; k++) this.tile(c, rows - 1 - k, rgba(p.hills, 0.95));
      const next = this.hills[c + 1] ?? h;
      const prev = this.hills[c - 1] ?? h;
      const ink = rgba(p.hills.map((v) => (this.light ? v * 0.7 : Math.min(255, v * 3.5 + 20))) as RGB, 0.9);
      this.glyph(c, rows - 1 - h, next > h ? "/" : prev > h ? "\\" : "_", ink);
    }
  }

  /** The constellation: each line draws out in turn, its stars marked once reached. */
  private drawFigure(p: NightPalette, occupied: Set<number>) {
    const fig = this.figure;
    if (!fig) return;
    const fade = fig.fadeFrom == null ? 1 : clamp(1 - (this.time - fig.fadeFrom) / 3, 0, 1);
    const points = fig.stars.map((i) => this.place(this.stars[i]));
    for (let k = 0; k < points.length - 1; k++) {
      const progress = smoothstep(0, 1, (this.time - fig.start - k * 0.8) / 0.7);
      if (progress <= 0) break;
      const a = points[k];
      const b = points[k + 1];
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const length = Math.hypot(b.x - a.x, b.y - a.y) * progress;
      const glyph = lineGlyph(angle);
      let last = -1;
      // Stop short of each star so it keeps its own glyph.
      for (let t = 10; t < length - 6; t += this.cw * 0.6) {
        const c = this.col(a.x + Math.cos(angle) * t);
        const r = this.row(a.y + Math.sin(angle) * t);
        const cell = r * this.cols + c;
        if (cell === last || occupied.has(cell)) continue;
        last = cell;
        this.glyph(c, r, glyph, rgba(p.line, 0.75 * fade));
      }
    }
    points.forEach((pt, k) => {
      if (this.time - fig.start < (k - 1) * 0.8 + 0.7) return;
      this.glyph(this.col(pt.x), this.row(pt.y), "o", rgba(p.line, fade));
    });
  }

  // ── reactions ───────────────────────────────────────────────────────

  /** Click: a new star, right there. */
  poke(x: number, y: number) {
    if (this.row(y) >= this.rows - this.hills[this.col(x)]) return;
    const { sx, sy } = this.unplace(x, y);
    this.stars.push({ sx, sy, mag: 0.95, tint: 1, phase: 0, freq: 1.2, flare: 0.5, added: true });
    // Keep the last forty; the oldest added star goes quietly.
    if (this.stars.filter((s) => s.added).length > 40) this.stars.splice(this.stars.findIndex((s) => s.added), 1);
    this.births.push({ x, y, at: this.time });
  }

  /** A keystroke: the nearest star flares. */
  nudge(x: number, y: number) {
    let best: Star | null = null;
    let bestD = 220;
    for (const s of this.stars) {
      const at = this.place(s);
      const d = Math.hypot(at.x - x, at.y - y);
      if (d < bestD && s.mag > 0.2) {
        bestD = d;
        best = s;
      }
    }
    if (best) best.flare = 0.6;
  }

  circle() {
    this.drawing = true;
    if (this.figure?.fadeFrom != null) this.figure = null;
  }

  /** The answer: a shooting star leaves from the reply, and the figure fades. */
  scatter(x: number, y: number) {
    this.drawing = false;
    if (this.figure) this.figure.fadeFrom = this.time;
    this.launch(x, y, x < this.width / 2 ? -1 : 1, -0.5);
  }

  calm() {
    this.drawing = false;
    if (this.figure) this.figure.fadeFrom = this.time;
  }
}
