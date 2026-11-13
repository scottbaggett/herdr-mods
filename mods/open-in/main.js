// "Open in" menu for a pane's folder: Finder, the editors and terminals you have, the repo's
// web page, and copy path. Opened as a popup by the pane header (mods/pane-account) with
// props { dir, items }. Items come from the header, which builds them from the apps installed
// and the optional "open_in" list in ~/.config/herdr-mods/config.json:
//   "open_in": [{ "name": "Zed", "app": "Zed" }, { "name": "Tower", "cmd": ["gittower", "{dir}"] }]
// An item is { name, app } (macOS `open -a <app> <dir>`), { name, cmd } (argv, "{dir}" replaced),
// { name, web: true } (the git remote's page) or { name, copy: true }.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, theme, exec, closeOverlay, notify } from "herdr";

// git@host:group/repo.git or https://host/group/repo.git -> https://host/group/repo
const webUrl = (remote) => {
  const r = remote.trim().replace(/\.git$/, "");
  const ssh = r.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : /^https?:\/\//.test(r) ? r : null;
};

export default class OpenIn extends View {
  async open(item) {
    const { dir, overlay } = props();
    closeOverlay(overlay);
    let r;
    if (item.copy) r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", dir]);
    else if (item.web) {
      const remote = await exec("git", ["-C", dir, "remote", "get-url", "origin"]);
      const url = remote.code === 0 ? webUrl(remote.stdout) : null;
      if (!url) return notify({ title: "No web page for this folder", body: "It has no git remote named origin.", level: "info" });
      const branch = (await exec("git", ["-C", dir, "branch", "--show-current"])).stdout.trim();
      r = await exec("open", [branch && !/^(main|master|develop)$/.test(branch) ? `${url}/-/tree/${branch}`.replace(/github\.com\/(.+)\/-\/tree/, "github.com/$1/tree") : url]);
    } else if (item.cmd) r = await exec(item.cmd[0], item.cmd.slice(1).map((a) => a.replaceAll("{dir}", dir)));
    else r = await exec("open", item.app === "Finder" ? [dir] : ["-a", item.app, dir]);
    if (r && r.code !== 0) notify({ title: `Couldn't open in ${item.name}`, body: (r.stderr || r.stdout).trim().slice(0, 200), level: "error" });
  }

  render() {
    const t = theme();
    const { items = [], dir = "" } = props() ?? {};
    return v_flex().size_full().p(4).bg(t.popover).text_size(12.5)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(dir.split("/").slice(-2).join("/")))
      .children(items.map((item, i) => div().id(`open-${i}`).px(8).h(26).flex().items_center().rounded(5).cursor_pointer()
        .text_color(t.foreground).hover((s) => s.bg(t.hover))
        .when(Boolean(item.sep), (el) => el.mt(4))
        .on_click(() => { this.open(item); })
        .child(item.name)));
  }
}
