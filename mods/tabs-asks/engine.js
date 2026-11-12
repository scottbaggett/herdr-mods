// Detection and understanding. Runs inside the tab bar mod because that copy is always
// shown, so asks are found and counted before the panel is ever opened.
import { terminals, agents, focused, hc, exec, notify, appHome } from "herdr";
import { readState, update, hash, statusOf, reportOf, msgOf, agentName, MAX_ASKS, KEEP_MS } from "./state.js";
const MAX_CHECKED = 300;

// A prompt the person sent, not the input box at the bottom (which sits under a rule
// and may hold text typed but not yet sent).
function sentPrompt(lines, i) {
  if (!/^❯\s+\S/.test(lines[i])) return false;
  let j = i - 1;
  while (j >= 0 && !lines[j].trim()) j--;
  return !(j >= 0 && RULE.test(lines[j]));
}

// A list of separate questions is not a list of answers. If the model returned the
// questions as options (or several questions at once), there is nothing to click: the
// card lists the questions and takes one typed answer.
export function normalize(model) {
  if (!model) return model;
  const isQ = (s) => /\?\s*$/.test(s);
  const sub = (q) => {
    const o = typeof q === "string" ? { text: q } : q ?? {};
    const options = (Array.isArray(o.options) ? o.options : []).map((x) => String(x).trim()).filter((x) => x && !isQ(x));
    const recommended = Number.isInteger(o.recommended) && o.recommended >= 0 && o.recommended < options.length ? o.recommended : null;
    return { text: String(o.text ?? "").trim(), options, recommended };
  };
  const questions = (Array.isArray(model.questions) ? model.questions : []).map(sub).filter((q) => q.text);
  const options = Array.isArray(model.options) ? model.options.map((o) => String(o).trim()).filter(Boolean) : [];
  const asking = options.filter(isQ).length;
  if (questions.length > 1 || (options.length > 1 && asking >= Math.ceil(options.length / 2))) {
    return { ...model, options: [], recommended: null, questions: questions.length > 1 ? questions : options.filter(isQ).map(sub) };
  }
  return { ...model, options, questions: [] };
}

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    asks: { type: "boolean" },
    kind: { type: "string", enum: ["APPROVAL", "DECISION", "QUESTION", "UNCLEAR"] },
    question: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "object", properties: {
      text: { type: "string" }, options: { type: "array", items: { type: "string" } }, recommended: { type: ["integer", "null"] },
    }, required: ["text", "options", "recommended"], additionalProperties: false } },
    recommended: { type: ["integer", "null"] },
    context: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["asks", "kind", "question", "options", "questions", "recommended", "context", "confidence"],
  additionalProperties: false,
});

const OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(.*?)\s*$/;
const RULE = /^[\s─╌═━]+$/;

