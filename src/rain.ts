/**
 * Rain on a window, looking out at a city, all in ASCII.
 *
 * Behind the glass the city (lit windows, neon signs, streetlights, traffic on a wet road) is out of
 * focus. Every drop is a little lens, though, and shows it sharp, squeezed and upside down, the way
 * real drops do. Condensation mists the pane; running drops clear trails through it, and the cursor
 * wipes it away to show the city crisp behind. Rain streaks past outside.
 *
 * Drops are simulated here and drawn into a normal map (a sprite per drop, its colour encoding the
 * surface slope). One WebGL pass works out what each grid cell would show (glass or drop, refracted
 * or not) and draws it as a glyph, so what reaches the screen is characters on the house grid:
 * glyphs for the glass, tiles for the drops. Without WebGL the same happens, more simply, on the CPU.
 */
import { clamp, hash3, rand, TAU } from "./math";
import type { Theme } from "./renderer";
import type { Scene, SceneOptions } from "./scene";

interface CityPalette {
  sky: [string, string, string];
  /** The city's own light on the low cloud. */
  haze: string;
  far: string;
  farWindow: string;
  near: [string, string];
  lit: string[];
  /** How many windows have a light on, relative to night. */
  litShare: number;
  unlit: string;
  neon: string[];
  street: string;
  lamp: string;
  head: string;
  tail: string;
}

interface GlassPalette {
  paper: [number, number, number];
  /** Light theme: glyphs are ink on paper, so density follows darkness rather than light. */
  light: number;
  fog: [number, number, number];
  fogStrength: number;
  /** The light every drop catches, however dark it is behind. */
  water: [number, number, number];
  rain: [number, number, number];
  grid: [number, number, number, number];
}

const CITY: Record<Theme, CityPalette> = {
  dark: {
    sky: ["#070a14", "#151a30", "#3a2236"],
    haze: "255,120,90",
    far: "#1b2033",
    farWindow: "#8a7a96",
    near: ["#10131f", "#141826"],
    lit: ["#ffcf7a", "#ffe2a8", "#ffb45a", "#a8d8ff"],
    litShare: 1,
    unlit: "#1f2534",
    neon: ["#ff4fa3", "#36f0ff", "#7dff9b", "#ffd84a", "#b47bff"],
    street: "#06070b",
    lamp: "255,186,104",
    head: "255,242,214",
    tail: "255,64,56",
  },
  light: {
    sky: ["#d9e0e9", "#e6eaf0", "#f2ece6"],
    haze: "255,214,170",
    far: "#cdd4de",
    farWindow: "",
    near: ["#b9c1cd", "#aeb7c4"],
    lit: ["#f0a94e", "#f5c27a", "#e89a3c"],
    // By day only the odd window has a light on, and dark ones don't need marking.
    litShare: 0.12,
    unlit: "",
    neon: ["#ff5f96", "#14a99e", "#ef8f1c", "#7a5cff"],
    street: "#bfc5ce",
    lamp: "255,196,120",
    head: "255,232,190",
    tail: "232,62,52",
  },
};

const GLASS: Record<Theme, GlassPalette> = {
  dark: {
    paper: [0.02, 0.027, 0.043],
    light: 0,
    fog: [0.1, 0.11, 0.15],
    fogStrength: 0.36,
    water: [0.42, 0.47, 0.58],
    rain: [0.5, 0.58, 0.75],
    grid: [1, 1, 1, 0.045],
  },
  light: {
    paper: [0.961, 0.965, 0.973],
    light: 1,
    fog: [0.95, 0.96, 0.97],
    fogStrength: 0.5,
    water: [0.3, 0.36, 0.46],
    rain: [0.36, 0.42, 0.53],
    grid: [0, 0, 0, 0.035],
  },
};

/**
 * The glyph atlas: a density ramp for the city's lights, a drop's glint, a falling streak, a small bead,
 * then the ramp the sharks' skin uses, sparse on the lit side of a drop and dense in its shadow.
 */
const ATLAS = " .:-=+*#%@'/o:;t%SX8#@";

const SIGNS = ["HOTEL", "BAR", "OPEN", "24H", "NOODLES", "CAFE", "LIVE", "TAXI", "RAMEN", "MOTEL"];

/** Drops heavier than this start to run. */
const RUN_RADIUS = 18;
/** Spatial bins for finding neighbouring drops. */
const BIN = 32;
const SPRITE = 64;
const TEXTURES = ["sharp", "blur", "drops", "fog", "glyphs"] as const;

/** A new bead's radius: mostly one-cell beads, some drops several cells across, now and then one heavy enough to run. */
const beadRadius = () => 2 + Math.random() ** 4 * 22;

