import { BloomScene } from "./bloom";
import type { RenderOptions, Theme } from "./renderer";
import { AntsScene } from "./ants";
import { CampfireScene } from "./campfire";
import { FirefliesScene } from "./fireflies";
import { FlockScene } from "./flock";
import { RainScene } from "./rain";
import { SkyScene } from "./sky";
import { ZenScene } from "./zen";
import { OceanScene, type Scene, type SceneKind } from "./scene";
import type { SharkSpec } from "./world";

const STEP = 1 / 60;
const MAX_STEPS = 4;

export interface EngineOptions extends RenderOptions {
  /** Whether the scene answers the cursor, clicks, and the page's own cues. On by default. */
  reactive?: boolean;
  /** Which living background to run. Sharks by default. */
  scene?: SceneKind;
}

/**
 * Runs a Scene on a canvas: fixed-timestep loop, resize, pointer input,
 * pausing off-screen, and prefers-reduced-motion.
 */
export class OceanEngine {
  private scene: Scene;
  private sceneKind: SceneKind;
  private sharks?: SharkSpec[];
  private theme: Theme;
  private cellSize?: number;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private visible = true;
  private reducedMotion: MediaQueryList;
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private disposed = false;
  private reactive: boolean;

  constructor(private canvas: HTMLCanvasElement, sharks?: SharkSpec[], options: EngineOptions = {}) {
    this.sharks = sharks;
    this.theme = options.theme ?? "dark";
    this.cellSize = options.cellSize;
    this.reactive = options.reactive ?? true;
    this.sceneKind = options.scene ?? "sharks";
    this.scene = this.makeScene(this.sceneKind);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.intersectionObserver.observe(canvas);

    this.reducedMotion.addEventListener("change", this.onMotionPreference);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onPointerLeave);

    this.resize();
    // Canvas text can't trigger a webfont load; once the mono face is in, redraw.
    document.fonts?.load(`600 16px ${getComputedStyle(canvas).fontFamily}`).then(() => {
      if (!this.disposed && this.reducedMotion.matches) this.drawStill();
    });
    this.schedule();
  }

  private makeScene(kind: SceneKind): Scene {
    const options = { theme: this.theme, cellSize: this.cellSize, fontFamily: getComputedStyle(this.canvas).fontFamily };
    switch (kind) {
      case "bloom":
        return new BloomScene(this.canvas, options);
      case "rain":
        return new RainScene(this.canvas, options);
      case "fireflies":
        return new FirefliesScene(this.canvas, options);
      case "flock":
        return new FlockScene(this.canvas, options);
      case "sky":
        return new SkyScene(this.canvas, options);
      case "ants":
        return new AntsScene(this.canvas, options);
      case "campfire":
        return new CampfireScene(this.canvas, options);
      case "zen":
        return new ZenScene(this.canvas, options);
      default:
        return new OceanScene(this.canvas, this.sharks, kind === "koi", options);
    }
  }

  /** Swap the whole background for another scene, sized and themed like the last. */
  setScene(kind: SceneKind) {
    if (kind === this.sceneKind) return;
    this.sceneKind = kind;
    this.scene.dispose?.();
    // A canvas keeps whichever context it first handed out (2D or WebGL), so each scene gets a fresh one.
    const fresh = this.canvas.cloneNode(false) as HTMLCanvasElement;
    this.resizeObserver.unobserve(this.canvas);
    this.intersectionObserver.unobserve(this.canvas);
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this.resizeObserver.observe(fresh);
    this.intersectionObserver.observe(fresh);
    this.scene = this.makeScene(kind);
    this.resize();
  }

  refreshBloom() {
    if (this.scene instanceof BloomScene) this.scene.refresh();
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.scene.setTheme(theme);
    if (this.reducedMotion.matches) this.drawStill();
  }

  /** The shark roster, kept for the sharks scene even while another one is showing. */
  setSharks(sharks: SharkSpec[]) {
    this.sharks = sharks;
    if (!(this.scene instanceof OceanScene)) return;
    // With reduced motion there's no swimming in: place them and redraw the still.
    this.scene.setSharks(sharks, !this.reducedMotion.matches);
    if (this.reducedMotion.matches) this.drawStill();
  }

  /** Turn reactions off and the scene just carries on, ignoring the cursor, clicks, and cues. */
  setReactive(on: boolean) {
    this.reactive = on;
    if (!on) {
      this.scene.pointer.active = false;
      this.scene.calm();
    }
  }

  // Cues for the page to stir the scene with, in client coordinates.
  // They do nothing while reactions are off or motion is reduced.

  splash(clientX: number, clientY: number) {
    if (!this.responsive()) return;
    const { x, y } = this.toLocal(clientX, clientY);
    this.scene.splash(x, y);
  }

  /** A keystroke's worth of reaction. */
  nudge(clientX: number, clientY: number) {
    if (!this.responsive()) return;
    const { x, y } = this.toLocal(clientX, clientY);
    this.scene.nudge(x, y);
  }

  /** The scene's "thinking" state, held until calm() or scatter(). */
  circle() {
    if (this.responsive()) this.scene.circle();
  }

  scatter(clientX: number, clientY: number) {
    if (!this.responsive()) return;
    const { x, y } = this.toLocal(clientX, clientY);
    this.scene.scatter(x, y);
  }

  calm() {
    this.scene.calm();
  }

  private responsive() {
    return this.reactive && !this.reducedMotion.matches;
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.scene.dispose?.();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    document.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onPointerLeave);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scene.resize(rect.width, rect.height, dpr);
    if (this.reducedMotion.matches) this.drawStill();
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible || this.reducedMotion.matches) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.scene.step(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.scene.render(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Reduced motion: let the scene settle, then show a single frame. */
  private drawStill() {
    if (this.scene.time < 4) {
      for (let i = 0; i < 240; i++) this.scene.step(STEP);
    }
    this.scene.render(STEP);
  }

  private onMotionPreference = () => {
    if (this.reducedMotion.matches) {
      cancelAnimationFrame(this.raf);
      this.drawStill();
    } else {
      this.schedule();
    }
  };

  private toLocal(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
    return { x, y, inside };
  }

  private onPointerMove = (e: PointerEvent) => {
    const { x, y, inside } = this.toLocal(e.clientX, e.clientY);
    const p = this.scene.pointer;
    p.x = x;
    p.y = y;
    p.active = inside && e.pointerType !== "touch" && this.reactive;
  };

  private onPointerDown = (e: PointerEvent) => {
    // Clicks on UI layered over the canvas shouldn't stir the scene under it.
    if (e.target !== this.canvas || !this.responsive()) return;
    const { x, y, inside } = this.toLocal(e.clientX, e.clientY);
    if (inside) this.scene.poke(x, y);
  };

  private onPointerLeave = () => {
    this.scene.pointer.active = false;
  };
}
