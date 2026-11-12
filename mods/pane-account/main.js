// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-account" } } } }
// pane, plus the account badge (agent.account label from bin/agent-run).
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, terminals } from "herdr";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-account/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    // Which account this agent runs on: the agent.account label agent-run puts on its terminal.
    const term = p.terminal && terminals().find((x) => x.address === p.terminal);
    const L = term?.labels ?? {};
    const account = L["agent.account"];
    const num = (k) => (L[k] === undefined || L[k] === "" ? null : Number(L[k]));
    const now = Date.now() / 1000;
    // Green on pace, yellow ahead of pace (used more than the share of the window gone), red at 90%.
    const tone = (pct, reset, span) => {
      const pace = reset ? 100 * Math.max(0, Math.min(1, 1 - (reset - now) / span)) : null;
      return pct >= 90 ? t.blocked : (pace != null ? pct > pace + 5 : pct >= 75) ? t.working : t.ansi2;
    };
    const left = (s) => s <= 0 ? "now" : s < 3600 ? `${Math.ceil(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
    const stat = (id, label, pct, color, title) => div().id(id).flex_none().flex().items_center().gap(4)
      .child(div().text_color(t.dim).child(label))
      .child(div().w(28).h(4).rounded(2).bg(t.raised).child(div().h(4).rounded(2).bg(color).w(`${Math.min(100, pct)}%`)))
      .child(div().text_color(color).child(`${pct}%`))
      .when(Boolean(title), (el) => el.child(div().text_color(t.dim).child(title)));
    const ctx = num("agent.ctx"), h5 = num("agent.5h"), wk = num("agent.wk");
    const facts = [];
    if (ctx != null) facts.push(stat(`ph-ctx-${p.pane}`, "ctx", ctx, ctx >= 80 ? t.blocked : ctx >= 60 ? t.working : t.ansi2));
    if (h5 != null) facts.push(stat(`ph-5h-${p.pane}`, "5h", h5, tone(h5, num("agent.5h_reset"), 5 * 3600), this.hovered ? null : null));
    if (wk != null) facts.push(stat(`ph-wk-${p.pane}`, "wk", wk, tone(wk, num("agent.wk_reset"), 7 * 86400),
      num("agent.wk_reset") ? left(num("agent.wk_reset") - now) : null));
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .when(Boolean(account), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5)
        .bg((account === "Work" ? t.accent : t.done) + "26").text_size(10.5).font_semibold()
        .text_color(account === "Work" ? t.accent : t.done).child(account)))
      .when(Boolean(L["agent.model"]), (el) => el.child(div().flex_none().truncate().max_w(140).text_color(t.muted).child(L["agent.model"])))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(facts.length > 0 && !this.hovered, (el) => el.child(h_flex().flex_none().gap(12).items_center().children(facts)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
