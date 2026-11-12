// Usage: Claude and Codex together, one compact row per limit; each signed-in account's plan limits (5-hour and weekly),
// how much is used, a tick for how much of the window has passed (pace), and when it resets.
// Data: bin/claude-usage (on PATH) (keychain token -> Anthropic usage API), every 5 min.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, home } from "herdr";

const WINDOW = { session: 5 * 3600, five_hour: 5 * 3600 }; // everything else is a week
const WEEK = 7 * 86400;

const left = (s) => s <= 0 ? "now" : s < 3600 ? `${Math.ceil(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h`
  : ((h) => `${Math.floor(h / 24)}d ${h % 24}h`)(Math.round(s / 3600));

export default class Usage extends View {
  init(_props, cx) {
    this.data = null; this.err = null;
    this.refresh(cx);
    cx.timer.every(300000, (cx) => this.refresh(cx));
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

  // A header-style meter: label, short bar with pace tick, percent, reset.
  meter(l, now, t, key) {
    const end = l.resets_at ? Date.parse(l.resets_at) / 1000 : null;
    const span = l.window ?? WINDOW[l.kind] ?? WEEK;
    const pace = end ? Math.min(1, Math.max(0, 1 - (end - now) / span)) : null;
    const used = Math.min(100, l.percent ?? 0) / 100;
    const color = used >= 0.9 ? t.blocked : pace != null && used > pace + 0.05 ? t.working : t.ansi2;
    const name = l.kind === "five_hour" || l.kind === "session" || /^5/.test(l.name) ? "5h" : "wk";
    return h_flex().id(key).w(name === "5h" ? 104 : 140).flex_none().items_center().gap(4).text_size(11).whitespace_nowrap()
      .child(div().text_color(t.dim).child(name))
      .child(div().relative().w(34).h(4).rounded(2).bg(t.raised)
        .child(div().absolute().left(0).top(0).h(4).rounded(2).bg(color).w(`${used * 100}%`))
        .when(pace != null, (el) => el.child(div().absolute().top(-2).h(8).w(1).bg(t.muted).left(`${pace * 100}%`))))
      .child(div().w(28).text_right().text_color(color).child(`${Math.round(used * 100)}%`))
      .child(div().w(42).flex_none().whitespace_nowrap().text_color(t.dim).child(end && name === "wk" ? left(end - now) : ""));
  }

  render(_cx) {
    const t = theme();
    const now = Date.now() / 1000;
    const root = v_flex().size_full().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).px(14).py(10).gap(5).justify_center();
    if (this.err) root.child(div().text_size(11).text_color(t.blocked).child(this.err));
    if (!this.data) return root.child(div().text_size(11).text_color(t.dim).child(this.err ? "" : "Loading…"));
    for (const [id, tool, list] of [["c", "Claude", this.data.accounts], ["x", "Codex", this.data.codex]]) {
      (list ?? []).forEach((a, i) => {
        // main limits only: 5-hour and the first weekly (skip per-model weeklies)
        const five = a.limits.find((l) => /^5|five|session/i.test(l.name + l.kind));
        const week = a.limits.find((l) => l !== five);
        const row = h_flex().id(`${id}-${i}`).items_center().gap(8)
          .child(h_flex().w(96).flex_none().gap(4).text_size(11.5).overflow_hidden().whitespace_nowrap()
            .child(div().text_color(t.muted).child(tool))
            .child(div().font_semibold().text_color(t.foreground).child(a.label)));
        if (a.error) row.child(div().text_size(10.5).text_color(t.working).child(a.error.slice(0, 30)));
        row.child(five ? this.meter(five, now, t, `${id}-${i}-5`) : div().w(104).flex_none());
        if (week) row.child(this.meter(week, now, t, `${id}-${i}-w`));
        root.child(row);
      });
    }
    return root;
  }
}
