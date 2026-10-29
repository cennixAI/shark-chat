import {
  DEFAULT_SYSTEM,
  describeError,
  isAbort,
  loadSettings,
  MODELS,
  respond,
  saveSettings,
  type Effort,
  type Message,
} from "./respond";
import { OceanEngine, type SceneKind, type SharkKind, type SharkSpec, type Theme } from "./src";

/** Four of one kind at different depths, like the original clip's hammerheads. */
const four = (kind: SharkKind): SharkSpec[] => [1, 0.86, 0.78, 0.7].map((size) => ({ kind, size }));

const SCHOOLS: Record<string, { label: string; sharks: SharkSpec[] }> = {
  mixed: {
    label: "Mixed",
    sharks: [
      { kind: "greathammer", size: 1 },
      { kind: "tiger", size: 0.88 },
      { kind: "mako", size: 0.82 },
      { kind: "thresher", size: 0.8 },
      { kind: "zebra", size: 0.72 },
    ],
  },
  hammerhead: { label: "Hammerhead", sharks: four("hammerhead") },
  greathammer: { label: "Great hammer", sharks: four("greathammer") },
  tiger: { label: "Tiger", sharks: four("tiger") },
  mako: { label: "Mako", sharks: four("mako") },
  thresher: { label: "Thresher", sharks: four("thresher") },
  zebra: { label: "Zebra", sharks: four("zebra") },
  nurse: { label: "Nurse", sharks: four("nurse") },
  classic: { label: "Classic", sharks: four("classic") },
};

const SCENES: Record<SceneKind, string> = {
  bloom: "A flower film, rendered as moving ASCII.",
  sharks: "Click the water and the curious ones swim over to look.",
  koi: "Click to scatter food, and the koi come to eat.",
  rain: "Move across the glass to wipe the fog away.",
  fireflies: "While the agent thinks, they fall into step and flash together.",
  flock: "Click and a falcon dives through the flock.",
  sky: "Click to place a star. While the agent thinks, a constellation draws itself.",
  ants: "Click to drop food. Every keystroke drops a crumb.",
  campfire: "Click to toss a stick on the fire.",
  zen: "Breathe with the gravel: in as it brightens, out as it dims. Click to set a stone.",
};

const OCEAN_KEY = "shark-chat.ocean";

function loadOcean() {
  const ocean: { reactive: boolean; school: string; scene: SceneKind } = { reactive: true, school: "mixed", scene: "sharks" };
  try {
    const saved = JSON.parse(localStorage.getItem(OCEAN_KEY) ?? "{}");
    if (typeof saved.reactive === "boolean") ocean.reactive = saved.reactive;
    if (saved.school in SCHOOLS) ocean.school = saved.school;
    if (saved.scene in SCENES) ocean.scene = saved.scene;
  } catch {
    // Unreadable settings: start from the defaults.
  }
  return ocean;
}

const ocean = loadOcean();

function saveOcean() {
  try {
    localStorage.setItem(OCEAN_KEY, JSON.stringify(ocean));
  } catch {
    // Unsaved: the settings still apply for this visit.
  }
}

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

// index.html's head script has already picked the theme from storage or the system setting.
const root = document.documentElement;
const engine = new OceanEngine($<HTMLCanvasElement>("canvas.ocean"), SCHOOLS[ocean.school].sharks, {
  theme: root.dataset.theme === "dark" ? "dark" : "light",
  cellSize: 8,
  reactive: ocean.reactive,
  scene: ocean.scene,
});

