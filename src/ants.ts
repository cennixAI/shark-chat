/**
 * An ant colony. Ants leave the nest and wander until they find food, then carry it home, laying
 * scent as they go; others follow the scent, so trails form on their own between nest and food.
 * Click to drop food, and every keystroke drops a crumb by the composer. While the agent thinks the
 * colony turns out in force; when the answer lands, a fresh pile appears by the reply.
 */
import { GridScene, lineGlyph, rgba, type GridPalette, type RGB } from "./grid";
import { clamp, hash3, rand, TAU } from "./math";
import type { Theme } from "./renderer";

interface SoilPalette extends GridPalette {
  dirt: RGB;
  ant: RGB;
  carrying: RGB;
  food: RGB;
  foodInk: RGB;
  trail: RGB;
  nest: RGB;
  nestInk: RGB;
  pebble: RGB;
}

const SOIL: Record<Theme, SoilPalette> = {
  dark: {
    background: "#0b0907",
    grid: "rgba(255,255,255,0.03)",
    dirt: [92, 76, 58],
    ant: [222, 208, 186],
    carrying: [250, 186, 84],
    food: [70, 112, 48],
    foodInk: [190, 232, 140],
    trail: [214, 160, 74],
    nest: [58, 42, 28],
    nestInk: [160, 128, 92],
    pebble: [64, 64, 70],
  },
  light: {
    background: "#f3eee4",
    grid: "rgba(60,40,20,0.04)",
    dirt: [190, 172, 146],
    ant: [44, 34, 28],
    carrying: [176, 94, 18],
    food: [176, 206, 140],
    foodInk: [62, 104, 40],
    trail: [196, 140, 64],
    nest: [204, 178, 140],
    nestInk: [110, 80, 50],
    pebble: [196, 192, 186],
  },
};

interface Ant {
  x: number;
  y: number;
  heading: number;
  carrying: boolean;
  /** Scent strength left to lay: full on leaving the nest or the food, fading with the distance walked. */
  scent: number;
  /** In the nest, waiting to come out. */
  home: boolean;
}

interface Pile {
  x: number;
  y: number;
  amount: number;
}

const SENSE = 18;

export class AntsScene extends GridScene {
  private ants: Ant[] = [];
  private piles: Pile[] = [];
  /** Scent toward food, laid by ants carrying it home; and toward home, laid by ants heading out. */
  private toFood = new Float32Array(0);
  private toHome = new Float32Array(0);
  private nest = { x: 0, y: 0, r: 22 };
  private dirt: { col: number; row: number; glyph: string; pebble: boolean }[] = [];
  private busy = false;
  private nextPile = 30;

  protected palette() {
    return SOIL[this.theme];
  }

