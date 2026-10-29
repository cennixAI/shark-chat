/**
 * A murmuration at dusk: a few hundred starlings flocking as one above a distant treeline, drawn as
 * density, so the glyphs thicken where the flock does. While the agent thinks the flock pulls into a
 * tight, turning ball; when the answer lands it bursts apart and re-forms. A click sends a falcon
 * diving through, and the flock flows around it.
 */
import { GridScene, rgba, type GridPalette, type RGB } from "./grid";
import { clamp, hash3, rand, TAU, valueNoise } from "./math";
import type { Theme } from "./renderer";

interface DuskPalette extends GridPalette {
  bird: RGB;
  trees: RGB;
  wire: RGB;
  falcon: RGB;
}

const DUSK: Record<Theme, DuskPalette> = {
  dark: {
    background: "#070a12",
    grid: "rgba(255,255,255,0.035)",
    bird: [196, 206, 226],
    trees: [20, 26, 38],
    wire: [70, 78, 96],
    falcon: [242, 186, 110],
  },
  light: {
    background: "#f4f0e8",
    grid: "rgba(0,0,0,0.03)",
    bird: [46, 50, 66],
    trees: [206, 198, 182],
    wire: [170, 162, 148],
    falcon: [178, 96, 36],
  },
};

/** Density to glyph: a lone bird is a dot; where they crowd, the mark gets heavier. */
const DENSITY = ".:+**###@@";
const RANGE = 36;

export class FlockScene extends GridScene {
  private n = 0;
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private count = new Uint16Array(0);
  private treeline: number[] = [];
  private binCols = 0;
  private binHead = new Int32Array(0);
  private binNext = new Int32Array(0);
  private gathering = false;
  private burst: { x: number; y: number; until: number; reach: number; force: number } | null = null;
  private falcon: { x: number; y: number; tx: number; ty: number; vx: number; vy: number; until: number } | null = null;

  protected palette() {
    return DUSK[this.theme];
  }

  protected layout(first: boolean) {
    const { cols, rows, width: W, height: H } = this;
    this.count = new Uint16Array(cols * rows);
    this.treeline = Array.from({ length: cols }, (_, c) => Math.round(rows * (0.03 + 0.05 * valueNoise(c * 0.04, 0, 11) + 0.015 * valueNoise(c * 0.2, 1, 11))));
    if (first) {
      this.n = clamp(Math.round((W * H) / 1400), 400, 1000);
      this.x = new Float32Array(this.n);
      this.y = new Float32Array(this.n);
      this.vx = new Float32Array(this.n);
      this.vy = new Float32Array(this.n);
      for (let i = 0; i < this.n; i++) {
        const a = rand(0, TAU);
        const r = Math.sqrt(Math.random()) * Math.min(W, H) * 0.18;
        this.x[i] = W * 0.5 + Math.cos(a) * r * 1.6;
        this.y[i] = H * 0.34 + Math.sin(a) * r;
        this.vx[i] = 80;
        this.vy[i] = rand(-10, 10);
      }
    }
  }

  /** Where the flock is heading: a slow, looping path across the upper sky. */
  private target() {
    const { width: W, height: H, time } = this;
    if (this.gathering) return { x: W * 0.5, y: H * 0.3 };
    return {
      x: W * (0.5 + 0.32 * Math.sin(time * 0.11)),
      y: H * (0.34 + 0.13 * Math.sin(time * 0.17 + 1)),
    };
  }