// Numbered options on a screen, with the cursor's line and the line under each option.
export function parseScreen(text) {
  const lines = (text ?? "").replace(/\r/g, "").split("\n");
  // Only the dialog at the bottom: start after the last rule above the first option run.
  let options = [], cursor = null, context = "", question = "";
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION.exec(lines[i]);
    if (!m) continue;
    const n = Number(m[2]);
    if (options.length && n !== options.at(-1).n + 1) { options = []; cursor = null; }
    if (!options.length && n !== 1) continue;
    const detail = lines[i + 1] && !OPTION.test(lines[i + 1]) && !RULE.test(lines[i + 1]) && /^\s{4,}\S/.test(lines[i + 1]) ? lines[i + 1].trim() : "";
    options.push({ n, label: m[3], detail });
    if (m[1]) cursor = n;
  }
  if (options.length) {
    const first = lines.findIndex((l) => OPTION.exec(l)?.[2] === "1" && l.includes(options[0].label));
    for (let i = first - 1; i >= 0 && first - i < 12; i--) {
      const l = lines[i].trim();
      if (!l || RULE.test(l)) continue;
      if (/\?\s*$/.test(l) && !question) { question = l; continue; }
      if (question) break;
    }
  }
  // Context: the agent's last line of prose in the current turn (after the last prompt the person sent).
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (sentPrompt(lines, i)) { start = i; break; }
  for (let i = lines.length - 1; i >= start; i--) {
    const l = lines[i];
    if (/^⏺\s+\S/.test(l) && !/^⏺\s+(User answered|Write\(|Read\(|Bash\(|Edit\()/.test(l)) { context = l.replace(/^⏺\s+/, "").trim(); break; }
  }
  return { options, cursor, context, question };
}

// Claude Code says what it wants in its status report: no model needed.
export function parseReport(report) {
  const msg = report?.msg ?? "";
  if (report?.kind === "question") {
    const m = /^answer:\s*([\s\S]*?)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(msg);
    if (m) {
      const opts = m[2].split(" · ").map((s) => s.trim()).filter(Boolean);
      const rec = opts.findIndex((o) => /\(recommended\)/i.test(o));
      return { kind: "DECISION", question: m[1], options: opts.map((label, i) => ({ n: i + 1, label, detail: "" })), recommended: rec >= 0 ? rec : null, source: "report" };
    }
    return { kind: "QUESTION", question: msg.replace(/^answer:\s*/, ""), options: [], recommended: null, source: "report" };
  }
  if (report?.kind === "permission") {
    const m = /^approve\s+([^:]+):\s*([\s\S]*)$/.exec(msg);
    return { kind: "APPROVAL", question: m ? `Allow ${m[1]}: ${m[2]}` : msg.replace(/^approve\s*/, "Allow "), options: [], recommended: null, source: "report" };
  }
  if (report?.kind) return { kind: "UNCLEAR", question: msg || `${report.kind}`, options: [], recommended: null, source: "report" };
  return null;
}

// The agent's own words since the person's last prompt, without tool lines and the
// "✻ done" footer: what a finished turn said. hasQuestion is the cheap pre-filter.
export function parseLastMessage(text) {
  const lines = (text ?? "").replace(/\r/g, "").split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (sentPrompt(lines, i)) { start = i; break; }
  if (start < 0) return { message: "", hasQuestion: false };
  // Skip the prompt's own continuation lines.
  let i = start + 1;
  while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[⏺•·✻✢✶✽*]/.test(lines[i])) i++;
  const out = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^[✻✢✶✽*]\s.*·\s*(done|idle)/.test(l) || RULE.test(l) || /^❯/.test(l)) break;
    if (/^\s*(⎿|Searched for|Read \d|Ran \d|Listed \d|Wrote \d|Edited \d)/.test(l)) continue;
    if (/^[⏺•]\s+(Write|Read|Bash|Edit|Grep|Glob|Update|Search|Task)\(/.test(l)) continue;
    out.push(l.replace(/^[⏺•]\s+/, "").trimEnd());
  }
  const message = out.join("\n").trim();
  return { message, hasQuestion: /\?(\s|$)/.test(message) };
}

export class Engine {
  constructor() { this.config = null; this.enriching = new Set(); this.notified = new Set(); this.checking = new Set(); this.started = false; }

  // Called every two seconds and from render: agents() is live, so a blocked agent is seen at once.
  tick(cx) {
    const now = Date.now();
    const live = terminals().filter((t) => t.state === "live");
    const byAddress = new Map(live.map((t) => [t.address, t]));
    const list = agents();
    const fresh = [], toCheck = [];
    update((s) => {
      for (const t of live) {
        if (statusOf(t) !== "blocked") continue;
        const msg = msgOf(t);
        const id = `${t.address}:${t.turn ?? 0}:${hash(msg)}`;
        const known = s.asks.find((a) => a.id === id);
        if (known) {
          // Marked stale while the dialog is in fact still up (a reload, a slow report): bring it back.
          if (known.state === "stale") { known.state = "pending"; known.note = null; delete known.ended_at; }
          continue;
        }
        for (const a of s.asks) if (a.address === t.address && a.state === "pending") { a.state = "stale"; a.note = "Resolved in terminal"; a.ended_at = now; }
        const agent = list.find((x) => x.address === t.address) ?? null;
        const report = reportOf(t), parsed = parseReport(report);
        const ask = {
          id, address: t.address, pane: agent?.pane ?? null, space: agent?.space ?? t.labels?.["herdr.space"] ?? null,
          space_name: agent?.space_name ?? (t.labels?.where ?? "").split(" / ")[0] ?? "",
          agent: agentName(agent, t), program: agent?.program ? { key: agent.program.key, name: agent.program.name, icon: agent.program.icon, tint: agent.program.tint } : null,
          app: report?.app ?? agent?.app ?? null, cwd: t.cwd ?? null, turn: t.turn ?? 0, msg,
          detected_at: now, state: "pending",
          kind: parsed?.kind ?? "UNCLEAR", question: parsed?.question ?? "", options: parsed?.options ?? [], recommended: parsed?.recommended ?? null,
          context: "", raw: "", source: parsed?.source ?? "none", confidence: parsed ? 1 : 0, enriched: false,
          answer: null, answered_at: null, error: null, note: null,
        };
        s.asks.unshift(ask);
        fresh.push(ask);
      }
      // Right after a reload terminals() can be empty or without reports for a moment: a card
      // goes stale only when its dialog has been gone for 3 s, and never while nothing is listed.
      if (live.length) for (const a of s.asks) {
        const t = byAddress.get(a.address);
        const st = statusOf(t);
        // An answer the panel gave up on (no reaction in time) was often just held by hc until
        // the terminal went quiet: once the agent moves on, it was delivered after all.
        if ((a.state === "failed" || a.state === "sending") && t && a.sent_turn != null) {
          const moved = (t.turn ?? 0) > a.sent_turn || (a.delivery !== "send" && !(st === "blocked" && msgOf(t) === a.msg));
          if (moved && a.state === "failed") { a.state = "delivered"; a.answered_at = now; a.error = null; a.note = "Picked up late"; }
          continue;
        }
        if (a.state !== "pending") continue;
        const gone = !t ? "Agent closed"
          : a.delivery === "send" ? ((st === "idle" || st === "done") && (t.turn ?? 0) === (a.turn ?? 0) ? null : "Answered in terminal")
          : st !== "blocked" || msgOf(t) !== a.msg ? "Resolved in terminal" : null;
        if (!gone) { delete a.gone_since; continue; }
        a.gone_since ??= now;
        if (now - a.gone_since >= 3000) { a.state = "stale"; a.note = gone; a.ended_at = now; delete a.gone_since; }
      }
      // Finished turns: a turn the agent ended in prose may still be a question for the person.
      // Each (address, turn) is checked once; the first pass skips turns already idle when we started.
      s.checked ??= [];
      const checked = new Set(s.checked);
      if (this.config && this.config.trailing_questions !== false && this.config.classify !== "off") for (const t of live) {
        const st = statusOf(t);
        if (st !== "done" && st !== "idle") continue;
        const key = `${t.address}:p:${t.turn ?? 0}`;
        if (checked.has(key) || s.asks.some((a) => a.id === key)) continue;
        checked.add(key); s.checked.push(key);
        if (!this.started && st === "idle") continue;
        toCheck.push(t);
      }
      if (s.checked.length > MAX_CHECKED) s.checked = s.checked.slice(-MAX_CHECKED);
      s.asks = s.asks.filter((a) => a.state === "pending" || a.state === "sending" || now - (a.ended_at ?? a.answered_at ?? a.detected_at) < KEEP_MS).slice(0, MAX_ASKS);
    });
    if (this.config) this.started = true;
    for (const t of toCheck) this.checkTurn(t, list.find((x) => x.address === t.address) ?? null, cx);
    for (const ask of fresh) {
      this.enrich(ask.id, cx);
      if (this.config?.toast !== false && !this.notified.has(ask.id) && focused()?.terminal !== ask.address) {
        this.notified.add(ask.id);
        notify({ title: `${ask.agent} is asking`, body: ask.question || "needs your input", level: "warning", timeout: 5000, action: { name: "tabs-asks.open" } });
      }
    }
  }

  // Read the screen for numbering, the question line and context; ask a model only when the
  // report said nothing usable (another agent, or an unknown report).
  enrich(id, cx) {
    if (this.enriching.has(id)) return;
    this.enriching.add(id);
    cx.spawn(async (cx) => {
      try {
        const ask = readState().asks.find((a) => a.id === id);
        if (!ask) return;
        let screen = null;
        try {
          const r = await hc(["read", ask.address, "--json"]);
          if (r.code === 0) screen = JSON.parse(r.stdout);
        } catch {}
        const text = screen?.text ?? "";
        const parsed = parseScreen(text);
        const patch = { raw: text.split("\n").slice(-40).join("\n").slice(-3000), context: parsed.context, enriched: true };
        if (ask.source === "report") {
          // Keep the report's words; take the screen's numbering, question line and details when they line up.
          if (ask.options.length && parsed.options.length >= ask.options.length && ask.options.every((o, i) => parsed.options[i].label.startsWith(o.label.slice(0, 12)))) {
            patch.options = ask.options.map((o, i) => ({ ...o, n: parsed.options[i].n, detail: parsed.options[i].detail }));
          } else if (!ask.options.length && parsed.options.length) {
            patch.options = parsed.options;
          }
          if (parsed.question && ask.kind === "APPROVAL") patch.question = `${parsed.question} ${ask.question}`.trim();
        } else if (parsed.options.length) {
          patch.options = parsed.options; patch.source = "screen"; patch.confidence = 0.7;
          patch.kind = parsed.options.some((o) => /^yes\b/i.test(o.label)) && parsed.options.some((o) => /^no\b/i.test(o.label)) ? "APPROVAL" : "DECISION";
          if (parsed.question) patch.question = parsed.question;
        }
        if (this.config?.classify !== "off" && (this.config?.classify === "always" || (ask.source !== "report" && !patch.options?.length))) {
          const model = await this.classify(text, ask);
          if (model) {
            const seen = model.options.filter((o) => text.includes(o));
            if (seen.length === model.options.length && model.confidence >= 0.6) {
              patch.kind = model.kind; patch.question = model.question || patch.question || ask.question; patch.context = model.context || patch.context;
              if (!patch.options?.length && !ask.options.length) patch.options = model.options.map((label, i) => ({ n: parsed.options[i]?.n ?? i + 1, label, detail: "" }));
              patch.recommended = model.recommended; patch.source = patch.source === "screen" ? "screen+model" : "model"; patch.confidence = model.confidence;
            } else if (ask.source !== "report") { patch.kind = "UNCLEAR"; }
          }
        }
        if (patch.kind !== "UNCLEAR" && !(patch.options?.length ?? ask.options.length) && (patch.kind ?? ask.kind) !== "QUESTION" && ask.source !== "report") patch.kind = "UNCLEAR";
        update((s) => { const a = s.asks.find((x) => x.id === id); if (a) Object.assign(a, patch); });
      } finally { this.enriching.delete(id); cx.notify(); }
    });
  }

  // With `debug: true` in asks.json, one line per step goes to ~/.config/herdr-app/asks.log.
  debug(line) {
    if (!this.config?.debug) return;
    exec("sh", ["-c", 'printf "%s %s\n" "$(date +%H:%M:%S)" "$1" >> "$2"', "asks", String(line).slice(0, 600), `${appHome()}/asks.log`]).catch(() => {});
  }

  // `tabs-asks.recheck`: forget the finished-turn checks for every live agent's current
  // turn, so the next tick reads those turns again (after a rule change, or a miss).
  recheck() {
    const live = terminals().filter((t) => t.state === "live");
    const keys = new Set(live.map((t) => `${t.address}:p:${t.turn ?? 0}`));
    update((s) => {
      s.checked = (s.checked ?? []).filter((k) => !keys.has(k));
      s.asks = s.asks.filter((a) => !(keys.has(a.id) && a.state !== "delivered"));
    });
    this.debug(`recheck ${[...keys].join(" ")}`);
  }

  // Read the finished turn; if it ends asking the person something, make a QUESTION card.
  checkTurn(t, agent, cx) {
    const key = `${t.address}:p:${t.turn ?? 0}`;
    if (this.checking.has(key)) return;
    this.checking.add(key);
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", t.address, "--json", "--lines", "100"]);
        if (r.code !== 0) { this.debug(`${key} read failed: ${r.stderr}`); return; }
        const text = JSON.parse(r.stdout).text ?? "";
        const { message, hasQuestion } = parseLastMessage(text);
        this.debug(`${key} message ${message.length} chars, question=${hasQuestion}`);
        if (!hasQuestion || message.length < 8) return;
        const model = normalize(await this.classify(message, { app: reportOf(t)?.app ?? agent?.app, program: agent?.program, msg: "" }, "message"));
        this.debug(`${key} model: ${JSON.stringify(model)}`);
        if (!model || !model.asks || model.confidence < 0.6) return;
        const now = Date.now();
        const ask = {
          id: key, address: t.address, pane: agent?.pane ?? null, space: agent?.space ?? t.labels?.["herdr.space"] ?? null,
          space_name: agent?.space_name ?? (t.labels?.where ?? "").split(" / ")[0] ?? "",
          agent: agentName(agent, t), program: agent?.program ? { key: agent.program.key, name: agent.program.name, icon: agent.program.icon, tint: agent.program.tint } : null,
          app: reportOf(t)?.app ?? agent?.app ?? null, cwd: t.cwd ?? null, turn: t.turn ?? 0, msg: "",
          detected_at: now, state: "pending", delivery: "send",
          kind: "QUESTION", question: model.question, options: model.options.map((label, i) => ({ n: i + 1, label, detail: "" })), recommended: model.recommended,
          questions: (model.questions ?? []).map((q) => ({ text: q.text, options: q.options.map((label, i) => ({ n: i + 1, label, detail: "" })), recommended: q.recommended })),
          context: model.context, raw: message.slice(-3000), source: "model", confidence: model.confidence, enriched: true,
          answer: null, answered_at: null, error: null, note: null,
        };
        let added = false;
        update((s) => { if (!s.asks.some((a) => a.id === key)) { s.asks.unshift(ask); added = true; } });
        if (added && this.config?.toast && focused()?.terminal !== t.address) notify({ title: `${ask.agent} is asking`, body: ask.question, level: "warning", timeout: 5000, action: { name: "tabs-asks.open" } });
      } catch {}
      finally { this.checking.delete(key); cx.notify(); }
    });
  }

  async classify(text, ask, mode = "dialog") {
    const prompt = mode === "message" ? [
      "A coding agent just finished a turn and printed this message to the person. Decide whether it is waiting on an answer. Return JSON only.",
      "asks: true only if the agent needs the person to decide, confirm or tell it something before it can usefully continue (a real question, a choice, a go-ahead). false for rhetorical questions, offers like 'let me know if you want X', summaries, or finished work.",
      "kind: QUESTION when asks is true, else UNCLEAR.",
      "question: the thing being asked, under 160 characters, in the person's language, no preamble. If the message asks several separate questions, summarise what they are about, e.g. '9 questions before scaffolding: backend, first user, stack…'.",
      "questions: when the message asks several separate questions, one entry per question, in order: text = the question in its own words (no numbering); options = the alternatives the message lists under THAT question, as short labels in its own words, in order, empty if it gives none; recommended = 0-based index of the one the agent says it prefers, else null. Empty array for a single question.",
      "options: alternatives the message offers as answers to ONE question (A or B, yes or no, a list of candidates), as short labels in its own words, in order. A list of questions is never options. Empty if it asks open-endedly or asks several questions. Never invent.",
      "recommended: 0-based index of the option the agent said it prefers, else null.",
      "context: under 120 characters, past tense, what the agent did this turn.",
      "confidence: 0 to 1.",
      `Agent program: ${ask.app ?? ask.program?.name ?? "unknown"}.`,
      "Message:", "```", text.slice(-6000), "```",
    ].join("\n") : [
      "You classify a dialog a coding agent shows a person in its terminal. Return JSON only.",
      "kind: APPROVAL = a permission or confirmation gate; DECISION = enumerated options to choose from; QUESTION = open-ended; UNCLEAR = anything else or no dialog.",
      "question: what is being asked, under 160 characters, in the person's language, no preamble.",
      "options: copied verbatim from the screen, in order, without their numbers. Never invent, merge or reorder. Empty if none.",
      "questions: always empty here.",
      "recommended: 0-based index of an option the agent itself marked recommended, else null.",
      "context: under 120 characters, past tense, what the agent was doing when it stopped.",
      "confidence: 0 to 1.",
      `Agent program: ${ask.app ?? ask.program?.name ?? "unknown"}. Status report: ${JSON.stringify(ask.msg)}.`,
      "Screen (last lines):", "```", text.split("\n").slice(-45).join("\n").slice(-6000), "```",
    ].join("\n");
    try {
      // Skipping the person's MCP servers and settings cuts the CLI's start from ~4 s to ~1 s;
      // the classifier needs neither (it runs no tools).
      const r = await exec("claude", ["-p", "--no-session-persistence", "--model", this.config?.model ?? "haiku", "--output-format", "json", "--json-schema", SCHEMA,
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", prompt]);
      if (r.code !== 0) { this.debug(`claude exit ${r.code}: ${r.stderr} ${r.stdout.slice(0, 200)}`); return null; }
      const out = JSON.parse(r.stdout);
      if (out.is_error) { this.debug(`claude error: ${String(out.result).slice(0, 200)}`); return null; }
      const o = out.structured_output ?? (typeof out.result === "string" ? JSON.parse(out.result) : null);
      return o && Array.isArray(o.options) ? o : null;
    } catch (e) { this.debug(`claude threw: ${e?.message ?? e}`); return null; }
  }
}
