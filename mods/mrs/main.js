// Merge requests: your open GitLab MRs and GitHub PRs, plus GitLab MRs waiting on
// your review. Each row: an icon colored by status, title, "repo !iid", and its state. Click opens it.
// Data: `glab api graphql` and `gh search prs`, every 60s. Shown in the right panel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, run } from "herdr";

const Q = `fragment M on MergeRequest { iid title webUrl draft updatedAt detailedMergeStatus approved conflicts
  project { path } headPipeline { status } author { username } }
query { currentUser {
  authoredMergeRequests(state: opened, first: 30, sort: UPDATED_DESC) { nodes { ...M } }
  reviewRequestedMergeRequests(state: opened, first: 30, sort: UPDATED_DESC) { nodes { ...M } } } }`;

const PIPE = { SUCCESS: "ok", FAILED: "fail", CANCELED: "fail", RUNNING: "run", PENDING: "run", CREATED: "run",
  PREPARING: "run", WAITING_FOR_RESOURCE: "run", MANUAL: "wait", SCHEDULED: "wait" };

export default class Mrs extends View {
  init(_props, cx) {
    this.mine = []; this.review = []; this.err = []; this.loaded = false;
    this.refresh(cx);
    cx.timer.every(60000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      const err = [];
      const [gl, gh] = await Promise.allSettled([
        exec("glab", ["api", "graphql", "-f", `query=${Q}`], { timeout: 20000 }),
        exec("gh", ["search", "prs", "--author", "@me", "--state", "open", "--limit", "30",
          "--json", "number,title,url,repository,isDraft,updatedAt"], { timeout: 20000 }),
      ]);
      let mine = [], review = [];
      try {
        if (gl.status !== "fulfilled" || gl.value.code !== 0) throw new Error(gl.reason ?? gl.value.stderr);
        const u = JSON.parse(gl.value.stdout).data.currentUser;
        const conv = (m) => ({
          id: m.webUrl, url: m.webUrl, title: m.title.replace(/^Draft:\s*/, ""), repo: m.project.path, ref: `!${m.iid}`,
          draft: m.draft, updated: m.updatedAt, pipe: PIPE[m.headPipeline?.status] ?? null, author: m.author?.username,
          state: m.conflicts ? "conflicts" : m.approved ? "approved" : m.detailedMergeStatus === "MERGEABLE" ? "ready" : null,
        });
        mine = u.authoredMergeRequests.nodes.map(conv);
        review = u.reviewRequestedMergeRequests.nodes.map(conv);
      } catch (e) { err.push(`GitLab: ${String(e?.message ?? e).trim().slice(0, 120)}`); }
      try {
        if (gh.status !== "fulfilled" || gh.value.code !== 0) throw new Error(gh.reason ?? gh.value.stderr);
        mine.push(...JSON.parse(gh.value.stdout).map((p) => ({
          id: p.url, url: p.url, title: p.title, repo: p.repository.name, ref: `#${p.number}`,
          draft: p.isDraft, updated: p.updatedAt, pipe: null, state: null })));
      } catch (e) { err.push(`GitHub: ${String(e?.message ?? e).trim().slice(0, 120)}`); }
      mine.sort((a, b) => b.updated.localeCompare(a.updated));
      this.mine = mine; this.review = review; this.err = err; this.loaded = true;
      cx.notify();
    });
  }

  row(m, t, review) {
    // The icon carries the status: blocked first, then in progress, then good to go.
    const color = m.draft ? t.dim
      : m.state === "conflicts" || m.pipe === "fail" ? t.blocked
      : m.pipe === "run" ? t.working
      : m.state === "approved" || m.state === "ready" ? t.ansi2
      : m.pipe === "ok" ? t.accent : t.muted;
    const tag = m.pipe === "fail" ? ["pipeline failed", t.blocked] : m.pipe === "run" ? ["running", t.working] : m.draft ? ["draft", t.dim] : m.state === "conflicts" ? ["conflicts", t.blocked]
      : m.state === "approved" ? ["approved", t.ansi2] : m.state === "ready" ? ["ready", t.accent] : null;
    return h_flex().id(`mr-${m.id}`).gap(10).px(10).py(6).mx(6).rounded(6).items_start().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => exec("open", [m.url]))
      .child(div().pt(2).flex_none().child(svg("mods/mrs/merge.svg").size(15).text_color(color)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13).truncate().text_color(m.draft ? t.muted : t.foreground).child(m.title))
        .child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
          .child(div().truncate().child(`${m.repo} ${m.ref}${m.author && review ? ` · ${m.author}` : ""}`))
          .when(!!tag, (el) => el.child(div().flex_none().text_color(tag[1]).child(tag[0])))));
  }

  render(_cx) {
    const t = theme();
    const count = this.mine.length + this.review.length;
    const header = h_flex().id("mrs-head").h(40).px(20).gap(6).items_center().flex_none()
      .child(div().text_size(13).text_color(t.muted).child("Merge requests"))
      .child(div().flex_1())
      .child(div().text_size(12).text_color(t.dim).child(this.loaded ? String(count) : ""));
    const root = v_flex().size_full().bg(t.surface).child(header);
    const list = v_flex().id("mrs-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8);
    if (!this.loaded) list.child(div().px(16).text_size(12).text_color(t.dim).child("Loading…"));
    for (const e of this.err) list.child(div().px(16).py(2).text_size(11).text_color(t.blocked).child(e));
    if (this.review.length) {
      list.child(div().px(16).pt(4).pb(2).text_size(11).text_color(t.dim).child("WAITING ON YOUR REVIEW"));
      list.children(this.review.map((m) => this.row(m, t, true)));
      if (this.mine.length) list.child(div().px(16).pt(8).pb(2).text_size(11).text_color(t.dim).child("YOURS"));
    }
    list.children(this.mine.map((m) => this.row(m, t)));
    if (this.loaded && !count && !this.err.length) list.child(div().px(16).text_size(12).text_color(t.dim).child("No open merge requests"));
    return root.child(list);
  }
}
