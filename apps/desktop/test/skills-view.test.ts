// The Skill library's skills.sh search and "Removed starter skills" restore, against an
// in-memory daemon.
import { describe, expect, it } from "vitest";
import type { InstalledSkill, ScanReport, SkillSearchResult } from "@oneseat/contracts";
import { Api } from "../src/api";
import { Store } from "../src/store";
import { ShellError, type Transport } from "../src/transport";
import type { Ctx, Route } from "../src/views/context";
import { formatInstalls, isUpgradeError, searchSource, searchSummary, skillsView } from "../src/views/skills";

const scan = (skill: string, verdict: ScanReport["verdict"] = "pass"): ScanReport => ({
  skill,
  verdict,
  summary: `${skill} summary`,
  findings: [],
  declared: { net: [], read: [], write: [], env: [], run: [] },
  observed: { net: [], read: [], write: [], env: [], run: [] },
  filesRead: 1,
  bytesRead: 1,
});

const installed = (name: string): InstalledSkill =>
  ({
    manifest: { frontmatter: { name, description: `${name} does things.` }, permissions: { net: [], read: [], write: [], env: [], run: [] }, effects: [] },
    source: { kind: "local", path: `/skills/${name}` },
    version: "1.0.0",
    installedAt: "2026-11-01T09:00:00.000Z",
  }) as unknown as InstalledSkill;

const RESULTS: SkillSearchResult[] = [
  { id: "acme/skills/invoice-chase", repo: "acme/skills", skill: "invoice-chase", name: "invoice-chase", installs: 2258, installed: false },
  { id: "acme/skills/weekly-report", repo: "acme/skills", skill: "weekly-report", name: "weekly-report", installs: 1, installed: true },
];

