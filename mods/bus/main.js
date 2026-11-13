// Bus: the agent-bus view of the shown space. A space named after an area
// (Routines, Connections, ...) shows that area's lane: its PM, the seats under it,
// and the work waiting on a decision, with Reply / Close / Open terminal.
// Any other space shows every area. Data: `agent-bus snapshot`, polled.
// Areas are started by bin/bus-area; keep their lanes in sync with ~/.agents/bus/projects.json.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, terminals, theme, run, exec, notify, nextCommand, layout, readTextFile, home } from "herdr";

const WAITING = new Set(["question", "blocked", "needs-review", "handoff"]);
// Areas, the repo and the lead identity (replies and closes go out as the lead seat)
// come from ~/.config/herdr-mods/config.json, "areas". Shared with bin/bus-area.
const CONFIG = ".config/herdr-mods/config.json";

const ago = (now, t) => {
  const s = Math.max(0, now - (t ?? now));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const find = (n, id) => !n ? null : n.id === id ? n : (n.children ?? []).reduce((f, c) => f ?? find(c, id), null);

export default class Bus extends View {
  init(_props, cx) {
    this.cfg = { areas: [], repo: null, lead: [], owner: null };
    cx.spawn(async (cx) => {
      try {
        const c = JSON.parse(await readTextFile(`${home()}/${CONFIG}`) ?? "{}").areas ?? {};
        this.repoPath = (c.repo ?? "").replace(/^~/, home()).replace(/\/+$/, "") || null;
        this.cfg = { areas: c.list ?? [], repo: (c.repo ?? "").replace(/\/+$/, "").split("/").pop() || null,
          lead: c.lead_env ?? [], owner: c.lead_owner ?? null };
      } catch (e) { this.err = `config: ${String(e?.message ?? e).slice(0, 120)}`; }
      cx.notify();
    });
    this.snap = null; this.err = null; this.replying = null; this.text = "";
    this.claims = {}; // seat address -> paths it has claimed
    this.all = false;
    try { this.seen = new Set(JSON.parse(localStorage.getItem("seen") ?? "[]")); } catch { this.seen = new Set(); }
    this.input = InputState.new({ placeholder: "Reply, Enter to send" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.reply(cx));
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle" || c === "open") this.toggle(c === "open");
        cx.notify();
      }
    });
  }

  toggle(forceOpen) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    const on = panel && !panel.hidden && body?.active === "bus";
    if (on && !forceOpen) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: "bus" }); run("layout.show", { id: "panel" }); }
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("agent-bus", ["snapshot"], { timeout: 15000 });
        if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
        this.snap = JSON.parse(r.stdout); this.err = null;
        this.alert();
        // Claims aren't in the snapshot: `agent-bus claims` prints "<seat>  <path>" per line for the repo.
        if (this.repoPath) {
          const c = await exec("agent-bus", ["claims"], { cwd: this.repoPath, timeout: 15000 });
          if (c.code === 0) {
            const by = {};
            for (const line of c.stdout.split("\n")) {
              const m = line.trim().match(/^(\S+\/\S+)\s+(\S.*)$/);
              if (m) (by[m[1]] ??= []).push(m[2]);
            }
            this.claims = by;
          }
        }
      } catch (e) { this.err = String(e?.message ?? e).slice(0, 200); }
      cx.notify();
    });
  }

  // A toast for each new item that needs you: sent to @lead, or waiting in an area.
  alert() {
    const fresh = this.items(null).filter((i) => !this.seen.has(i.id));
    if (!fresh.length) return;
    const first = this.seen.size === 0;
    for (const i of fresh) this.seen.add(i.id);
    try { localStorage.setItem("seen", JSON.stringify([...this.seen].slice(-500))); } catch {}
    if (first) return; // don't replay the backlog on first load
    for (const i of fresh.slice(0, 3)) {
      notify({ title: `${this.areaOf(i.lane)?.name ?? i.lane} · ${i.state}`, body: `${this.seatName(i.from)}: ${i.subject}`, level: "info", action: { name: "layout.select", args: { stack: "panel-body", child: "bus" } } });
    }
  }

  // The lanes in an area: the area's lane and every lane nested under it (snapshot
  // `path`); older buses fall back to the projects.json grouping.
  lanesIn(area) {
    const set = new Set([area.lane]);
    for (const l of this.snap?.lanes ?? []) {
      if (l.repo !== this.cfg.repo) continue;
      if ((l.path ?? []).includes(area.lane) || l.project === area.name) set.add(l.lane);
    }
    return set;
  }
  areaOf(lane) { return this.cfg.areas.find((a) => this.lanesIn(a).has(lane)) ?? null; }
  seats() { return (this.snap?.seats ?? []).filter((s) => s.repo === this.cfg.repo); }
  seatName(addr) { return this.snap?.seats?.find((s) => s.addr === addr)?.name ?? addr; }
  pmOf(lane) {
    for (const pms of Object.values(this.snap?.lanepms ?? {})) if (pms[lane]) return pms[lane];
    return null;
  }
  // Open work in an area (lane null: every area plus anything sent to @lead).
  items(lane) {
    const area = lane ? this.cfg.areas.find((a) => a.lane === lane) : null;
    const lanes = area ? this.lanesIn(area) : new Set(this.cfg.areas.flatMap((a) => [...this.lanesIn(a)]));
    return (this.snap?.open ?? []).filter((i) => !i.gone && WAITING.has(i.state) &&
      (lanes.has(i.lane) || (!lane && (i.to === "@lead" || i.owner === this.cfg.owner))))
      .sort((a, b) => b.epoch - a.epoch);
  }

  // The Herdr terminal a seat runs in: a live agent terminal in the seat's folder.
  terminalOf(seat) {
    // Exactly: the terminal whose agent reported this seat's chat (several PMs share one folder).
    const bySession = seat.session && terminals().find((t) => t.state === "live" && t.labels?.["agent.session"] === seat.session);
    if (bySession) return bySession;
    const tool = seat.tool === "codex" ? "codex" : seat.tool === "opencode" ? "opencode" : "claude";
    return terminals().find((t) => t.cwd === seat.cwd && t.state === "live" && String(t.agent ?? t.program ?? "").includes(tool)) ?? null;
  }

  reply(cx) {
    const id = this.replying, text = this.text.trim();
    if (!id || !text) return;
    this.replying = null; this.text = ""; this.input.set_value("");
    cx.spawn(async (cx) => {
      const r = await exec("env", [...this.cfg.lead, "agent-bus", "reply", id, "-m", text, "--keep-open"], { cwd: this.cwd() });
      if (r.code !== 0) notify({ title: "Reply failed", body: (r.stderr || r.stdout).slice(0, 200), level: "error" });
      this.refresh(cx); cx.notify();
    });
    cx.notify();
  }

  close(id, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("env", [...this.cfg.lead, "agent-bus", "resolve", id], { cwd: this.cwd() });
      if (r.code !== 0) notify({ title: "Close failed", body: (r.stderr || r.stdout).slice(0, 200), level: "error" });
      this.refresh(cx);
    });
  }

  startPm(area, cx) {
    const slug = area.slug;
    cx.spawn(async (cx) => {
      const r = await exec("bus-area", ["up", slug]);
      notify({ title: r.code === 0 ? `${area.name} PM starting` : "bus-area failed", body: (r.stdout || r.stderr).trim().slice(0, 200), level: r.code === 0 ? "info" : "error" });
      this.refresh(cx);
    });
  }

  cwd() { return this.snap?.seats?.find((s) => s.repo === this.cfg.repo)?.cwd ?? undefined; }

  render(cx) {
    const t = theme();
    const shown = spaces().find((s) => s.active);
    const here = !this.all && this.cfg.areas.find((a) => a.name.toLowerCase() === (shown?.name ?? "").toLowerCase());
    const body = v_flex().flex_1().overflow_y_scrollbar().id("bus-scroll").gap(14).p(12);

    const header = h_flex().px(12).py(8).justify_between().items_center().border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(here ? `${here.name} · @${here.lane}` : "All areas"))
      .child(div().id("bus-scope").text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.all = !this.all; cx.notify(); }).child(this.all ? "This space" : here ? "All" : ""));

    if (this.err) body.child(div().text_size(12).text_color(t.blocked).child(`agent-bus: ${this.err}`));
    if (!this.snap) return v_flex().size_full().bg(t.surface).child(header).child(body.child(div().text_color(t.dim).text_size(12).child("Loading…")));

    const now = this.snap.now;
    const areas = here ? [here] : this.cfg.areas;

    // Identity problems first: an area that is running (it has a space) but whose PM the bus doesn't know.
    const open = new Set(spaces().map((s) => (s.name ?? "").toLowerCase()));
    const lost = this.cfg.areas.filter((a) => open.has(a.name.toLowerCase()) && !this.pmOf(a.lane));
    if (lost.length) {
      const box = v_flex().gap(6).p(8).rounded(8).border(1).border_color(t.blocked).bg(t.background)
        .child(div().text_size(11).font_semibold().text_color(t.blocked).child("NO PM ON THE BUS"))
        .child(div().text_size(11).text_color(t.muted).child("These areas are running, but messages to their @…-pm role reach no one."));
      for (const a of lost) {
        // Who should hold it: the seat sitting in the area's own lane, or the terminal in its PM tab.
        const seat = this.seats().find((s) => s.lane === a.lane && s.wt === "main");
        const term = (seat && this.terminalOf(seat)) ?? terminals().find((x) => x.state === "live" && x.labels?.where === `${a.name} / PM`);
        box.child(h_flex().id(`lost-${a.lane}`).gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).truncate()
            .child(`${a.name}${seat ? ` · ${seat.name} is in @${a.lane} without the role` : " · its PM isn't on the bus"}`))
          .when(!!term, (el) => el.child(div().id(`fix-${a.lane}`).px(8).py(3).rounded(5).text_size(11).text_color(t.foreground)
            .border(1).border_color(t.input).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.claimPm(a, term, cx)).child("Tell it to take the role"))));
      }
      body.child(box);
    }

    for (const area of areas) {
      const pm = this.pmOf(area.lane);
      const inArea = this.lanesIn(area);
      const seats = this.seats().filter((s) => inArea.has(s.lane));
      const items = this.items(area.lane);
      if (!here && !pm && !seats.length && !items.length) continue;
      const col = v_flex().gap(6);
      if (!here) col.child(h_flex().justify_between()
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(area.name))
        .child(div().text_size(11).text_color(items.length ? t.blocked : t.dim).child(items.length ? `${items.length} waiting` : "")));

      // PM row
      col.child(pm
        ? this.seatRow(this.snap.seats.find((s) => s.addr === pm) ?? { addr: pm, name: pm }, now, t, true)
        : h_flex().id(`pm-${area.lane}`).gap(8).items_center().px(8).py(6).rounded(6).border(1).border_color(t.border).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.startPm(area, cx))
            .child(div().text_size(12).text_color(t.muted).child("No PM · Start PM")));
      // Children
      for (const s of seats.filter((s) => s.addr !== pm)) col.child(this.seatRow(s, now, t, false));
      // Waiting work
      if (here || items.length) {
        col.child(div().pt(6).text_size(11).text_color(t.dim).child(items.length ? "WAITING ON A DECISION" : "Nothing waiting"));
        for (const i of items.slice(0, 20)) col.child(this.itemCard(i, now, t));
      }
      body.child(col);
    }
    const lead = this.items(null).filter((i) => !this.areaOf(i.lane));
    if (!here && lead.length) {
      const col = v_flex().gap(6).child(div().text_size(12).font_semibold().text_color(t.foreground).child("Sent to you"));
      for (const i of lead.slice(0, 20)) col.child(this.itemCard(i, now, t));
      body.child(col);
    }
    return v_flex().size_full().bg(t.surface).child(header).child(body);
  }

  seatRow(s, now, t, isPm) {
    const term = s.cwd ? this.terminalOf(s) : null;
    const color = s.avatar?.color ?? t.accent;
    const claims = this.claims[s.addr] ?? [];
    const where = term?.labels?.where, account = term?.labels?.["agent.account"];
    const meta = [s.tool, account, where].filter(Boolean).join(" · ");
    return h_flex().id(`seat-${s.addr}`).gap(8).items_center().px(8).py(5).rounded(6)
      .when(isPm, (el) => el.bg(t.raised))
      .when(!!term, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => run("pane.focus", { terminal: term.address })))
      .child(div().size(8).rounded(4).flex_none().bg(color))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6)
          .child(div().text_size(12).text_color(t.foreground).child(s.name ?? s.addr))
          .child(div().text_size(11).text_color(isPm ? t.accent : t.dim).child(isPm ? "PM" : s.lane ? `@${s.lane}` : ""))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child(ago(now, s.last_hook))))
        .when(!!s.focus, (el) => el.child(div().text_size(11).text_color(t.muted).truncate().child(s.focus)))
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(meta || s.addr))
        // What it has claimed: files other seats should keep off.
        .when(claims.length > 0, (el) => el.child(v_flex().pt(2)
          .children(claims.slice(0, 4).map((c, i) => div().id(`cl-${s.addr}-${i}`).text_size(10.5).text_color(t.working).truncate()
            .child(`claimed ${c.split("/").slice(-2).join("/")}`)))
          .when(claims.length > 4, (e2) => e2.child(div().text_size(10.5).text_color(t.dim).child(`+${claims.length - 4} more claims`))))));
  }

  // Ask the terminal that should be an area's PM to register itself as one.
  claimPm(area, term, cx) {
    const text = `Identity check from the lead: the bus does not list you as PM of @${area.lane}, so messages to @${area.lane}-pm reach no one. `
      + `Run \`agent-bus whoami\`, then \`agent-bus role pm --lane ${area.lane}\` (your lane must be ${area.lane}; if AGENT_BUS_LANE isn't set, export it first), `
      + "set your focus line, and confirm with `agent-bus who`. Then carry on.";
    cx.spawn(async (cx) => {
      const r = await exec("hc", ["send", term.address, text], { timeout: 30000 });
      notify({ title: r.code === 0 ? `Asked the ${area.name} PM to take its role` : "Couldn't reach it", body: r.code === 0 ? "" : (r.stderr || r.stdout).slice(0, 200), level: r.code === 0 ? "info" : "error" });
      this.refresh(cx);
    });
  }

  itemCard(i, now, t) {
    const open = this.replying === i.id;
    const seat = this.snap.seats.find((s) => s.addr === i.from);
    const term = seat ? this.terminalOf(seat) : null;
    const btn = (id, label, fn) => div().id(id).px(8).py(3).rounded(5).text_size(11).text_color(t.muted)
      .border(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(fn).child(label);
    return v_flex().gap(6).p(8).rounded(8).bg(t.background).border(1).border_color(t.border)
      .child(h_flex().gap(6)
        .child(div().text_size(10).font_semibold().text_color(i.state === "blocked" ? t.blocked : i.state === "question" ? t.working : t.accent).child(i.state.toUpperCase()))
        .child(div().text_size(11).text_color(t.muted).child(this.seatName(i.from)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(ago(now, i.epoch))))
      .child(div().text_size(12).text_color(t.foreground).child(i.subject || "(no subject)"))
      .when(open, (el) => el.child(Input.new(this.input).text_size(12)))
      .child(h_flex().gap(6)
        .child(btn(`r-${i.id}`, open ? "Cancel" : "Reply", (_e, cx) => { this.replying = open ? null : i.id; this.input.set_value(""); this.text = ""; cx.notify(); }))
        .child(btn(`c-${i.id}`, "Close", (_e, cx) => this.close(i.id, cx)))
        .when(!!term, (el) => el.child(btn(`o-${i.id}`, "Open terminal", () => run("pane.focus", { terminal: term.address })))));
  }
}