interface Drop {
  x: number;
  y: number;
  r: number;
  vy: number;
  running: boolean;
  /** Seconds left stuck on a dry patch before it runs on. */
  stuck: number;
  wobble: number;
  /** Where it last left a bead behind. */
  trailY: number;
  /** Seconds until it starts to evaporate. */
  life: number;
  dead: boolean;
}

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_sharp;
uniform sampler2D u_blur;
uniform sampler2D u_drops;
uniform sampler2D u_fog;
uniform sampler2D u_glyphs;
uniform vec2 u_res;
uniform float u_dpr;
uniform vec2 u_cell;
uniform vec3 u_paper;
uniform float u_light;
uniform vec3 u_fogColour;
uniform float u_fogStrength;
uniform vec3 u_water;
uniform vec3 u_rainColour;
uniform vec4 u_grid;
uniform float u_time;
uniform float u_rain;

const float GLYPHS = ${ATLAS.length}.0;
const float GLINT = 10.0;
const float STREAK = 11.0;
const float BEAD = 12.0;
const float SKIN = 13.0;
const vec3 SUN = vec3(-0.5, -0.65, 0.6);

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float glyph(float index, vec2 inCell) {
  return texture2D(u_glyphs, vec2((index + inCell.x) / GLYPHS, inCell.y)).a;
}

void main() {
  vec2 px = v_uv * u_res;
  vec2 cell = floor(px / u_cell);
  vec2 inCell = (px - cell * u_cell) / u_cell;
  vec2 centre = (cell + 0.5) * u_cell / u_res;
  bool light = u_light > 0.5;

  // What the glass shows here: the city out of focus, sharper where wiped, misted where not.
  vec2 pane = texture2D(u_fog, centre).ra;
  float fog = pane.x;
  float wet = pane.y;
  vec3 glass = mix(texture2D(u_sharp, centre).rgb, texture2D(u_blur, centre).rgb, 0.5 + 0.5 * fog);
  glass = mix(glass, u_fogColour, fog * u_fogStrength);

  // The drop map across the cell: how much of it is water, and the strongest drop in it.
  vec4 drop = vec4(0.0);
  float cover = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 at = vec2(mod(float(k), 2.0), floor(float(k) / 2.0)) * 0.5 + 0.25;
    vec4 s = texture2D(u_drops, (cell + at) * u_cell / u_res);
    cover += s.a * 0.25;
    if (s.a > drop.a) drop = s;
  }

  vec3 base = u_paper;
  vec3 ink = u_paper;
  float index = 0.0;

  // The city: faint glyphs only where real light comes through (on paper, real shade), so the
  // glass stays mostly empty and the lights gather into soft coloured clusters.
  // On paper, judge by the blurred city alone: there, cleared paths through the mist only read as stray dots.
  float L = light ? luma(texture2D(u_blur, centre).rgb) : luma(glass);
  float signal = light ? (luma(u_paper) - L - 0.2) * 2.6 : (L - 0.11) * 3.2;
  if (signal > 0.0) {
    index = 1.0 + floor(clamp(signal, 0.0, 0.999) * 6.0);
    ink = light ? glass * 0.65 : glass * 2.2;
  }

  // Behind a running drop the glass is wet for a moment: a short tail of dots.
  if (wet > 0.25 && cover < 0.15) {
    index = wet > 0.6 ? 2.0 : 1.0;
    ink = mix(u_paper, u_water, 0.4 + 0.5 * wet);
  } else if (!light && cover > 0.08 && cover < 0.15 && fog > 0.6 && index < 1.0) {
    // Condensation: the faintest speckle of mist (on paper it just reads as dust).
    index = 1.0;
    ink = mix(u_paper, u_water, 0.25);
  }

  // Rain falling past outside, slanting with the wind.
  float lane = cell.x + floor(cell.y * 0.15);
  if (cover < 0.15 && index < 3.0 && hash(vec2(lane, 7.0)) < 0.1 * u_rain) {
    float speed = 28.0 + hash(vec2(lane, 3.0)) * 24.0;
    float len = 2.0 + floor(hash(vec2(lane, 5.0)) * 4.0);
    float head = mod(u_time * speed + hash(vec2(lane, 9.0)) * 300.0, u_res.y / u_cell.y + 24.0);
    float behind = head - cell.y;
    if (behind >= 0.0 && behind < len) {
      index = STREAK;
      ink = mix(u_paper, u_rainColour, (1.0 - behind / len) * 0.45 + 0.2);
    }
  }

  if (cover >= 0.15) {
    // A drop, drawn like the sharks: the cell's own point on the drop decides its shading, lit from
    // the top left, and the drop is coloured by the city it bends, gathering light even at night.
    vec4 here = texture2D(u_drops, centre);
    if (here.a < 0.5) here = drop;
    vec2 n = here.rg * 2.0 - 1.0;
    float thick = here.b;
    vec3 lens = texture2D(u_sharp, centre - n * (40.0 + 80.0 * thick) / u_res).rgb;
    vec3 gathered = texture2D(u_blur, centre - n * 140.0 / u_res).rgb;
    vec3 seen = light ? mix(lens, gathered, 0.5) : max(lens, gathered);
    float lit = dot(normalize(vec3(n, 0.35 + thick)), normalize(SUN));
    float shade = clamp(0.5 + 0.6 * lit, 0.0, 1.0);

    if (cover < 0.5) {
      // A bead too small to fill the cell, or the soft edge of a bigger drop.
      index = drop.b > 0.75 ? BEAD : 1.0;
      ink = light ? mix(u_water, seen * 0.6, 0.3) : max(u_water, seen * 1.3) * (0.7 + 0.4 * shade);
    } else {
      vec3 tile = light
        ? mix(u_paper, mix(u_water, seen, 0.25), 0.2 + 0.4 * (1.0 - shade))
        : u_water * (0.18 + 0.5 * shade) + seen * 0.55;
      // Tiles keep a hairline gap, like the sharks' skin.
      vec2 inner = inCell * u_cell;
      if (inner.x >= 1.0 && inner.y >= 1.0) base = tile;
      if (lit > 0.9) {
        index = GLINT;
        ink = vec3(1.0);
      } else {
        index = SKIN + floor(clamp(1.0 - shade, 0.0, 0.999) * 9.0);
        ink = light ? tile * 0.55 : tile * 1.7 + 0.06;
      }
    }
  }

  vec3 colour = mix(base, ink, glyph(index, inCell));
  // The house grid, faint, on the glass.
  vec2 off = inCell * u_cell;
  float edge = min(min(off.x, u_cell.x - off.x), min(off.y, u_cell.y - off.y));
  colour = mix(colour, u_grid.rgb, u_grid.a * (1.0 - smoothstep(0.0, 1.0 / u_dpr + 0.3, edge)));
  gl_FragColor = vec4(colour, 1.0);
}`;

function canvas2d(width = 1, height = 1) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** A drop seen head-on: its colour is the slope of its surface (r, g) and its thickness (b). */
function paintSprite() {
  const c = canvas2d(SPRITE, SPRITE);
  const g = c.getContext("2d")!;
  const img = g.createImageData(SPRITE, SPRITE);
  const half = SPRITE / 2;
  for (let y = 0; y < SPRITE; y++) {
    for (let x = 0; x < SPRITE; x++) {
      const nx = (x + 0.5 - half) / half;
      const ny = (y + 0.5 - half) / half;
      const d = Math.hypot(nx, ny);
      if (d > 1) continue;
      const i = (y * SPRITE + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = Math.sqrt(1 - d * d) * 255;
      img.data[i + 3] = clamp((1 - d) / 0.08, 0, 1) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function glow(g: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number) {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(${rgb},${alpha})`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/** A light's smear down a wet road. */