  step(dt: number) {
    const { n, x, y, vx, vy, width: W, height: H } = this;
    this.time += dt;
    if (this.burst && this.time > this.burst.until) this.burst = null;
    this.stepFalcon(dt);
    this.rebuildBins();

    const goal = this.target();
    const maxSpeed = this.gathering ? 150 : 125;
    const minSpeed = 55;
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      let ax = 0;
      let ay = 0;
      let cx = 0;
      let cy = 0;
      let m = 0;
      const bc = Math.floor(x[i] / RANGE) + 1;
      const br = Math.floor(y[i] / RANGE) + 1;
      for (let r = br - 1; r <= br + 1; r++) {
        for (let c = bc - 1; c <= bc + 1; c++) {
          if (c < 0 || r < 0 || c >= this.binCols) continue;
          let j = this.binHead[r * this.binCols + c] ?? -1;
          while (j !== -1) {
            if (j !== i) {
              const dx = x[j] - x[i];
              const dy = y[j] - y[i];
              const d2 = dx * dx + dy * dy;
              if (d2 < RANGE * RANGE) {
                const d = Math.sqrt(d2) || 0.01;
                if (d < 7) {
                  sx -= (dx / d) * (1 - d / 7);
                  sy -= (dy / d) * (1 - d / 7);
                }
                ax += vx[j];
                ay += vy[j];
                cx += x[j];
                cy += y[j];
                m++;
              }
            }
            j = this.binNext[j];
          }
        }
      }

      let fx = sx * 220;
      let fy = sy * 220;
      if (m) {
        fx += (ax / m - vx[i]) * 1.6 + (cx / m - x[i]) * 1.5;
        fy += (ay / m - vy[i]) * 1.6 + (cy / m - y[i]) * 1.5;
      }
      // Toward the flock's goal, and, while gathered, round and round it.
      const gx = goal.x - x[i];
      const gy = goal.y - y[i];
      const gd = Math.hypot(gx, gy) || 1;
      const pull = this.gathering ? 0.9 : 0.22;
      fx += clamp(gx * pull, -90, 90);
      fy += clamp(gy * pull, -90, 90);
      if (this.gathering) {
        const swirl = 70 / (1 + gd / 220);
        fx += (-gy / gd) * swirl;
        fy += (gx / gd) * swirl;
      }
      // Away from the cursor, a burst, and the falcon.
      for (const threat of this.threats()) {
        const dx = x[i] - threat.x;
        const dy = y[i] - threat.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < threat.reach) {
          fx += (dx / d) * threat.force * (1 - d / threat.reach);
          fy += (dy / d) * threat.force * (1 - d / threat.reach);
        }
      }
      // Soft edges: they can swing a little off-screen, never far.
      if (x[i] < -40) fx += 120;
      else if (x[i] > W + 40) fx -= 120;
      if (y[i] < -30) fy += 120;
      else if (y[i] > H * 0.8) fy -= 160;