const form = $<HTMLFormElement>("#composer");
const prompt = $<HTMLTextAreaElement>("#prompt");
const sendButton = $<HTMLButtonElement>("#send");
const attachButton = $<HTMLButtonElement>("#attach");
const fileInput = $<HTMLInputElement>("#files");
const chips = $<HTMLUListElement>("#chips");
const micButton = $<HTMLButtonElement>("#mic");
const thread = $<HTMLOListElement>("#thread");
const historyButton = $<HTMLButtonElement>("#history");
const menu = $<HTMLDivElement>("#history-menu");
const themeSwitch = $<HTMLButtonElement>("#theme");
const fullscreenButton = $<HTMLButtonElement>("#fullscreen");
const oceanButton = $<HTMLButtonElement>("#ocean");
const oceanPanel = $<HTMLDivElement>("#ocean-panel");
const reactiveSwitch = $<HTMLButtonElement>("#reactive");
const schoolList = $<HTMLDivElement>("#schools");
const schoolsSection = $<HTMLDivElement>("#schools-section");
const sceneHint = $<HTMLParagraphElement>("#scene-hint");
const rotator = $<HTMLSpanElement>("#rotator");
const modelButton = $<HTMLButtonElement>("#model");
const modelName = $<HTMLSpanElement>("#model-name");
const modelPanel = $<HTMLDivElement>("#model-panel");
const apiKeyInput = $<HTMLInputElement>("#api-key");
const modelList = $<HTMLDivElement>("#model-list");
const systemInput = $<HTMLTextAreaElement>("#system");
const forgetKey = $<HTMLButtonElement>("#forget-key");
const modelSaved = $<HTMLSpanElement>("#model-saved");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ── theme ────────────────────────────────────────────────────────────

const THEME_KEY = "shark-chat.theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");

function savedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme) {
  root.dataset.theme = theme;
  engine.setTheme(theme);
  themeSwitch.setAttribute("aria-checked", String(theme === "dark"));
}

themeSwitch.addEventListener("click", () => {
  const next: Theme = root.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Unsaved: the switch still works for this visit.
  }
  // Crossfade the whole page, water included, where the browser can.
  const swap = () => applyTheme(next);
  if (document.startViewTransition && !reducedMotion.matches) document.startViewTransition(swap);
  else swap();
});

// Until someone flips the switch, follow the system setting.
systemDark.addEventListener("change", (e) => {
  if (!savedTheme()) applyTheme(e.matches ? "dark" : "light");
});

themeSwitch.setAttribute("aria-checked", String(root.dataset.theme === "dark"));

// ── full screen ──────────────────────────────────────────────────────

// iPhone Safari can't take a page full screen, so the button only shows where it works.
fullscreenButton.hidden = !document.fullscreenEnabled;

fullscreenButton.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else root.requestFullscreen({ navigationUI: "hide" }).catch((err) => console.warn("Full screen refused:", err));
});

// Esc and the browser's own controls exit too, so the button follows the document rather than its own clicks.
document.addEventListener("fullscreenchange", () => {
  const on = document.fullscreenElement !== null;
  fullscreenButton.setAttribute("aria-pressed", String(on));
  fullscreenButton.setAttribute("aria-label", on ? "Exit full screen" : "Enter full screen");
});

// ── popovers ─────────────────────────────────────────────────────────

/** A button that opens a floating panel; clicking elsewhere or pressing Escape closes it. */
function popover(button: HTMLButtonElement, panel: HTMLElement, onOpen: () => void) {
  const close = () => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    onOpen();
  });
  document.addEventListener("pointerdown", (e) => {
    const target = e.target as Node;
    if (!panel.hidden && !panel.contains(target) && !button.contains(target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || panel.hidden) return;
    close();
    button.focus();
  });
  return close;
}

// ── ocean settings ───────────────────────────────────────────────────

popover(oceanButton, oceanPanel, () => oceanPanel.querySelector<HTMLInputElement>('input[name="scene"]:checked')?.focus());

function showScene(kind: SceneKind) {
  sceneHint.textContent = SCENES[kind];
  schoolsSection.hidden = kind !== "sharks";
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="scene"]')) {
  const kind = radio.value as SceneKind;
  radio.checked = kind === ocean.scene;
  radio.addEventListener("change", () => {
    ocean.scene = kind;
    saveOcean();
    showScene(kind);
    // Crossfade from one scene to the next where the browser can.
    const swap = () => engine.setScene(kind);
    if (document.startViewTransition && !reducedMotion.matches) document.startViewTransition(swap);
    else swap();
  });
}
showScene(ocean.scene);

