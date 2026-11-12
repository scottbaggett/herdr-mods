// Usage: tabs for Claude and Codex; each signed-in account's plan limits (5-hour and weekly),
// how much is used, a tick for how much of the window has passed (pace), and when it resets.
// Data: bin/claude-usage (on PATH) (keychain token -> Anthropic usage API), every 5 min.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, home } from "herdr";

const WINDOW = { session: 5 * 3600, five_hour: 5 * 3600 }; // everything else is a week
const WEEK = 7 * 86400;

const left = (s) => s <= 0 ? "now" : s < 3600 ? `${Math.ceil(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h`
  : `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;

export default class Usage extends View {
  init(_props, cx) {
    this.data = null; this.err = null;
    try { this.tab = localStorage.getItem("tab") ?? "claude"; } catch { this.tab = "claude"; }
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

  bar(l, now, t, key) {
    const end = l.resets_at ? Date.parse(l.resets_at) / 1000 : null;
    const span = l.window ?? WINDOW[l.kind] ?? WEEK;
    const pace = end ? Math.min(1, Math.max(0, 1 - (end - now) / span)) : null; // share of the window gone
    const used = Math.min(100, l.percent ?? 0) / 100;
    const color = used >= 0.9 ? t.blocked : pace != null && used > pace + 0.05 ? t.working : t.ansi2;
    return v_flex().id(key).gap(3)
      .child(h_flex().justify_between().text_size(11.5)
        .child(div().text_color(t.muted).child(l.name))
        .child(h_flex().gap(6)
          .child(div().text_color(t.foreground).child(`${Math.round(used * 100)}%`))
          .when(!!end, (el) => el.child(div().text_color(t.dim).child(`resets ${left(end - now)}`)))))
      .child(div().relative().h(5).w_full().rounded(3).bg(t.raised)
        .child(div().absolute().left(0).top(0).h(5).rounded(3).bg(color).w(`${used * 100}%`))
        .when(pace != null, (el) => el.child(div().absolute().top(-2).h(9).w(1.5).bg(t.foreground).left(`${pace * 100}%`))));
  }

  render(_cx) {
    const t = theme();
    const now = Date.now() / 1000;
    const tabs = [["claude", "Claude"], ["codex", "Codex"]];
    const tabBtn = ([id, label]) => div().id(`tab-${id}`).px(8).py(2).rounded(5).text_size(12).cursor_pointer()
      .bg(this.tab === id ? t.selected : t.chrome).text_color(this.tab === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.tab = id; try { localStorage.setItem("tab", id); } catch {} cx.notify(); })
      .child(label);
    const root = v_flex().size_full().bg(t.chrome).px(20).pt(10).pb(12).gap(12)
      .child(h_flex().items_center().gap(4)
        .child(div().text_size(13).text_color(t.muted).mr(6).child("Usage"))
        .children(tabs.map(tabBtn)));
    if (this.err) root.child(div().text_size(11).text_color(t.blocked).child(this.err));
    if (!this.data) return root.child(div().text_size(12).text_color(t.dim).child(this.err ? "" : "Loading…"));
    for (const a of (this.tab === "codex" ? this.data.codex : this.data.accounts) ?? []) {
      const col = v_flex().gap(7)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(a.label))
          .child(div().text_size(11).text_color(t.dim).child([a.plan, a.email].filter(Boolean).join(" · "))));
      if (a.error) col.child(div().text_size(11).text_color(t.working).child(a.error));
      a.limits.forEach((l, i) => col.child(this.bar(l, now, t, `u-${a.label}-${i}`)));
      if (a.extra) col.child(div().text_size(11).text_color(t.dim).child(`Extra usage $${a.extra.used.toFixed(0)} of $${a.extra.limit.toFixed(0)} this month`));
      root.child(col);
    }
    return root;
  }
}