  protected layout(first: boolean) {
    const { cols, rows, width: W, height: H } = this;
    this.toFood = new Float32Array(cols * rows);
    this.toHome = new Float32Array(cols * rows);
    this.nest = { x: W * 0.15, y: H * 0.78, r: 22 };
    this.dirt = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const h = hash3(c, r, 61);
        if (h < 0.055) this.dirt.push({ col: c, row: r, glyph: ".,'`"[Math.floor(h * 72) % 4], pebble: h < 0.0012 });
      }
    }
    if (first) {
      const count = clamp(Math.round((W * H) / 7000), 60, 220);
      this.ants = Array.from({ length: count }, () => ({
        x: this.nest.x + rand(-10, 10),
        y: this.nest.y + rand(-6, 6),
        heading: rand(0, TAU),
        carrying: false,
        scent: 1,
        home: true,
      }));
      this.piles = [
        { x: W * 0.42, y: H * 0.5, amount: 60 },
        { x: W * 0.74, y: H * 0.28, amount: 50 },
      ];
    }
  }

  private cell(x: number, y: number) {
    const c = this.col(x);
    const r = this.row(y);
    return this.inGrid(c, r) ? r * this.cols + c : -1;
  }

  private smell(field: Float32Array, x: number, y: number) {
    const i = this.cell(x, y);
    return i < 0 ? 0 : field[i];
  }

  step(dt: number) {
    const { width: W, height: H, nest, piles } = this;
    this.time += dt;
    const out = this.ants.filter((a) => !a.home).length;
    const wanted = Math.round(this.ants.length * (this.busy ? 0.95 : 0.55));
    const speed = this.busy ? 48 : 34;

    for (const ant of this.ants) {
      if (ant.home) {
        // Out they come, a few at a time, until the colony has as many abroad as it wants.
        if (out < wanted && Math.random() < dt * 0.8) {
          ant.home = false;
          ant.heading = rand(0, TAU);
          ant.scent = 1;
        }
        continue;
      }

      // Follow the scent that leads where this ant is going: test left, ahead, and right.
      const field = ant.carrying ? this.toHome : this.toFood;
      const left = this.smell(field, ant.x + Math.cos(ant.heading - 0.6) * SENSE, ant.y + Math.sin(ant.heading - 0.6) * SENSE);
      const ahead = this.smell(field, ant.x + Math.cos(ant.heading) * SENSE, ant.y + Math.sin(ant.heading) * SENSE);
      const right = this.smell(field, ant.x + Math.cos(ant.heading + 0.6) * SENSE, ant.y + Math.sin(ant.heading + 0.6) * SENSE);
      if (Math.max(left, right) > ahead && Math.max(left, right) > 0.03) ant.heading += (left > right ? -1 : 1) * 2.6 * dt;
      ant.heading += (Math.random() - 0.5) * 4 * dt;

      // Close enough to see the goal: make straight for it. Laden ants also keep a rough sense of
      // where home is (real ants count their steps), so they drift nestward even off the trail.
      const nearNest = Math.hypot(nest.x - ant.x, nest.y - ant.y) < 90;
      const goal = ant.carrying ? nest : this.pileNear(ant.x, ant.y, 150);
      if (goal) {
        const turn = Math.atan2(Math.sin(Math.atan2(goal.y - ant.y, goal.x - ant.x) - ant.heading), Math.cos(Math.atan2(goal.y - ant.y, goal.x - ant.x) - ant.heading));
        ant.heading += turn * Math.min(1, dt * (ant.carrying && !nearNest ? 0.8 : 4));
      }

      // Shy of a fingertip.
      if (this.pointer.active) {
        const dx = ant.x - this.pointer.x;
        const dy = ant.y - this.pointer.y;
        if (Math.hypot(dx, dy) < 50) ant.heading = Math.atan2(dy, dx);
      }

      ant.x += Math.cos(ant.heading) * speed * dt;
      ant.y += Math.sin(ant.heading) * speed * dt;
      if (ant.x < 4 || ant.x > W - 4) ant.heading = Math.PI - ant.heading;
      if (ant.y < 4 || ant.y > H - 4) ant.heading = -ant.heading;
      ant.x = clamp(ant.x, 4, W - 4);
      ant.y = clamp(ant.y, 4, H - 4);

      // Lay scent for the trip it's on.
      const i = this.cell(ant.x, ant.y);
      if (i >= 0) {
        const lay = ant.carrying ? this.toFood : this.toHome;
        lay[i] = Math.max(lay[i], ant.scent);
      }
      ant.scent *= Math.exp(-dt * 0.12);

      if (!ant.carrying) {
        const pile = this.pileNear(ant.x, ant.y, 0);
        if (pile) {
          pile.amount -= 1;
          ant.carrying = true;
          ant.scent = 1;
          ant.heading += Math.PI;
        }
      } else if (Math.hypot(nest.x - ant.x, nest.y - ant.y) < nest.r) {
        ant.carrying = false;
        ant.scent = 1;
        ant.heading += Math.PI;
        // Some go back to rest once they're home.
        if (out > wanted || Math.random() < 0.2) ant.home = true;
      }
    }
    this.piles = piles.filter((p) => p.amount > 0);

    // Scent evaporates, so trails to eaten-out piles fade away.
    const fade = Math.exp(-dt * 0.05);
    for (let i = 0; i < this.toFood.length; i++) {
      this.toFood[i] *= fade;
      this.toHome[i] *= fade;
    }

    // Keep the colony fed: when the food runs low, a new pile turns up somewhere.
    if (this.time > this.nextPile && this.piles.reduce((n, p) => n + p.amount, 0) < 40) {
      this.nextPile = this.time + 25;
      this.piles.push({ x: rand(W * 0.45, W * 0.92), y: rand(H * 0.12, H * 0.88), amount: 50 });
    }
  }

  /** A pile within reach of a point: touching it (reach 0) or in sight of it. */
  private pileNear(x: number, y: number, reach: number) {
    for (const p of this.piles) {
      if (Math.hypot(p.x - x, p.y - y) < this.pileRadius(p) + 4 + reach) return p;
    }
    return null;
  }

  private pileRadius(p: Pile) {
    return 4 + Math.sqrt(p.amount) * 2.4;
  }

  protected draw() {
    const p = this.palette();
    const { cols, toFood, toHome } = this;

    for (const d of this.dirt) {
      if (d.pebble) this.tile(d.col, d.row, rgba(p.pebble, 0.5));
      else this.glyph(d.col, d.row, d.glyph, rgba(p.dirt, 0.45));
    }

    // The trails: home faintly, food warmer and brighter.
    for (let i = 0; i < toFood.length; i++) {
      const food = toFood[i];
      const home = toHome[i];
      if (food > 0.06) this.glyph(i % cols, (i / cols) | 0, food > 0.4 ? ":" : ".", rgba(p.trail, 0.2 + 0.55 * food));
      else if (home > 0.3) this.glyph(i % cols, (i / cols) | 0, ".", rgba(p.dirt, 0.25 + 0.3 * home));
    }

    // The nest: a mound with a dark way in.
    const { nest } = this;
    for (let r = this.row(nest.y - nest.r); r <= this.row(nest.y + nest.r); r++) {
      for (let c = this.col(nest.x - nest.r * 1.5); c <= this.col(nest.x + nest.r * 1.5); c++) {
        const dx = (c * this.cw + this.cw / 2 - nest.x) / (nest.r * 1.5);
        const dy = (r * this.ch + this.ch / 2 - nest.y) / nest.r;
        const d = Math.hypot(dx, dy);
        if (d > 1) continue;
        this.tile(c, r, rgba(p.nest, 0.95));
        this.glyph(c, r, d < 0.25 ? "O" : d < 0.6 ? ":" : ".", rgba(p.nestInk, d < 0.25 ? 1 : 0.7));
      }
    }

    for (const pile of this.piles) {
      const radius = this.pileRadius(pile);
      for (let r = this.row(pile.y - radius); r <= this.row(pile.y + radius); r++) {
        for (let c = this.col(pile.x - radius); c <= this.col(pile.x + radius); c++) {
          if (Math.hypot(c * this.cw + this.cw / 2 - pile.x, r * this.ch + this.ch / 2 - pile.y) > radius) continue;
          this.tile(c, r, rgba(p.food, 0.9));
          this.glyph(c, r, "%*o"[(c + r) % 3], rgba(p.foodInk));
        }
      }
    }

    for (const ant of this.ants) {
      if (ant.home) continue;
      this.glyph(this.col(ant.x), this.row(ant.y), lineGlyph(ant.heading), rgba(ant.carrying ? p.carrying : p.ant));
    }
  }

  // ── reactions ───────────────────────────────────────────────────────

  /** Click: a pile of food, right there. */
  poke(x: number, y: number) {
    this.piles.push({ x, y, amount: 45 });
    const big = this.piles.filter((p) => p.amount > 3);
    if (big.length > 6) this.piles.splice(this.piles.indexOf(big[0]), 1);
  }

  /** A keystroke: a crumb lands by the composer, for some ant to find. */
  nudge(x: number, y: number) {
    this.piles.push({ x: x + rand(-14, 14), y: y - rand(10, 34), amount: 1 });
    const crumbs = this.piles.filter((p) => p.amount <= 2);
    if (crumbs.length > 40) this.piles.splice(this.piles.indexOf(crumbs[0]), 1);
  }

  circle() {
    this.busy = true;
  }

  /** The answer: a fresh pile by the reply, and the ants nearby scatter from where it lands. */
  scatter(x: number, y: number) {
    this.busy = false;
    for (const ant of this.ants) {
      if (!ant.home && Math.hypot(ant.x - x, ant.y - y) < 110) ant.heading = Math.atan2(ant.y - y, ant.x - x);
    }
    this.piles.push({ x, y, amount: 30 });
  }

  calm() {
    this.busy = false;
  }
}