reactiveSwitch.setAttribute("aria-checked", String(ocean.reactive));
reactiveSwitch.addEventListener("click", () => {
  ocean.reactive = !ocean.reactive;
  reactiveSwitch.setAttribute("aria-checked", String(ocean.reactive));
  engine.setReactive(ocean.reactive);
  saveOcean();
});

for (const [id, school] of Object.entries(SCHOOLS)) {
  const option = document.createElement("label");
  option.className = "school";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "school";
  radio.value = id;
  radio.checked = id === ocean.school;
  radio.addEventListener("change", () => {
    ocean.school = id;
    engine.setSharks(school.sharks);
    saveOcean();
  });
  const name = document.createElement("span");
  name.textContent = school.label;
  option.append(radio, name);
  schoolList.append(option);
}

// ── model ────────────────────────────────────────────────────────────

const modelSettings = loadSettings();
let savedTimer = 0;

function syncModelButton() {
  const model = MODELS.find((m) => m.id === modelSettings.model);
  const connected = modelSettings.apiKey !== "";
  modelButton.classList.toggle("connected", connected);
  modelName.textContent = connected && model ? model.label : "Add model";
  modelButton.setAttribute("aria-label", connected && model ? `Model: ${model.label}` : "Add a model");
}

/** Save as you go, and say so quietly. */
function commitModel() {
  saveSettings(modelSettings);
  syncModelButton();
  modelSaved.textContent = "Saved";
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (modelSaved.textContent = ""), 1400);
}

for (const model of MODELS) {
  const option = document.createElement("label");
  option.className = "model-option";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "model";
  radio.value = model.id;
  radio.checked = model.id === modelSettings.model;
  radio.addEventListener("change", () => {
    modelSettings.model = model.id;
    commitModel();
  });
  const card = document.createElement("span");
  const name = document.createElement("b");
  name.textContent = model.label;
  name.style.fontWeight = "500";
  const note = document.createElement("small");
  note.textContent = model.note;
  card.append(name, note);
  option.append(radio, card);
  modelList.append(option);
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="effort"]')) {
  radio.checked = radio.value === modelSettings.effort;
  radio.addEventListener("change", () => {
    modelSettings.effort = radio.value as Effort;
    commitModel();
  });
}

apiKeyInput.value = modelSettings.apiKey;
apiKeyInput.addEventListener("change", () => {
  modelSettings.apiKey = apiKeyInput.value.trim();
  commitModel();
});

systemInput.value = modelSettings.system;
systemInput.placeholder = DEFAULT_SYSTEM;
systemInput.addEventListener("change", () => {
  modelSettings.system = systemInput.value.trim() || DEFAULT_SYSTEM;
  systemInput.value = modelSettings.system;
  commitModel();
});

forgetKey.addEventListener("click", () => {
  modelSettings.apiKey = "";
  apiKeyInput.value = "";
  commitModel();
  apiKeyInput.focus();
});

popover(modelButton, modelPanel, () => {
  // Open toward whichever side has more room, and never past the top bar or the bottom edge.
  const dock = modelPanel.parentElement!.getBoundingClientRect();
  const above = dock.top - 64;
  const below = innerHeight - dock.bottom - 16;
  const up = above >= 420 || above >= below;
  modelPanel.classList.toggle("opens-down", !up);
  modelPanel.style.maxHeight = `${Math.max(220, Math.min(560, up ? above : below))}px`;
  const first = modelSettings.apiKey ? modelList.querySelector<HTMLInputElement>("input:checked") : apiKeyInput;
  first?.focus();
});
syncModelButton();

// ── rotating headline ────────────────────────────────────────────────

// After tethr: every few seconds the word flips up and out while the next flips in, its letters
// scrambling through shark-skin glyphs and settling left to right. Screen readers get the plain heading.
const WORDS = ["mind?", "plate?", "radar?", "roadmap?", "list?"];
const SCRAMBLE = "abcdefghijklmnopqrstuvwxyz%#@:;";

