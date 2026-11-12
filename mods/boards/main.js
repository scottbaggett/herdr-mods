// Boards: the Salt design boards the focused chat is working with. A board shows when its board.json
// names the chat (agent.session), the chat mentions it, it is linked to the chat's ticket, or it was
// made in the chat's worktree since the chat began. Click opens its review link; "local" opens the build.
// Data: bin/herdr-boards, for the focused terminal (its cwd and agent.session / agent.transcript labels).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, focused, terminals } from "herdr";

const WHY = { chat: "made in this chat", mentioned: "mentioned", ticket: "on this ticket", "made here": "made in this worktree" };
const ago = (s) => { const d = Date.now() / 1000 - s; return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`; };

export default class Boards extends View {
  init(_props, cx) {
    this.key = null; this.data = null; this.err = null; this.target = null;
    cx.timer.every(2000, (cx) => this.check(cx));
    cx.timer.every(30000, (cx) => this.refresh(cx));
    this.check(cx);
  }

  // Follow the focused terminal; keep the last one while focus is elsewhere (on this panel, say).
  check(cx) {
    const f = focused();
    if (!f?.terminal) return;
    const term = terminals().find((x) => x.address === f.terminal);
    const L = term?.labels ?? {};
    const target = { terminal: f.terminal, cwd: f.cwd, session: L["agent.session"], transcript: L["agent.transcript"] };
    const key = JSON.stringify(target);
    if (key === this.key) return;
    this.key = key; this.target = target; this.data = null;
    this.refresh(cx);
  }

  refresh(cx) {
    const t = this.target;
    if (!t?.cwd) return;
    const key = this.key;
    cx.spawn(async (cx) => {
      const args = ["--cwd", t.cwd];
      if (t.session) args.push("--session", t.session);
      if (t.transcript) args.push("--transcript", t.transcript);
      try {
        const r = await exec("herdr-boards", args, { timeout: 20000 });
        if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
        if (key === this.key) { this.data = JSON.parse(r.stdout); this.err = null; }
      } catch (e) { this.err = String(e?.message ?? e).slice(0, 160); }
      cx.notify();
    });
  }

  row(b, t) {
    const strong = b.why[0] === "chat" || b.why[0] === "mentioned";
    return h_flex().id(`b-${b.slug}`).px(14).py(7).gap(10).items_start().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => exec("open", [b.url]))
      .child(div().pt(2).flex_none().child(svg("mods/boards/board.svg").size(15).text_color(strong ? t.accent : t.dim)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13).truncate().text_color(t.foreground).child(b.title))
        .when(!!b.description, (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(b.description)))
        .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
          .child(div().truncate().child(`${WHY[b.why[0]]} · ${ago(b.updated)}`))
          .when(!!b.local, (el) => el.child(div().id(`local-${b.slug}`).flex_none().text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [b.local]); }).child("local")))));
  }

  render(_cx) {
    const t = theme();
    const boards = this.data?.boards ?? [];
    const header = h_flex().h(40).px(16).gap(6).items_center().flex_none()
      .child(div().text_size(13).text_color(t.muted).child("Boards"))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.dim).child(this.data?.ticket ?? ""));
    const list = v_flex().id("boards-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8);
    if (this.err) list.child(div().px(16).py(2).text_size(11).text_color(t.blocked).child(this.err));
    if (!this.target) list.child(div().px(16).text_size(12).text_color(t.dim).child("Focus a chat to see its boards"));
    else if (!this.data && !this.err) list.child(div().px(16).text_size(12).text_color(t.dim).child("Loading…"));
    else if (this.data && !boards.length) list.child(div().px(16).text_size(12).text_color(t.dim).child("No boards for this chat"));
    list.children(boards.map((b) => this.row(b, t)));
    return v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .child(header).child(list);
  }
}
