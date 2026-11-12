// Usage: every Claude and Codex account in one panel. Per account: each plan limit (5-hour, weekly,
// per-model weekly) as a bar with a tick for how much of the window has passed (pace), the time left
// and the clock time it resets; pay-as-you-go credits; and how many agents are running on it now.
// Data: bin/claude-usage (on PATH) every 5 min; agent counts from the pane-header labels.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, terminals } from "herdr";

const WEEK = 7 * 86400;

const left = (s) => s <= 0 ? "now" : s < 3600 ? `${Math.ceil(s / 60)}m`
  : s < 6 * 3600 ? ((m) => `${Math.floor(m / 60)}h ${m % 60}m`)(Math.ceil(s / 60)) : s < 86400 ? `${Math.round(s / 3600)}h`
  : ((h) => `${Math.floor(h / 24)}d ${h % 24}h`)(Math.round(s / 3600));

// When a limit resets, as a clock time: "5:40pm" today, "Tue 11pm" further out.
const clock = (end, now) => {
  const d = new Date(Math.round(end / 60) * 60000), h = d.getHours(), m = d.getMinutes(); // 3:59:59 reads as 4
  const time = `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  const sameDay = new Date(now * 1000).toDateString() === d.toDateString();
  return sameDay ? time : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${time}`;
};

const money = (v) => `$${Math.round(v).toLocaleString("en-US")}`;

export default class Usage extends View {
  init(_props, cx) {
    this.data = null; this.err = null;
    this.refresh(cx);
    cx.timer.every(300000, (cx) => this.refresh(cx));
    cx.timer.every(30000, (cx) => cx.notify()); // keep the countdowns moving
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("claude-usage", [], { timeout: 40000 });
        if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
        this.data = JSON.parse(r.stdout); this.err = null;
      } catch (e) { this.err = String(e?.message ?? e).slice(0, 160); }
      cx.notify();
    });
  }

  // One row: name, full-width bar with an optional pace tick, then the figures on the right.
  bar(name, used, pace, color, right, t, key) {
    return h_flex().id(key).items_center().gap(8).text_size(11)
      .child(div().w(44).flex_none().text_color(t.muted).child(name))
      .child(div().relative().flex_1().h(5).rounded(3).bg(t.raised)
        .child(div().absolute().left(0).top(0).h(5).rounded(3).bg(color).w(`${Math.min(1, used) * 100}%`))
        .when(pace != null, (el) => el.child(div().absolute().top(-2).h(9).w(1.5).bg(t.foreground).left(`${pace * 100}%`))))
      .child(right);
  }

  figures(pct, color, a, b, t) {
    return h_flex().w(148).flex_none().gap(6).items_center()
      .child(div().w(32).flex_none().text_right().text_color(color).child(pct))
      .child(div().flex_none().text_color(t.foreground).child(a))
      .child(div().truncate().text_color(t.dim).child(b));
  }

  limit(l, now, t, key) {
    const end = l.resets_at ? Date.parse(l.resets_at) / 1000 : null;
    const five = l.kind === "session" || l.kind === "five_hour" || /^5/.test(l.name);
    const span = l.window ?? (five ? 5 * 3600 : WEEK);
    const pace = end ? Math.min(1, Math.max(0, 1 - (end - now) / span)) : null;
    const used = Math.min(100, l.percent ?? 0) / 100;
    const color = used >= 0.9 ? t.blocked : pace != null && used > pace + 0.05 ? t.working : t.ansi2;
    const name = five ? "5 hour" : l.name.includes("·") ? l.name.split("·")[1].trim() : "Week";
    return this.bar(name, used, pace, color,
      this.figures(`${Math.round(used * 100)}%`, color, end ? left(end - now) : "", end ? `· ${clock(end, now)}` : "", t), t, key);
  }

  render(_cx) {
    const t = theme();
    const now = Date.now() / 1000;
    const root = v_flex().id("usage").size_full().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .px(14).py(10).gap(11).overflow_y_scrollbar();
    if (this.err) root.child(div().text_size(11).text_color(t.blocked).child(this.err));
    if (!this.data) return root.child(div().text_size(11).text_color(t.dim).child(this.err ? "" : "Loading…"));
    // Agents running on each account right now.
    const on = {};
    for (const x of terminals()) {
      const L = x.labels ?? {};
      if (!L["agent.account"] || !L["agent.model"]) continue;
      const k = `${/opus|sonnet|haiku|fable|claude/i.test(L["agent.model"]) ? "c" : "x"}:${L["agent.account"]}`;
      on[k] = (on[k] ?? 0) + 1;
    }
    for (const [id, tool, list] of [["c", "Claude", this.data.accounts], ["x", "Codex", this.data.codex]]) {
      (list ?? []).forEach((a, i) => {
        const n = on[`${id}:${a.label}`] ?? 0;
        const col = v_flex().gap(4)
          .child(h_flex().gap(5).items_center().text_size(12)
            .child(div().text_color(t.muted).child(tool))
            .child(div().font_semibold().text_color(t.foreground).child(a.label))
            .child(div().text_size(10.5).text_color(t.dim).child(a.plan ?? ""))
            .child(div().flex_1())
            .child(div().text_size(10.5).text_color(n ? t.muted : t.dim).child(n ? `${n} agent${n > 1 ? "s" : ""}` : "no agents")));
        if (a.error) col.child(div().text_size(10.5).text_color(t.working).child(a.error));
        a.limits.forEach((l, j) => col.child(this.limit(l, now, t, `${id}-${i}-${j}`)));
        if (a.extra) {
          const u = a.extra.used / a.extra.limit;
          col.child(this.bar("Credits", u, null, u >= 0.9 ? t.blocked : t.accent,
            this.figures(`${Math.round(u * 100)}%`, t.foreground, money(a.extra.used), `of ${money(a.extra.limit)}`, t), t, `${id}-${i}-credits`));
        }
        root.child(col);
      });
    }
    return root;
  }
}