function setupHeadline() {
  let index = 0;
  let timer = 0;
  let landing: { el: HTMLElement; word: string } | null = null;
  const widths = new Map<string, number>();

  // The slot eases to each word's width, so the centred line re-centres smoothly instead of jumping.
  function measure() {
    const probe = document.createElement("span");
    probe.className = "word word-probe";
    rotator.append(probe);
    for (const word of WORDS) {
      probe.textContent = word;
      widths.set(word, probe.getBoundingClientRect().width);
    }
    probe.remove();
    rotator.style.width = `${widths.get(WORDS[index])}px`;
  }

  const allowed = () => !reducedMotion.matches && !document.hidden && document.body.dataset.state === "idle";

  /** Finish any flip in progress at once, so a pause never strands a half-scrambled word. */
  function settle() {
    clearTimeout(timer);
    if (landing) landing.el.textContent = landing.word;
    landing = null;
    rotator.querySelectorAll(".word-outgoing").forEach((el) => el.remove());
  }

  function schedule() {
    settle();
    if (allowed()) timer = window.setTimeout(rotate, 2900);
  }

  function rotate() {
    if (!allowed()) return schedule();
    const outgoing = rotator.querySelector<HTMLElement>(".word-current")!;
    index = (index + 1) % WORDS.length;
    const word = WORDS[index];
    const incoming = document.createElement("span");
    incoming.className = "word word-current word-arriving";
    incoming.addEventListener("animationend", () => incoming.classList.remove("word-arriving"), { once: true });
    outgoing.className = "word word-outgoing";
    outgoing.addEventListener("animationend", () => outgoing.remove(), { once: true });
    rotator.append(incoming);
    rotator.style.width = `${widths.get(word)}px`;
    landing = { el: incoming, word };

    const started = performance.now();
    const scramble = () => {
      const settled = Math.floor(Math.max(0, performance.now() - started - 150) / 75);
      if (settled >= word.length) return schedule();
      incoming.textContent = Array.from(word, (ch, i) =>
        i < settled || ch === "?" ? ch : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)],
      ).join("");
      timer = window.setTimeout(scramble, 45);
    };
    scramble();
  }

  measure();
  void document.fonts.ready.then(measure);
  addEventListener("resize", measure);
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", schedule);
  schedule();
  return schedule;
}

/** Restart the rotation, or stop it once the heading is hidden by the chat. */
const restartHeadline = setupHeadline();

// ── conversations ────────────────────────────────────────────────────

interface Conversation {
  id: string;
  title: string;
  updated: number;
  messages: Message[];
}

const STORE_KEY = "shark-chat.conversations";
const MAX_STORED = 30;

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Conversation[]) : [];
  } catch {
    return [];
  }
}

function saveConversations() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(conversations.slice(0, MAX_STORED)));
  } catch {
    // Private mode or full storage: history just won't survive a reload.
  }
}

let conversations = loadConversations();
let current: Conversation | null = null;
let streaming: AbortController | null = null;
let attachments: File[] = [];

/** Idle shows the big prompt; chat docks the composer under the thread. The composer glides between the two. */
function setState(state: "idle" | "chat") {
  if (document.body.dataset.state === state) return;
  const before = form.getBoundingClientRect().top;
  document.body.dataset.state = state;
  restartHeadline();
  if (reducedMotion.matches) return;
  const after = form.getBoundingClientRect().top;
  form.animate([{ transform: `translateY(${before - after}px)` }, { transform: "none" }], {
    duration: 520,
    easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  });
}

function openConversation(conversation: Conversation | null) {
  streaming?.abort();
  current = conversation;
  thread.replaceChildren();
  conversation?.messages.forEach(renderMessage);
  setState(conversation ? "chat" : "idle");
  scrollToEnd();
  prompt.focus();
}

// ── thread ───────────────────────────────────────────────────────────

/** Appends a message and returns the element its text lives in, so replies can stream into it. */
function renderMessage(message: Message) {
  const item = document.createElement("li");
  item.className = `msg ${message.role}`;
  if (message.attachments?.length) {
    const files = document.createElement("div");
    files.className = "msg-files";
    for (const name of message.attachments) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = name;
      files.append(chip);
    }
    item.append(files);
  }
  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = message.text;
  item.append(text);
  thread.append(item);
  return text;
}