function reflection(g: CanvasRenderingContext2D, x: number, top: number, bottom: number, w: number, rgb: string, alpha: number) {
  const grad = g.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, `rgba(${rgb},${alpha})`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(x - w / 2, top, w, bottom - top);
}

/** The city behind the glass, laid out on the ASCII grid. Deterministic, so a resize keeps the same street. */
function paintCity(g: CanvasRenderingContext2D, W: number, H: number, cw: number, ch: number, font: string, p: CityPalette) {
  const street = Math.round((H * 0.84) / ch) * ch;
  const horizon = H * 0.62;

  const sky = g.createLinearGradient(0, 0, 0, street);
  sky.addColorStop(0, p.sky[0]);
  sky.addColorStop(0.6, p.sky[1]);
  sky.addColorStop(1, p.sky[2]);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // The city lights the low cloud from below.
  const haze = g.createRadialGradient(W / 2, street, 0, W / 2, street, Math.max(W, H) * 0.7);
  haze.addColorStop(0, `rgba(${p.haze},0.32)`);
  haze.addColorStop(1, `rgba(${p.haze},0)`);
  g.fillStyle = haze;
  g.fillRect(0, 0, W, H);

  g.font = `600 ${Math.round(ch * 0.74)}px ${font}`;
  g.textAlign = "center";
  g.textBaseline = "middle";

  // The far skyline: flat silhouettes with a scatter of dim windows.
  for (let x = 0, i = 0; x < W; i++) {
    const w = Math.round(3 + hash3(i, 1, 3) * 7) * cw;
    const top = horizon - H * (0.06 + hash3(i, 2, 3) * 0.3);
    g.fillStyle = p.far;
    g.fillRect(x, top, w, street - top);
    g.fillStyle = p.farWindow;
    for (let y = top + ch; p.farWindow && y < street - ch; y += ch) {
      for (let c = x + cw; c < x + w - cw; c += cw * 2) {
        if (hash3(c, y | 0, 5) < 0.14) g.fillText(".", c + cw / 2, y + ch / 2);
      }
    }
    x += w + (hash3(i, 4, 3) < 0.3 ? cw * 2 : 0);
  }

  // Near buildings: windows on a two-by-two grid, some lit, a few blue with a television on,
  // and every so often a neon sign running down the corner.
  for (let x = -cw * 3, i = 0; x < W; i++) {
    const w = (6 + Math.floor(hash3(i, 7, 9) * 9)) * cw;
    const top = Math.round((street - H * (0.24 + hash3(i, 8, 9) * 0.46)) / ch) * ch;
    g.fillStyle = p.near[i % 2];
    g.fillRect(x, top, w, street - top);
    const lit = (0.3 + hash3(i, 10, 9) * 0.45) * p.litShare;
    for (let y = top + ch; y < street - ch; y += ch * 2) {
      for (let c = x + cw; c < x + w - cw; c += cw * 2) {
        if (hash3(c, y, 11) < lit) {
          // A lit pane glows; its glyph sits on the glow. Out of focus, these become the city's bokeh.
          const colour = p.lit[Math.floor(hash3(c, y, 12) * p.lit.length)];
          g.globalAlpha = 0.45;
          g.fillStyle = colour;
          g.fillRect(c - cw * 0.1, y + ch * 0.1, cw * 1.2, ch * 0.8);
          g.globalAlpha = 1;
          g.fillText("#=+"[Math.floor(hash3(c, y, 13) * 3)], c + cw / 2, y + ch / 2);
        } else if (p.unlit) {
          g.fillStyle = p.unlit;
          g.fillText(".", c + cw / 2, y + ch / 2);
        }
      }
    }
    if (hash3(i, 14, 9) < 0.4 && street - top > ch * 9) {
      const word = SIGNS[Math.floor(hash3(i, 15, 9) * SIGNS.length)];
      const colour = p.neon[Math.floor(hash3(i, 16, 9) * p.neon.length)];
      const sx = x + w - cw / 2;
      g.save();
      g.globalAlpha = 0.18;
      g.fillStyle = colour;
      g.fillRect(sx - cw, top + ch * 1.5, cw * 2, ch * (word.length + 1));
      g.globalAlpha = 1;
      g.shadowColor = colour;
      g.shadowBlur = 22;
      g.fillStyle = colour;
      // Twice over, so the bloom carries through the blur.
      for (let pass = 0; pass < 2; pass++) {
        [...word].forEach((letter, k) => g.fillText(letter, sx, top + ch * (2 + k) + ch / 2));
      }
      g.restore();
    }
    x += w + (hash3(i, 17, 9) < 0.25 ? cw * 3 : 0);
  }

  // The street, wet: streetlights and traffic, each smeared down the road below it.
  g.fillStyle = p.street;
  g.fillRect(0, street, W, H - street);
  for (let lx = W * 0.08; lx < W; lx += W / 5.5) {
    glow(g, lx, street - ch * 5, ch * 4, p.lamp, 0.85);
    reflection(g, lx, street, H, cw * 3, p.lamp, 0.4);
  }
  for (let k = 0; k < 10; k++) {
    const head = k % 2 === 0;
    const cx = hash3(k, 20, 21) * W;
    const cy = street + (head ? ch * 1.3 : ch * 2.8);
    const rgb = head ? p.head : p.tail;
    for (const dx of [0, cw * 2.5]) {
      glow(g, cx + dx, cy, ch * 1.4, rgb, 0.9);
      reflection(g, cx + dx, cy, H, cw * 1.2, rgb, 0.35);
    }
  }
}

