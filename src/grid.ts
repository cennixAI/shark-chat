import { clamp } from "./math";
import { paintGrid, type Theme } from "./renderer";
import type { Scene, SceneOptions } from "./scene";

export interface GridPalette {
  background: string;
  grid: string;
}

export type RGB = [number, number, number];

export const rgba = ([r, g, b]: RGB, a = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a.toFixed(3)})`;

/** A straight-line glyph for a direction (radians), for strokes drawn on the grid. */
export function lineGlyph(theta: number) {
  const a = ((theta % Math.PI) + Math.PI) % Math.PI;
  if (a < Math.PI / 8 || a > (7 * Math.PI) / 8) return "-";
  if (a < (3 * Math.PI) / 8) return "\\";
  if (a < (5 * Math.PI) / 8) return "|";
  return "/";
}

/**
 * The plumbing every hand-drawn ASCII scene shares: a 2D canvas on the house grid (same cells,
 * same faint lines, same glyph font as the sharks), themes, and helpers to put a glyph or a tile
 * in a cell. A scene supplies its palette, lays itself out, steps, and draws.
 */
export abstract class GridScene implements Scene {
  time = 0;
  pointer = { x: 0, y: 0, active: false };

  protected ctx: CanvasRenderingContext2D;
  protected theme: Theme;
  protected fontFamily: string;
  protected width = 0;
  protected height = 0;
  protected dpr = 1;
  protected cw = 8;
  protected ch = 12;
  protected cols = 0;
  protected rows = 0;
  private cellSize?: number;
  private backdrop = document.createElement("canvas");

  constructor(protected canvas: HTMLCanvasElement, options: SceneOptions) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.theme = options.theme;
    this.fontFamily = options.fontFamily;
    this.cellSize = options.cellSize;
  }

  protected abstract palette(): GridPalette;
  /** Fit the scene to a new size; `first` is the very first layout, when it should seed itself. */
  protected abstract layout(first: boolean): void;
  abstract step(dt: number): void;
  protected abstract draw(): void;

  resize(width: number, height: number, dpr: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = this.cellSize ?? clamp(Math.round(width / 124), 8, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.paintBackdrop();
    this.layout(first);
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.paintBackdrop();
  }

  private paintBackdrop() {
    const b = this.backdrop;
    b.width = this.canvas.width;
    b.height = this.canvas.height;
    const g = b.getContext("2d");
    if (!g || !this.width) return;
    const p = this.palette();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = p.background;
    g.fillRect(0, 0, b.width, b.height);
    paintGrid(g, this.width, this.height, this.cw, this.ch, this.dpr, p.grid);
  }

  render() {
    const { ctx, dpr, ch } = this;
    if (!this.width) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.backdrop, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.draw();
    ctx.globalAlpha = 1;
  }

  protected get light() {
    return this.theme === "light";
  }

  protected inGrid(col: number, row: number) {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  /** A glyph centred in a cell. */
  protected glyph(col: number, row: number, glyph: string, colour: string) {
    this.ctx.fillStyle = colour;
    this.ctx.fillText(glyph, col * this.cw + this.cw / 2, row * this.ch + this.ch / 2 + 1);
  }

  /** A cell's tile, with the hairline gap the sharks' skin has. */
  protected tile(col: number, row: number, colour: string) {
    this.ctx.fillStyle = colour;
    this.ctx.fillRect(col * this.cw + 1, row * this.ch + 1, this.cw - 1, this.ch - 1);
  }

  protected col(x: number) {
    return Math.floor(x / this.cw);
  }

  protected row(y: number) {
    return Math.floor(y / this.ch);
  }

  // Reactions default to doing nothing; each scene picks the ones it has an answer for.
  poke(_x: number, _y: number) {}
  splash(_x: number, _y: number) {}
  nudge(_x: number, _y: number) {}
  circle() {}
  scatter(_x: number, _y: number) {}
  calm() {}
}
