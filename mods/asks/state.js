// Shared state and helpers for the Asks mods. The same file lives in mods/asks/ and
// mods/tabs-asks/ (mods import only their own folder). Keep both copies identical.
import { shared, setShared, readTextFile, appHome, terminals, agents } from "herdr";

export const KEY = "asks.state";
export const SCHEMA = 1;
export const MAX_ASKS = 60;
export const KEEP_MS = 24 * 3600 * 1000;
export const DEFAULTS = { label: "Asks", toast: false, log: "docs/decisions.md", classify: "auto", model: "haiku", trailing_questions: true };
// toast is off: Herdr already posts "needs you" for a blocked agent; true adds a second toast with the question.

export function readState() {
  const s = shared(KEY);
  return s && s.schema === SCHEMA && Array.isArray(s.asks) ? s : { schema: SCHEMA, asks: [] };
}

// Read, change, write. Writes only when something changed so mods don't re-render for nothing.
export function update(fn) {
  const before = JSON.stringify(readState());
  const s = JSON.parse(before);
  const out = fn(s);
  const after = JSON.stringify(s);
  if (after !== before) setShared(KEY, s);
  return out;
}

export async function loadConfig() {
  try {
    const text = await readTextFile(`${appHome()}/asks.json`);
    return text ? { ...DEFAULTS, ...JSON.parse(text) } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// hc ls describes status as {app, state, kind?, msg?}; the app flattens it to a word and
// keeps the report in `report`. Accept either shape.
export function statusOf(t) {
  return typeof t?.status === "string" ? t.status : t?.status?.state ?? null;
}
export function reportOf(t) {
  if (t?.report && typeof t.report === "object") return t.report;
  return typeof t?.status === "object" && t.status ? t.status : null;
}
export function msgOf(t) { return reportOf(t)?.msg ?? ""; }

export function liveTerminal(address) {
  return terminals().find((t) => t.address === address && t.state === "live") ?? null;
}

// The agent still sits at the same dialog it did when the ask was made.
export function stillAsking(ask) {
  const t = liveTerminal(ask.address);
  return Boolean(t) && statusOf(t) === "blocked" && msgOf(t) === ask.msg;
}

// A prose question (the agent ended its turn asking) is still open while the agent sits on
// that same turn, not working and not at a dialog.
export function stillIdle(ask) {
  const t = liveTerminal(ask.address);
  const st = statusOf(t);
  return Boolean(t) && (st === "idle" || st === "done") && (t.turn ?? 0) === (ask.turn ?? 0);
}

export function agentFor(address) {
  return agents().find((a) => a.address === address) ?? null;
}

// The sidebar's name for an agent: a named tab, else what the terminal says, else the program.
export function agentName(a, t) {
  if (!a) return t?.name || t?.address || "agent";
  const tab = a.tab_name ?? "";
  if (tab && !/^\d+$/.test(tab)) return tab;
  const title = (a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (title && title !== a.program?.name && !/^[~/]/.test(title)) return title;
  return a.program?.name || tab || a.address;
}

export function age(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