export class RainScene implements Scene {
  time = 0;
  pointer = { x: 0, y: 0, active: false };

  private gl: WebGLRenderingContext | null;
  private flat: CanvasRenderingContext2D | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  private theme: Theme;
  private fontFamily: string;
  private cellSize?: number;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private cw = 8;
  private ch = 12;
  private cols = 0;
  private rows = 0;

  private city = canvas2d();
  private blurred = canvas2d();
  /** This frame's drops as a normal map, which the shader refracts through. */
  private dropMap = canvas2d();
  /** Condensation: a mist of tiny droplets that running drops and the cursor clear. */
  private mist = canvas2d();
  private sprite = paintSprite();
  private glyphs = canvas2d();
  /** The blurred city at one pixel per cell, for drawing without WebGL. */
  private cells: ImageData | null = null;
  /** How fogged the glass is, per cell: 1 misted over, 0 wiped clean. */
  private fog = new Float32Array(0);
  /** Where running drops have been, per cell: 1 just wet, drying toward 0. */
  private wet = new Float32Array(0);
  private fogBytes = new Uint8Array(0);

  private drops: Drop[] = [];
  /** How hard it's raining: 1 is a steady shower; the chat's "thinking" brings a downpour. */
  private intensity = 1;
  private targetIntensity = 1;
  private spawnDebt = 0;
  private mistDebt = 0;
  private mistFadeAt = 0;
  private binCols = 0;
  private binHead = new Int32Array(0);
  private binNext = new Int32Array(0);

