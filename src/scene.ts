import { AsciiRenderer, type Theme } from "./renderer";
import { World, type SharkSpec } from "./world";

export type SceneKind = "sharks" | "koi" | "rain" | "fireflies" | "flock" | "sky" | "ants" | "campfire" | "zen" | "bloom";

/** One living background: its own simulation and drawing, run by OceanEngine's loop. */
export interface Scene {
  readonly time: number;
  readonly pointer: { x: number; y: number; active: boolean };
  resize(width: number, height: number, dpr: number): void;
  step(dt: number): void;
  render(dt: number): void;
  setTheme(theme: Theme): void;
  /** A click on the scene itself. */
  poke(x: number, y: number): void;
  /** A ripple from the page, such as a message going out. */
  splash(x: number, y: number): void;
  /** The lightest touch from the page: a keystroke. */
  nudge(x: number, y: number): void;
  /** Hold a "thinking" state until calm() or scatter(). */
  circle(): void;
  /** Let it go, outward from a point. */
  scatter(x: number, y: number): void;
  calm(): void;
  /** Release anything the scene holds outside the page, such as a WebGL context. */
  dispose?(): void;
}

export interface SceneOptions {
  theme: Theme;
  cellSize?: number;
  fontFamily: string;
}

/** Seven koi: one of each variety plus a spare, a good deal smaller than the sharks. */
export const KOI: SharkSpec[] = [0.56, 0.52, 0.5, 0.48, 0.46, 0.44, 0.42].map((size) => ({ kind: "koi", size }));

/** The ascii-sharks world: sharks hunting fish, or (as a pond) koi among lily pads with nothing to hunt. */
export class OceanScene implements Scene {
  private world: World;
  private renderer: AsciiRenderer;

  constructor(canvas: HTMLCanvasElement, sharks: SharkSpec[] | undefined, private pond: boolean, options: SceneOptions) {
    this.world = new World(pond ? KOI : sharks, pond ? 0 : undefined);
    this.renderer = new AsciiRenderer(canvas, { theme: options.theme, cellSize: options.cellSize, pond });
    this.renderer.setFontFamily(options.fontFamily);
    // Lily pads are drawn once and cached, so draw them again once the glyph font has loaded.
    void document.fonts?.ready.then(() => this.renderer.repaint());
  }

  get time() {
    return this.world.time;
  }

  get pointer() {
    return this.world.pointer;
  }

  resize(width: number, height: number, dpr: number) {
    this.renderer.resize(width, height, dpr);
    this.world.resize(width, height, this.renderer.cellWidth, this.renderer.cellHeight);
  }

  step(dt: number) {
    this.world.step(dt);
  }

  render(dt: number) {
    this.renderer.render(this.world, dt);
  }

  setTheme(theme: Theme) {
    this.renderer.setTheme(theme);
  }

  setSharks(sharks: SharkSpec[], swimIn: boolean) {
    if (!this.pond) this.world.setSharks(sharks, swimIn);
  }

  poke(x: number, y: number) {
    this.world.splash(x, y);
    // Koi come for food; sharks come to see what made the splash.
    if (this.pond) this.world.feed(x, y);
    else this.world.investigate(x, y);
  }

  splash(x: number, y: number) {
    this.world.splash(x, y);
  }

  nudge(x: number, y: number) {
    this.world.ripple(x, y);
  }

  circle() {
    this.world.circle();
  }

  scatter(x: number, y: number) {
    this.world.scatter(x, y);
  }

  calm() {
    this.world.calm();
  }
}