      vx[i] += fx * dt;
      vy[i] += fy * dt;
      const s = Math.hypot(vx[i], vy[i]) || 1;
      const k = s > maxSpeed ? maxSpeed / s : s < minSpeed ? minSpeed / s : 1;
      vx[i] *= k;
      vy[i] *= k;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
    }
  }

  private threats() {
    const out: { x: number; y: number; reach: number; force: number }[] = [];
    if (this.pointer.active) out.push({ x: this.pointer.x, y: this.pointer.y, reach: 90, force: 260 });
    if (this.burst) out.push(this.burst);
    if (this.falcon) out.push({ x: this.falcon.x, y: this.falcon.y, reach: 120, force: 900 });
    return out;
  }

  /** The falcon stoops on the spot that was clicked, then climbs away. */
  private stepFalcon(dt: number) {
    const f = this.falcon;
    if (!f) return;
    if (this.time > f.until) {
      this.falcon = null;
      return;
    }
    const dx = f.tx - f.x;
    const dy = f.ty - f.y;
    const d = Math.hypot(dx, dy);
    if (d < 30) {
      // Past the mark: pull up and off.
      f.tx = f.x + f.vx * 3;
      f.ty = -200;
    }
    const speed = 460;
    f.vx += ((dx / (d || 1)) * speed - f.vx) * Math.min(1, dt * 3);
    f.vy += ((dy / (d || 1)) * speed - f.vy) * Math.min(1, dt * 3);
    f.x += f.vx * dt;
    f.y += f.vy * dt;
  }

  private rebuildBins() {
    const { n, x, y, width: W, height: H } = this;
    this.binCols = Math.ceil(W / RANGE) + 3;
    const size = this.binCols * (Math.ceil(H / RANGE) + 3);
    if (this.binHead.length !== size) this.binHead = new Int32Array(size);
    this.binHead.fill(-1);
    if (this.binNext.length !== n) this.binNext = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = clamp(Math.floor(x[i] / RANGE) + 1, 0, this.binCols - 1);
      const r = clamp(Math.floor(y[i] / RANGE) + 1, 0, Math.ceil(H / RANGE) + 2);
      const b = r * this.binCols + c;
      this.binNext[i] = this.binHead[b];
      this.binHead[b] = i;
    }
  }

  protected draw() {
    const p = this.palette();
    const { cols, rows, count, n, x, y } = this;

    // The treeline, with a sagging wire strung above it.
    const wireRow = rows - Math.max(...this.treeline) - 4;
    for (let c = 0; c < cols; c++) {
      const span = (c % 60) / 60;
      const sag = Math.round(Math.sin(span * Math.PI) * 2);
      this.glyph(c, wireRow + sag, c % 60 === 0 ? "+" : sag > 1 ? "_" : "-", rgba(p.wire, 0.5));
      if (c % 60 === 0) for (let r = wireRow + 1; r < rows - this.treeline[c]; r++) this.glyph(c, r, "|", rgba(p.wire, 0.4));
      const h = this.treeline[c];
      for (let k = 0; k < h; k++) this.tile(c, rows - 1 - k, rgba(p.trees, 0.9));
      // The top edge follows the slope, so the line of trees reads as a soft outline, not steps.
      const ink = rgba(p.trees.map((v) => v * (this.light ? 0.7 : 2.2)) as RGB, 0.9);
      const next = this.treeline[c + 1] ?? h;
      this.glyph(c, rows - 1 - h, next > h ? "/" : next < h ? "\\" : "^", ink);
    }

    count.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.col(x[i]);
      const r = this.row(y[i]);
      if (this.inGrid(c, r)) count[r * cols + c]++;
    }
    for (let i = 0; i < count.length; i++) {
      const k = count[i];
      if (!k) continue;
      this.glyph(i % cols, (i / cols) | 0, DENSITY[Math.min(k, DENSITY.length) - 1], rgba(p.bird, 0.45 + 0.55 * Math.min(1, k / 5)));
    }

    const f = this.falcon;
    if (f) {
      const c = this.col(f.x);
      const r = this.row(f.y);
      this.tile(c, r, rgba(p.falcon, 0.35));
      this.glyph(c, r, "V", rgba(p.falcon));
      this.glyph(c - Math.sign(f.vx), r - Math.sign(f.vy), "'", rgba(p.falcon, 0.5));
    }
  }

  // ── reactions ───────────────────────────────────────────────────────

  /** Click: a falcon stoops on the spot, from above and off to one side. */
  poke(x: number, y: number) {
    const side = x < this.width / 2 ? 1 : -1;
    this.falcon = { x: x - side * 300, y: -60, tx: x, ty: y, vx: 0, vy: 300, until: this.time + 4 };
  }

  /** A keystroke: the birds nearest the composer startle a little. */
  nudge(x: number, y: number) {
    this.burst = { x, y, until: this.time + 0.2, reach: 150, force: 420 };
  }

  circle() {
    this.gathering = true;
  }

  /** The answer: the ball bursts outward from the reply, then the flock re-forms. */
  scatter(x: number, y: number) {
    this.gathering = false;
    this.burst = { x, y: Math.min(y, this.height * 0.5), until: this.time + 0.6, reach: 520, force: 900 };
  }

  calm() {
    this.gathering = false;
  }
}