function scrollToEnd() {
  thread.scrollTop = thread.scrollHeight;
}

const SPINNER = "|/-\\";

/** An ASCII spinner while waiting on the first chunk. Returns a stop function. */
function spin(el: HTMLElement) {
  let frame = 0;
  el.classList.add("pending");
  el.textContent = SPINNER[0];
  const timer = setInterval(() => {
    el.textContent = SPINNER[++frame % SPINNER.length];
  }, 110);
  return () => {
    clearInterval(timer);
    el.classList.remove("pending");
  };
}

async function send() {
  const text = prompt.value.trim();
  if ((!text && !attachments.length) || streaming) return;

  if (!current) {
    current = {
      id: crypto.randomUUID(),
      title: (text || attachments[0].name).slice(0, 80),
      updated: Date.now(),
      messages: [],
    };
    conversations.unshift(current);
  }
  const conversation = current;
  // The water answers too: a ripple off the composer, then the sharks circle while the agent thinks.
  const box = form.getBoundingClientRect();
  engine.splash(box.left + box.width / 2, box.top + box.height / 2);
  engine.circle();

  const ask: Message = { role: "user", text };
  if (attachments.length) {
    ask.attachments = attachments.map((file) => file.name);
    ask.files = await readFiles(attachments);
  }
  conversation.messages.push(ask);
  renderMessage(ask);
  saveConversations();

  prompt.value = "";
  attachments = [];
  renderChips();
  setState("chat");

  const history = conversation.messages.slice();
  const reply: Message = { role: "assistant", text: "" };
  conversation.messages.push(reply);
  const out = renderMessage(reply);
  const item = out.parentElement!;
  item.setAttribute("aria-busy", "true");
  const stopSpinner = spin(out);
  scrollToEnd();

  streaming = new AbortController();
  syncComposer();
  let answered = false;
  try {
    for await (const chunk of respond(history, modelSettings, streaming.signal)) {
      stopSpinner();
      if (!answered) {
        // First words in: the sharks scatter from the reply.
        answered = true;
        const bubble = item.getBoundingClientRect();
        engine.scatter(bubble.left + bubble.width / 2, bubble.top + bubble.height / 2);
      }
      reply.text += chunk;
      out.textContent = reply.text;
      scrollToEnd();
    }
  } catch (err) {
    stopSpinner();
    if (!isAbort(err)) {
      console.error(err);
      reply.text = reply.text ? `${reply.text}\n\n(${describeError(err)})` : describeError(err);
      out.textContent = reply.text;
    }
  } finally {
    stopSpinner();
    if (!answered) engine.calm();
    item.removeAttribute("aria-busy");
    // Stopped before a single word arrived: drop the empty bubble.
    if (!reply.text) {
      conversation.messages.splice(conversation.messages.indexOf(reply), 1);
      item.remove();
    }
    streaming = null;
    conversation.updated = Date.now();
    conversations = [conversation, ...conversations.filter((c) => c !== conversation)];
    saveConversations();
    syncComposer();
  }
}

/** Text files ride along to the model; anything else is just named. Big files are left out rather than cut short. */
const MAX_FILE = 200_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|typescript|x-sh|x-yaml|toml))/;
const TEXT_NAMES = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|yml|yaml|toml|css|scss|html|sql|vue|svelte|astro|env|ini|csv)$/i;

async function readFiles(files: File[]) {
  const read: { name: string; text: string }[] = [];
  for (const file of files) {
    if (!(TEXT_TYPES.test(file.type) || TEXT_NAMES.test(file.name))) continue;
    if (file.size > MAX_FILE) {
      read.push({ name: file.name, text: `(Not sent: ${Math.round(file.size / 1000)} KB is over the ${MAX_FILE / 1000} KB limit.)` });
      continue;
    }
    read.push({ name: file.name, text: await file.text() });
  }
  return read;
}

// ── composer ─────────────────────────────────────────────────────────