  constructor(private canvas: HTMLCanvasElement, options: SceneOptions) {
    this.theme = options.theme;
    this.fontFamily = options.fontFamily;
    this.cellSize = options.cellSize;
    this.gl = canvas.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: false });
    if (this.gl) this.setupGL(this.gl);
    else this.flat = canvas.getContext("2d", { alpha: false });
    // The city's glyphs need the webfont; paint it again once that's in.
    void document.fonts?.ready.then(() => this.paintScene());
  }

  dispose() {
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private setupGL(gl: WebGLRenderingContext) {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    this.program = program;

    // One triangle that covers the screen.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    for (const name of ["u_res", "u_dpr", "u_cell", "u_paper", "u_light", "u_fogColour", "u_fogStrength", "u_water", "u_rainColour", "u_grid", "u_time", "u_rain"]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    // Each texture keeps its own unit, so later uploads only need to pick the unit.
    TEXTURES.forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, `u_${name}`), unit);
    });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private upload(name: (typeof TEXTURES)[number], source: TexImageSource) {
    const gl = this.gl;
    if (!gl) return;
    gl.activeTexture(gl.TEXTURE0 + TEXTURES.indexOf(name));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.paintScene();
  }

  resize(width: number, height: number, dpr: number) {
    const first = this.width === 0;
    const sx = first ? 1 : width / this.width;
    const sy = first ? 1 : height / this.height;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = this.cellSize ?? clamp(Math.round(width / 124), 8, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    for (const c of [this.city, this.dropMap, this.mist]) {
      c.width = Math.ceil(width);
      c.height = Math.ceil(height);
    }
    // A fresh pane of fog; the drops stay, stretched to the new size.
    this.fog = new Float32Array(this.cols * this.rows).fill(1);
    this.wet = new Float32Array(this.cols * this.rows);
    this.fogBytes = new Uint8Array(this.cols * this.rows * 2);
    this.paintScene();

    if (first) {
      // Start mid-shower, with the glass already beaded.
      const beads = Math.round(this.maxDrops() * 0.6);
      for (let i = 0; i < beads; i++) this.addBead(rand(0, width), rand(0, height), Math.min(beadRadius(), RUN_RADIUS - 2));
    } else {
      for (const d of this.drops) {
        d.x *= sx;
        d.y *= sy;
      }
    }
  }

  /** Paint the city, blur a copy of it, and hand both to the shader. */
  private paintScene() {
    const { width: W, height: H, cw, ch } = this;
    if (!W) return;
    paintCity(this.city.getContext("2d")!, W, H, cw, ch, this.fontFamily, CITY[this.theme]);

    // Half resolution is plenty for something this out of focus.
    const b = this.blurred;
    b.width = Math.ceil(W / 2);
    b.height = Math.ceil(H / 2);
    const bg = b.getContext("2d")!;
    if ("filter" in CanvasRenderingContext2D.prototype) {
      bg.filter = "blur(11px)";
      bg.drawImage(this.city, 0, 0, b.width, b.height);
      bg.filter = "none";
    } else {
      // No canvas filters: shrink hard and scale back up, which blurs well enough.
      const tiny = canvas2d(Math.ceil(W / 24), Math.ceil(H / 24));
      tiny.getContext("2d")!.drawImage(this.city, 0, 0, tiny.width, tiny.height);
      bg.imageSmoothingQuality = "high";
      bg.drawImage(tiny, 0, 0, b.width, b.height);
    }

    // Every glyph the shader can draw, one cell each, at device resolution so they stay crisp.
    const gw = Math.round(cw * this.dpr);
    const gh = Math.round(ch * this.dpr);
    this.glyphs.width = gw * ATLAS.length;
    this.glyphs.height = gh;
    const a = this.glyphs.getContext("2d")!;
    a.clearRect(0, 0, this.glyphs.width, gh);
    a.font = `600 ${Math.round(ch * 0.74) * this.dpr}px ${this.fontFamily}`;
    a.textAlign = "center";
    a.textBaseline = "middle";
    a.fillStyle = "#fff";
    [...ATLAS].forEach((glyph, i) => a.fillText(glyph, i * gw + gw / 2, gh / 2 + this.dpr));

    const gl = this.gl;
    if (!gl || !this.program) {
      const small = canvas2d(this.cols, this.rows);
      const sg = small.getContext("2d")!;
      sg.drawImage(this.blurred, 0, 0, this.cols, this.rows);
      this.cells = sg.getImageData(0, 0, this.cols, this.rows);
      return;
    }
    this.upload("sharp", this.city);
    this.upload("blur", this.blurred);
    this.upload("glyphs", this.glyphs);
    const glass = GLASS[this.theme];
    gl.uniform3fv(this.uniforms.u_paper, glass.paper);
    gl.uniform1f(this.uniforms.u_light, glass.light);
    gl.uniform3fv(this.uniforms.u_fogColour, glass.fog);
    gl.uniform1f(this.uniforms.u_fogStrength, glass.fogStrength);
    gl.uniform3fv(this.uniforms.u_water, glass.water);
    gl.uniform3fv(this.uniforms.u_rainColour, glass.rain);
    gl.uniform4fv(this.uniforms.u_grid, glass.grid);
  }

  private maxDrops() {
    return Math.round((this.width * this.height) / 5000);
  }

  // ── reactions ───────────────────────────────────────────────────────

  /** A knock on the glass: nearby drops shake loose and run, and a fingertip clears the mist. */
  poke(x: number, y: number) {
    this.loosen(x, y, 200, 6);
    this.wipe(x, y, 30);
  }

  /** A message going out: a few fat drops land just above it and run. */
  splash(x: number, y: number) {
    for (let i = 0; i < 4; i++) {
      const d = this.addBead(x + rand(-140, 140), y - rand(20, 80), rand(19, 26));
      if (d) d.running = true;
    }
  }

  /** A keystroke: a bead lands on the glass just above where you're typing. */
  nudge(x: number, y: number) {
    this.addBead(x + rand(-12, 12), y - rand(8, 40), rand(2.5, 5));
  }

  /** Thinking: the rain comes down harder until the answer arrives. */
  circle() {
    this.targetIntensity = 3;
  }

  /** The answer: the downpour eases and the glass around the reply runs clear. */
  scatter(x: number, y: number) {
    this.targetIntensity = 1;
    this.loosen(x, y, 340, 6);
  }

  calm() {
    this.targetIntensity = 1;
  }

  private loosen(x: number, y: number, radius: number, minR: number) {
    for (const d of this.drops) {
      if (d.dead || d.r < minR || Math.hypot(d.x - x, d.y - y) > radius) continue;
      d.running = true;
      d.stuck = 0;
      d.vy = Math.max(d.vy, 30);
      d.trailY = d.y;
    }
  }

  /** Clear the mist and fog from a patch of glass. */
  private wipe(x: number, y: number, radius: number) {
    const m = this.mist.getContext("2d")!;
    m.globalCompositeOperation = "destination-out";
    m.beginPath();
    m.arc(x, y, radius, 0, TAU);
    m.fill();
    m.globalCompositeOperation = "source-over";

    const { cw, ch, cols, rows, fog } = this;
    const c0 = Math.max(0, Math.floor((x - radius) / cw));
    const c1 = Math.min(cols - 1, Math.floor((x + radius) / cw));
    const r0 = Math.max(0, Math.floor((y - radius) / ch));
    const r1 = Math.min(rows - 1, Math.floor((y + radius) / ch));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c * cw + cw / 2 - x, r * ch + ch / 2 - y) / radius;
        if (d < 1) fog[r * cols + c] = Math.min(fog[r * cols + c], d * d);
      }
    }
  }

  // ── simulation ──────────────────────────────────────────────────────

  /** Add a bead, merging it into any drop it lands on. Returns the drop it ended up as. */
  private addBead(x: number, y: number, r: number) {
    for (const d of this.drops) {
      if (d.dead || Math.abs(d.x - x) > d.r + r || Math.abs(d.y - y) > d.r + r) continue;
      if (Math.hypot(d.x - x, d.y - y) < d.r + r) {
        d.r = Math.hypot(d.r, r);
        return d;
      }
    }
    if (this.drops.length >= this.maxDrops()) return null;
    const drop: Drop = { x, y, r, vy: 0, running: false, stuck: 0, wobble: rand(0, TAU), trailY: y, life: rand(40, 90), dead: false };
    this.drops.push(drop);
    return drop;
  }

  step(dt: number) {
    const { width: W, height: H } = this;
    if (!W) return;
    this.time += dt;
    this.intensity += (this.targetIntensity - this.intensity) * Math.min(1, dt * 0.8);

    // New beads land in proportion to the glass and the weather.
    this.spawnDebt += ((W * H) / 1e6) * 32 * this.intensity * dt;
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      this.addBead(rand(0, W), rand(0, H), beadRadius());
    }
    this.stepMist(dt);

    this.rebuildBins();
    const fresh: Drop[] = [];
    for (const d of this.drops) {
      if (d.dead) continue;
      if (!d.running) {
        if (d.r > RUN_RADIUS) {
          d.running = true;
          d.trailY = d.y;
        } else if ((d.life -= dt) < 0) {
          d.r -= dt * 0.6;
          if (d.r < 0.8) d.dead = true;
        }
        continue;
      }
      this.run(d, dt, fresh);
    }
    for (const d of fresh) this.drops.push(d);
    if (this.drops.some((d) => d.dead)) this.drops = this.drops.filter((d) => !d.dead);

    // The fog creeps back over anything wiped, and trails dry.
    const regrow = Math.min(1, dt * 0.05);
    const dry = Math.exp(-dt / 1.2);
    for (let i = 0; i < this.fog.length; i++) {
      this.fog[i] += (1 - this.fog[i]) * regrow;
      this.wet[i] *= dry;
    }
    if (this.pointer.active) this.wipe(this.pointer.x, this.pointer.y, 46);
  }

  /** Condensation keeps forming as a mist of tiny droplets, and slowly evaporates. */
  private stepMist(dt: number) {
    const { width: W, height: H, sprite } = this;
    const m = this.mist.getContext("2d")!;
    this.mistDebt += ((W * H) / 1e6) * 260 * this.intensity * dt;
    while (this.mistDebt >= 1) {
      this.mistDebt -= 1;
      const s = 1.6 + Math.random() ** 2 * 3.4;
      m.drawImage(sprite, rand(0, W) - s / 2, rand(0, H) - s / 2, s, s * 1.08);
    }
    if (this.time > this.mistFadeAt) {
      this.mistFadeAt = this.time + 1;
      m.globalCompositeOperation = "destination-out";
      m.fillStyle = "rgba(0,0,0,0.05)";
      m.fillRect(0, 0, W, H);
      m.globalCompositeOperation = "source-over";
    }
  }

  /** A running drop: stick-slip down the glass, sweeping up beads, clearing a trail through the mist. */
  private run(d: Drop, dt: number, fresh: Drop[]) {
    if (d.stuck > 0) {
      d.stuck -= dt;
      return;
    }
    const terminal = 30 + d.r * 6;
    d.vy += (terminal - d.vy) * Math.min(1, dt * 3);
    d.y += d.vy * dt;
    d.x += Math.sin(this.time * 2.3 + d.wobble) * dt * 10 + (Math.random() - 0.5) * dt * 30;
    if (Math.random() < dt * 0.5) {
      d.stuck = rand(0.05, 0.35);
      d.vy *= 0.3;
    }
    this.wipe(d.x, d.y - d.r * 0.4, d.r * 0.9);
    const col = Math.floor(d.x / this.cw);
    const row = Math.floor((d.y - d.r) / this.ch);
    if (col >= 0 && row >= 0 && col < this.cols && row < this.rows) this.wet[row * this.cols + col] = 1;

    const bc = Math.floor(d.x / BIN);
    const br = Math.floor(d.y / BIN);
    for (let r = br - 1; r <= br + 1; r++) {
      for (let c = bc - 1; c <= bc + 1; c++) {
        if (c < 0 || r < 0 || c >= this.binCols) continue;
        let j = this.binHead[r * this.binCols + c] ?? -1;
        while (j !== -1) {
          const o = this.drops[j];
          if (o !== d && !o.dead && !o.running && Math.hypot(o.x - d.x, o.y - d.y) < d.r + o.r) {
            d.r = Math.hypot(d.r, o.r);
            o.dead = true;
          }
          j = this.binNext[j];
        }
      }
    }

    // Now and then it leaves a bead behind, losing a little water to it.
    if (d.y - d.trailY > rand(22, 44)) {
      const r = Math.min(d.r * 0.3, rand(2, 4.5));
      d.r = Math.sqrt(Math.max(0, d.r * d.r - r * r * 0.6));
      d.trailY = d.y;
      fresh.push({ x: d.x + rand(-1, 1), y: d.y - d.r, r, vy: 0, running: false, stuck: 0, wobble: 0, trailY: 0, life: rand(6, 14), dead: false });
    }
    if (d.r < 9) d.running = false;
    if (d.y - d.r > this.height) d.dead = true;
  }

  private rebuildBins() {
    const { width: W, height: H, drops } = this;
    this.binCols = Math.ceil(W / BIN) + 1;
    const n = this.binCols * (Math.ceil(H / BIN) + 2);
    if (this.binHead.length !== n) this.binHead = new Int32Array(n);
    this.binHead.fill(-1);
    if (this.binNext.length < drops.length) this.binNext = new Int32Array(drops.length * 2);
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (d.dead || d.running) continue;
      const b = Math.floor(d.y / BIN) * this.binCols + clamp(Math.floor(d.x / BIN), 0, this.binCols - 1);
      if (b < 0 || b >= n) continue;
      this.binNext[i] = this.binHead[b];
      this.binHead[b] = i;
    }
  }

  // ── drawing ─────────────────────────────────────────────────────────

  render() {
    if (!this.width) return;
    this.paintDrops();
    if (this.gl) this.renderGL(this.gl);
    else this.renderFlat();
  }

  /** The drop map: the mist, then every drop as a sprite, a little taller than wide, runners stretched. */
  private paintDrops() {
    const g = this.dropMap.getContext("2d")!;
    g.clearRect(0, 0, this.dropMap.width, this.dropMap.height);
    g.drawImage(this.mist, 0, 0);
    for (const d of this.drops) {
      if (d.dead) continue;
      const h = d.r * (d.running ? 2.5 : 2.15);
      g.drawImage(this.sprite, d.x - d.r, d.y - h * (d.running ? 0.62 : 0.5), d.r * 2, h);
    }
  }

  private renderGL(gl: WebGLRenderingContext) {
    const { fog, wet, fogBytes, cols, rows } = this;
    for (let i = 0; i < fog.length; i++) {
      fogBytes[i * 2] = fog[i] * 255;
      fogBytes[i * 2 + 1] = wet[i] * 255;
    }
    this.upload("drops", this.dropMap);
    gl.activeTexture(gl.TEXTURE0 + TEXTURES.indexOf("fog"));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, cols, rows, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, fogBytes);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uniforms.u_res, this.width, this.height);
    gl.uniform1f(this.uniforms.u_dpr, this.dpr);
    gl.uniform2f(this.uniforms.u_cell, this.cw, this.ch);
    // Wrapped, so the streaks' timing keeps its precision on a page left open for hours.
    gl.uniform1f(this.uniforms.u_time, this.time % 600);
    gl.uniform1f(this.uniforms.u_rain, this.intensity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** No WebGL: the misted city as glyphs, one per cell, and each drop as a pale tile. */
  private renderFlat() {
    const g = this.flat;
    const cells = this.cells;
    if (!g || !cells) return;
    const { width: W, height: H, dpr, cw, ch, cols, rows, fog } = this;
    const glass = GLASS[this.theme];
    const paper = glass.paper.map((c) => Math.round(c * 255));
    const mist = glass.fog.map((c) => c * 255);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = `rgb(${paper.join(",")})`;
    g.fillRect(0, 0, W, H);
    g.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const paperL = (0.299 * paper[0] + 0.587 * paper[1] + 0.114 * paper[2]) / 255;
    for (let i = 0; i < cols * rows; i++) {
      const f = fog[i] * glass.fogStrength;
      const rgb = [0, 1, 2].map((k) => cells.data[i * 4 + k] * (1 - f) + mist[k] * f);
      const L = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
      const density = clamp(glass.light ? (paperL - L - 0.04) * 2.6 : L * 1.6, 0, 0.999);
      const glyph = ATLAS[Math.floor(density * 10)];
      if (glyph === " ") continue;
      const k = glass.light ? 0.62 : 1.5;
      g.fillStyle = `rgb(${rgb.map((c) => Math.min(255, Math.round(c * k))).join(",")})`;
      g.fillText(glyph, (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
    const ink = this.theme === "light" ? "#56627a" : "#c9d6f0";
    const tile = this.theme === "light" ? "rgba(120,135,160,0.3)" : "rgba(150,170,215,0.25)";
    for (const d of this.drops) {
      // Beads are a single glyph; bigger drops fill the cells they cover with tiles.
      if (d.r < 6) {
        g.fillStyle = ink;
        g.fillText("o", Math.floor(d.x / cw) * cw + cw / 2, Math.floor(d.y / ch) * ch + ch / 2 + 1);
        continue;
      }
      for (let y = Math.floor((d.y - d.r) / ch); y <= Math.floor((d.y + d.r) / ch); y++) {
        for (let x = Math.floor((d.x - d.r) / cw); x <= Math.floor((d.x + d.r) / cw); x++) {
          if (Math.hypot(x * cw + cw / 2 - d.x, y * ch + ch / 2 - d.y) > d.r) continue;
          g.fillStyle = tile;
          g.fillRect(x * cw + 1, y * ch + 1, cw - 1, ch - 1);
          g.fillStyle = ink;
          g.fillText(y * ch < d.y - d.r * 0.4 && x * cw < d.x ? "'" : "%", x * cw + cw / 2, y * ch + ch / 2 + 1);
        }
      }
    }
  }
}