function setup(opts: { free?: boolean; searchFails?: boolean; restoreFails?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const skills = new Map<string, InstalledSkill>([["weekly-report", installed("weekly-report")]]);
  const starters = new Map([
    ["weekly-report", "Write the weekly report."],
    ["social-posts", "Plan and draft social posts."],
  ]);
  const daemon: Record<string, (p: Record<string, unknown>) => unknown> = {
    "skills.list": () => ({ skills: [...skills.values()] }),
    "skills.restorable": () => ({ skills: [...starters].filter(([n]) => !skills.has(n)).map(([name, description]) => ({ name, description })) }),
    "skills.restore": (p) => {
      const name = p["name"] as string;
      if (opts.restoreFails) return { installed: false, scan: scan(name, "block"), lint: { skill: name, ok: true, issues: [] }, reason: "blocked by the security scan" };
      skills.set(name, installed(name));
      return { installed: true, skill: skills.get(name), scan: scan(name), lint: { skill: name, ok: true, issues: [] } };
    },
    "skills.remove": (p) => ({ ok: skills.delete(p["name"] as string) }),
    "skills.search": (p) => {
      if (opts.searchFails) throw new ShellError("could not reach skills.sh: getaddrinfo ENOTFOUND", -32603);
      return { results: String(p["query"]).includes("zzz") ? [] : RESULTS };
    },
    "skills.inspect": (p) => {
      const name = String(p["source"]).split("@")[1] ?? "x";
      return { scan: scan(name, name.includes("warn") ? "warn" : "pass"), lint: { skill: name, ok: true, issues: [] } };
    },
    "skills.install": (p) => {
      if (opts.free) throw new ShellError("Import skills from GitHub and skills.sh is part of OneSeat Pro and Team. Add a license key under Plan, or see the plans at the OneSeat website.", -32003, { feature: "import_skills" });
      const name = String(p["source"]).split("@")[1]!;
      skills.set(name, installed(name));
      return { installed: true, skill: skills.get(name), scan: scan(name), lint: { skill: name, ok: true, issues: [] } };
    },
    "license.status": () => ({ tier: opts.free ? "free" : "pro", status: opts.free ? "none" : "active", features: opts.free ? [] : ["import_skills"], computers: 1 }),
  };
  const transport: Transport = {
    kind: "memory",
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      const method = args!["method"] as string;
      const params = (args!["params"] ?? {}) as Record<string, unknown>;
      calls.push({ method, params });
      return daemon[method]!(params) as T;
    },
    async listen() {
      return () => {};
    },
    close() {},
  };
  const notes: string[] = [];
  const routes: Route[] = [];
  const ctx: Ctx = {
    api: new Api(transport),
    store: new Store(),
    navigate: (r) => routes.push(r),
    notify: (m) => notes.push(m),
    reviewApproval: () => {},
  };
  const view = skillsView(ctx);
  document.body.replaceChildren(view.el);
  return { view, el: view.el, calls, notes, routes, skills };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const byLabel = (el: HTMLElement, label: string) => el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
const search = async (el: HTMLElement, q: string) => {
  (el.querySelector('input[name="query"]') as HTMLInputElement).value = q;
  el.querySelector('form[role="search"]')!.dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
};
const restoreCard = (el: HTMLElement) => el.querySelector('[aria-labelledby="restore-title"]') as HTMLElement;

describe("skills view helpers", () => {
  it("formats installs, summaries and sources", () => {
    expect(formatInstalls(2258)).toBe("2,258 installs");
    expect(formatInstalls(1)).toBe("1 install");
    expect(formatInstalls(Number.NaN)).toBe("0 installs");
    expect(searchSummary("x", 0)).toBe("Nothing on skills.sh matches “x”. Try a shorter or different word.");
    expect(searchSummary("x", 1)).toBe("1 skill found on skills.sh.");
    expect(searchSummary("x", 3)).toBe("3 skills found on skills.sh.");
    expect(searchSource({ repo: "o/r", skill: "s" })).toBe("o/r@s");
    expect(isUpgradeError(new ShellError("x", -32003))).toBe(true);
    expect(isUpgradeError(new ShellError("x", -32004))).toBe(false);
    expect(isUpgradeError(new Error("x"))).toBe(false);
  });
});

describe("skills view: removed starter skills", () => {
  it("shows the section only when something is restorable, and restores", async () => {
    const t = setup();
    t.view.show();
    await settle();
    expect(restoreCard(t.el).hidden).toBe(false);
    expect(t.el.querySelector('[data-restorable="social-posts"]')?.textContent).toContain("Plan and draft social posts.");
    byLabel(t.el, "Restore social-posts").click();
    await settle();
    expect(t.calls.find((c) => c.method === "skills.restore")?.params).toEqual({ name: "social-posts" });
    expect(t.notes).toContain("Restored social-posts.");
    expect(restoreCard(t.el).hidden).toBe(true);
    expect(t.el.querySelector('[data-skill="social-posts"]')).not.toBeNull();
  });

  it("removing a starter skill offers it for restore", async () => {
    const t = setup();
    t.skills.set("social-posts", installed("social-posts"));
    t.view.show();
    await settle();
    expect(restoreCard(t.el).hidden).toBe(true);
    const card = t.el.querySelector('[data-skill="weekly-report"]')!;
    (card.querySelector("button") as HTMLButtonElement).click();
    (card.querySelector("button.danger") as HTMLButtonElement).click();
    await settle();
    expect(restoreCard(t.el).hidden).toBe(false);
    expect(t.el.querySelector('[data-restorable="weekly-report"]')).not.toBeNull();
  });

  it("says why a restore did not happen", async () => {
    const t = setup({ restoreFails: true });
    t.view.show();
    await settle();
    byLabel(t.el, "Restore social-posts").click();
    await settle();
    expect(restoreCard(t.el).textContent).toContain("Could not restore social-posts: blocked by the security scan");
    expect(byLabel(t.el, "Restore social-posts").disabled).toBe(false);
  });
});

describe("skills view: skills.sh search", () => {
  it("lists results with repo, installs and an Installed badge", async () => {
    const t = setup();
    t.view.show();
    await settle();
    await search(t.el, "invoice");
    const items = t.el.querySelectorAll(".search-result");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("acme/skills · 2,258 installs");
    expect(items[1]!.textContent).toContain("Installed");
    expect(byLabel(t.el, "Install weekly-report from skills.sh")).toBeNull();
    expect(t.el.textContent).toContain("2 skills found on skills.sh.");
    await search(t.el, "zzz");
    expect(t.el.textContent).toContain("Nothing on skills.sh matches “zzz”.");
    await search(t.el, "   ");
    expect(t.el.textContent).toContain("Type what the skill should help with");
  });

  it("explains a failed search in plain words", async () => {
    const t = setup({ searchFails: true });
    await search(t.el, "invoice");
    expect(t.el.textContent).toContain("Could not search skills.sh: could not reach skills.sh: getaddrinfo ENOTFOUND. Check the internet connection and try again.");
  });

  it("Inspect shows the report; Install checks first, then installs a clean pass", async () => {
    const t = setup();
    t.view.show();
    await settle();
    await search(t.el, "invoice");
    byLabel(t.el, "Inspect invoice-chase from skills.sh").click();
    await settle();
    expect((t.el.querySelector('input[name="source"]') as HTMLInputElement).value).toBe("acme/skills@invoice-chase");
    expect(t.el.querySelector('[data-verdict="pass"]')).not.toBeNull();
    expect(t.calls.some((c) => c.method === "skills.install")).toBe(false);

    byLabel(t.el, "Install invoice-chase from skills.sh").click();
    await settle();
    const methods = t.calls.map((c) => c.method);
    expect(methods.lastIndexOf("skills.inspect")).toBeLessThan(methods.lastIndexOf("skills.install"));
    expect(t.calls.find((c) => c.method === "skills.install")?.params).toEqual({ source: "acme/skills@invoice-chase", allowWarnings: false });
    expect(t.notes).toContain("Installed invoice-chase.");
    // The result now shows as installed.
    expect(t.el.querySelector('[data-result="acme/skills/invoice-chase"]')?.textContent).toContain("Installed");
  });

  it("on Free, says importing needs Pro or Team and shows the daemon's upgrade message", async () => {
    const t = setup({ free: true });
    t.view.show();
    await settle();
    const note = t.el.querySelector(".plan-note") as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("Installing a skill from skills.sh needs OneSeat Pro or Team.");
    await search(t.el, "invoice");
    byLabel(t.el, "Install invoice-chase from skills.sh").click();
    await settle();
    const upgrade = t.el.querySelector("[data-upgrade]") as HTMLElement;
    expect(upgrade.hidden).toBe(false);
    expect(upgrade.textContent).toContain("is part of OneSeat Pro and Team");
    (upgrade.querySelector("button") as HTMLButtonElement).click();
    expect(t.routes).toEqual(["plan"]);
    (note.querySelector("button") as HTMLButtonElement).click();
    expect(t.routes).toEqual(["plan", "plan"]);
  });

  it("on a paid plan the plan note stays hidden", async () => {
    const t = setup();
    t.view.show();
    await settle();
    expect((t.el.querySelector(".plan-note") as HTMLElement).hidden).toBe(true);
  });
});