function syncComposer() {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 200)}px`;
  const busy = streaming !== null;
  sendButton.classList.toggle("busy", busy);
  sendButton.classList.toggle("ready", busy || prompt.value.trim() !== "" || attachments.length > 0);
  sendButton.setAttribute("aria-label", busy ? "Stop" : "Send");
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (streaming) streaming.abort();
  else void send();
});

prompt.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (!streaming) void send();
});

prompt.addEventListener("input", (e) => {
  syncComposer();
  typingRipple(e as InputEvent);
});

// Each keystroke touches the scene just above where you're typing, a few times a second at most.
let lastRipple = 0;
function typingRipple(e: InputEvent) {
  if (!e.inputType?.startsWith("insert") || performance.now() - lastRipple < 70) return;
  lastRipple = performance.now();
  const box = form.getBoundingClientRect();
  const before = prompt.value.slice(0, prompt.selectionStart ?? prompt.value.length);
  const column = before.length - before.lastIndexOf("\n") - 1;
  const x = box.left + Math.min(box.width - 16, 16 + column * 7.4);
  engine.nudge(x, box.top);
}

function renderChips() {
  chips.replaceChildren(
    ...attachments.map((file, i) => {
      const chip = document.createElement("li");
      chip.className = "chip";
      chip.textContent = file.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-x";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.addEventListener("click", () => {
        attachments.splice(i, 1);
        renderChips();
        prompt.focus();
      });
      chip.append(remove);
      return chip;
    }),
  );
  chips.hidden = attachments.length === 0;
  syncComposer();
}

attachButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  attachments.push(...Array.from(fileInput.files ?? []));
  fileInput.value = "";
  renderChips();
  prompt.focus();
});

// ── voice ────────────────────────────────────────────────────────────

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

const speechWindow = window as unknown as {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
let listening: Recognition | null = null;

if (!SpeechRecognition) {
  micButton.disabled = true;
  micButton.title = "Voice input isn't supported in this browser";
}

function setListening(on: boolean) {
  micButton.classList.toggle("listening", on);
  micButton.setAttribute("aria-pressed", String(on));
}

micButton.addEventListener("click", () => {
  if (!SpeechRecognition) return;
  if (listening) {
    listening.stop();
    return;
  }
  // Dictation appends to whatever is already typed.
  const typed = prompt.value.replace(/\s*$/, prompt.value.trim() ? " " : "");
  const recognition = new SpeechRecognition();
  recognition.lang = navigator.language;
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.onresult = (e) => {
    let heard = "";
    for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
    prompt.value = typed + heard;
    syncComposer();
  };
  recognition.onend = recognition.onerror = () => {
    listening = null;
    setListening(false);
  };
  listening = recognition;
  setListening(true);
  recognition.start();
  prompt.focus();
});

// ── history menu ─────────────────────────────────────────────────────

function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function menuItem(label: string, meta: string, pick: () => void, active = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item";
  button.setAttribute("role", "menuitem");
  if (active) button.setAttribute("aria-current", "true");
  const name = document.createElement("span");
  name.className = "menu-label";
  name.textContent = label;
  button.append(name);
  if (meta) {
    const when = document.createElement("span");
    when.className = "menu-meta";
    when.textContent = meta;
    button.append(when);
  }
  button.addEventListener("click", () => {
    closeMenu();
    pick();
  });
  return button;
}

const closeMenu = popover(historyButton, menu, () => {
  const items: HTMLElement[] = [menuItem("New chat", "", () => openConversation(null))];
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "menu-empty";
    empty.textContent = "No conversations yet";
    items.push(empty);
  }
  for (const c of conversations) {
    items.push(menuItem(c.title, timeAgo(c.updated), () => openConversation(c), c === current));
  }
  menu.replaceChildren(...items);
  menu.querySelector<HTMLElement>(".menu-item")?.focus();
});

document.addEventListener("keydown", (e) => {
  if (menu.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...menu.querySelectorAll<HTMLElement>(".menu-item")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }
});

syncComposer();
if (matchMedia("(pointer: fine)").matches) prompt.focus();

