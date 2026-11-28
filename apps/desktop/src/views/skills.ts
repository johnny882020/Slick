// Skill library: search skills.sh, add (inspect first, then install on confirm), installed
// skills with remove, and removed starter skills with restore.

import type { InstalledSkill, LintReport, RestorableSkill, ScanReport, SkillPermissions, SkillSearchResult } from "@oneseat/contracts";
import { parseSkillSource, RPC_ERRORS } from "@oneseat/contracts";
import { describeError } from "../api";
import { ShellError } from "../transport";
import { button, field, h, replace, uid } from "../dom";
import { describeSource, formatTime } from "../format";
import type { Ctx, View } from "./context";

export const VERDICT_LABEL: Record<ScanReport["verdict"], string> = {
  pass: "Passed the security check",
  warn: "Passed with warnings",
  block: "Blocked by the security check",
};

/** Plain list of what a skill may touch, e.g. "internet: api.example.com". */
export function describePermissions(p: SkillPermissions): string[] {
  const out: string[] = [];
  if (p.net.length) out.push(`Internet: ${p.net.join(", ")}`);
  if (p.read.length) out.push(`Reads files: ${p.read.join(", ")}`);
  if (p.write.length) out.push(`Writes files: ${p.write.join(", ")}`);
  if (p.env.length) out.push(`Settings it reads: ${p.env.join(", ")}`);
  if (p.run.length) out.push(`Programs it starts: ${p.run.join(", ")}`);
  return out;
}

/** What the install button should do for a scan verdict. */
export function installPolicy(scan: ScanReport): { allowed: boolean; needsConfirm: boolean; reason?: string } {
  if (scan.verdict === "block") return { allowed: false, needsConfirm: false, reason: "Blocked skills cannot be installed." };
  if (scan.verdict === "warn") return { allowed: true, needsConfirm: true };
  return { allowed: true, needsConfirm: false };
}

/** Kind of source, for a hint under the field. */
export function describeInput(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const s = parseSkillSource(t);
  if (s.kind === "local") return `A folder on this computer: ${s.path}`;
  return `From ${describeSource(s)}`;
}

/** The source text skills.inspect / skills.install take for a search result: "owner/repo@skill". */
export function searchSource(r: Pick<SkillSearchResult, "repo" | "skill">): string {
  return `${r.repo}@${r.skill}`;
}

/** "2,258 installs", "1 install". */
export function formatInstalls(n: number): string {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return `${new Intl.NumberFormat("en").format(count)} install${count === 1 ? "" : "s"}`;
}

/** The status line after a search. */
export function searchSummary(query: string, count: number): string {
  if (count === 0) return `Nothing on skills.sh matches “${query}”. Try a shorter or different word.`;
  return count === 1 ? "1 skill found on skills.sh." : `${count} skills found on skills.sh.`;
}

/** True for the daemon's "needs Pro or Team" error. */
export function isUpgradeError(e: unknown): boolean {
  return e instanceof ShellError && e.code === RPC_ERRORS.upgradeRequired;
}

function confirmInline(target: HTMLButtonElement, label: string, onConfirm: () => void): void {
  const parent = target.parentElement!;
  const yes = button(label, () => onConfirm(), { kind: "danger" });
  const no = button("Keep", () => {
    yes.remove();
    no.remove();
    target.hidden = false;
    target.focus();
  });
  target.hidden = true;
  parent.append(yes, no);
  yes.focus();
}

export function skillsView(ctx: Ctx): View {
  const { api } = ctx;
  const list = h("div", { class: "skill-list" });
  const listStatus = h("p", { class: "status", attrs: { role: "status" } });

  const source = h("input", { type: "text", name: "source", autocomplete: "off", spellcheck: false, placeholder: "owner/repo, https://github.com/owner/repo, or a folder path" });
  const sourceField = field("Where is the skill?", source, "A folder path, a GitHub URL, or a skills.sh name like owner/repo.");
  const sourceHint = sourceField.querySelector(".hint")!;
  source.addEventListener("input", () => {
    sourceHint.textContent = describeInput(source.value) || "A folder path, a GitHub URL, or a skills.sh name like owner/repo.";
  });
  const checkBtn = h("button", { type: "submit", class: "btn primary", text: "Check skill" });
  const addStatus = h("p", { class: "status", attrs: { role: "status" } });
  const report = h("div", { class: "inspect", attrs: { "aria-live": "polite" } });
  const upgrade = h("div", { class: "notice", hidden: true, attrs: { "data-upgrade": "" } });

  // ---- Search skills.sh
  const query = h("input", { type: "search", name: "query", autocomplete: "off", spellcheck: false, placeholder: "invoices, social posts, support…", maxLength: 200 });
  const searchBtn = h("button", { type: "submit", class: "btn primary", text: "Search" });
  const searchStatus = h("p", { class: "status", attrs: { role: "status" } });
  const results = h("ul", { class: "search-results", attrs: { "aria-label": "Search results" } });
  const planNote = h(
    "p",
    { class: "notice plan-note", hidden: true },
    "Searching is free. Installing a skill from skills.sh needs OneSeat Pro or Team. ",
    button("See plans", () => ctx.navigate("plan"), { kind: "ghost" }),
  );
  let lastResults: SkillSearchResult[] = [];
  let installedNames: Set<string> | undefined;

  const searchForm = h(
    "form",
    {
      class: "card stack",
      attrs: { role: "search", "aria-labelledby": "search-skills-title" },
      on: {
        submit: (e) => {
          e.preventDefault();
          void onSearch();
        },
      },
    },
    h("h2", { id: "search-skills-title", text: "Find skills on skills.sh" }),
    h("p", { class: "muted", text: "Search the public skills.sh directory. OneSeat checks a skill before it is installed." }),
    h("div", { class: "row" }, field("Search skills.sh", query), searchBtn),
    planNote,
    searchStatus,
    results,
  );

  // ---- Removed starter skills
  const restoreList = h("div", { class: "skill-list" });
  const restoreStatus = h("p", { class: "status", attrs: { role: "status" } });
  const restoreCard = h(
    "section",
    { class: "card", hidden: true, attrs: { "aria-labelledby": "restore-title" } },
    h("h2", { id: "restore-title", text: "Removed starter skills" }),
    h("p", { class: "muted", text: "These came with OneSeat. Put one back at any time." }),
    restoreStatus,
    restoreList,
  );

  const addForm = h(
    "form",
    {
      class: "card stack",
      attrs: { "aria-labelledby": "add-skill-title" },
      on: {
        submit: (e) => {
          e.preventDefault();
          void onInspect();
        },
      },
    },
    h("h2", { id: "add-skill-title", text: "Add a skill" }),
    h("p", { class: "muted", text: "OneSeat checks every skill before it is installed and tells you in plain words what it can do." }),
    sourceField,
    h("div", { class: "row" }, checkBtn),
    addStatus,
    upgrade,
    report,
  );

  const el = h(
    "section",
    { class: "view view-skills", attrs: { "aria-labelledby": "skills-title" } },
    h("h1", { id: "skills-title", text: "Skill library" }),
    searchForm,
    addForm,
    h("section", { class: "card", attrs: { "aria-labelledby": "installed-title" } }, h("h2", { id: "installed-title", text: "Installed skills" }), listStatus, list),
    restoreCard,
  );

  async function onSearch(): Promise<void> {
    const q = query.value.trim();
    if (!q) {
      searchStatus.textContent = "Type what the skill should help with, like “invoices”.";
      query.focus();
      return;
    }
    searchBtn.disabled = true;
    searchStatus.textContent = "Searching skills.sh…";
    replace(results);
    try {
      const r = await api.call("skills.search", { query: q });
      lastResults = r.results;
      searchStatus.textContent = searchSummary(q, r.results.length);
      renderResults();
    } catch (e) {
      lastResults = [];
      searchStatus.textContent = `Could not search skills.sh: ${describeError(e)}. Check the internet connection and try again.`;
    } finally {
      searchBtn.disabled = false;
    }
  }

  function renderResults(): void {
    replace(results, ...lastResults.map(resultItem));
  }

  function resultItem(r: SkillSearchResult): HTMLElement {
    const installed = installedNames ? installedNames.has(r.skill) : r.installed;
    const src = searchSource(r);
    return h(
      "li",
      { class: "search-result", attrs: { "data-result": r.id } },
      h(
        "div",
        { class: "grow" },
        h("h3", null, h("span", { attrs: { dir: "auto" }, text: r.name }), installed ? h("span", { class: "badge pass", text: "Installed" }) : null),
        h("p", { class: "muted" }, h("span", { attrs: { dir: "auto" }, text: r.repo }), ` · ${formatInstalls(r.installs)}`),
      ),
      h(
        "div",
        { class: "row" },
        button("Inspect", () => void onInspect(src), { ariaLabel: `Inspect ${r.skill} from skills.sh` }),
        installed ? null : button("Install", () => void onInspect(src, { install: true }), { kind: "primary", ariaLabel: `Install ${r.skill} from skills.sh` }),
      ),
    );
  }

  /**
   * Check a skill and show the report. From a search result, the source fills the field;
   * with `install`, a skill that passes cleanly installs right after the report is shown
   * (warnings still wait for the person's confirmation, a block never installs).
   */
  async function onInspect(fromSearch?: string, opts: { install?: boolean } = {}): Promise<void> {
    if (fromSearch !== undefined) {
      source.value = fromSearch;
      sourceHint.textContent = describeInput(fromSearch);
      addForm.scrollIntoView?.({ block: "start" });
    }
    const text = source.value.trim();
    if (!text) {
      addStatus.textContent = "Enter where the skill is.";
      source.focus();
      return;
    }
    checkBtn.disabled = true;
    replace(report);
    upgrade.hidden = true;
    addStatus.textContent = "Checking the skill…";
    try {
      const r = await api.call("skills.inspect", { source: text });
      addStatus.textContent = "";
      renderReport(text, r.scan, r.lint);
      const policy = installPolicy(r.scan);
      if (opts.install && policy.allowed && !policy.needsConfirm && r.lint.ok) await onInstall(text, r.scan, false);
    } catch (e) {
      addStatus.textContent = `Could not check the skill: ${describeError(e)}`;
    } finally {
      checkBtn.disabled = false;
    }
  }

  function renderReport(text: string, scan: ScanReport, lint: LintReport): void {
    const policy = installPolicy(scan);
    const confirmId = uid("confirm");
    const confirm = policy.needsConfirm ? h("input", { type: "checkbox", id: confirmId }) : null;
    const install = button(`Install ${scan.skill}`, () => void onInstall(text, scan, !!confirm?.checked), { kind: "primary", disabled: !policy.allowed || policy.needsConfirm });
    confirm?.addEventListener("change", () => (install.disabled = !confirm.checked));
    const cancel = button("Cancel", () => {
      replace(report);
      source.focus();
    });
    const findings = scan.findings.filter((f) => f.severity !== "info");
    const infos = scan.findings.filter((f) => f.severity === "info");
    const perms = describePermissions(scan.declared);
    replace(
      report,
      h(
        "div",
        { class: `scan verdict-${scan.verdict}`, attrs: { "data-verdict": scan.verdict } },
        h("h3", null, h("span", { class: `badge ${scan.verdict}`, text: VERDICT_LABEL[scan.verdict] }), " ", scan.skill),
        h("p", { class: "scan-summary", attrs: { dir: "auto" }, text: scan.summary }),
        perms.length ? h("ul", { class: "perms", attrs: { "aria-label": "What it can touch" } }, ...perms.map((p) => h("li", { text: p }))) : h("p", { class: "muted", text: "It asks for no internet, file or program access." }),
        findings.length
          ? h(
              "div",
              null,
              h("h4", { text: "Findings" }),
              h(
                "ul",
                { class: "findings" },
                ...findings.map((f) =>
                  h("li", { class: `finding ${f.severity}` }, h("span", { class: `badge ${f.severity}`, text: f.severity === "block" ? "Blocks install" : "Warning" }), ` ${f.message} `, h("span", { class: "muted", text: `(${f.file}${f.line ? `:${f.line}` : ""}, ${f.rule})` })),
                ),
              ),
            )
          : null,
        infos.length ? h("ul", { class: "muted" }, ...infos.map((f) => h("li", { text: f.message }))) : null,
        lint.issues.length
          ? h(
              "div",
              null,
              h("h4", { text: "Format check" }),
              h("ul", { class: "lint" }, ...lint.issues.map((i) => h("li", { class: `lint ${i.severity}`, text: `${i.severity === "error" ? "Error" : "Warning"}: ${i.message}` }))),
            )
          : h("p", { class: "muted", text: "Format check: no issues." }),
        policy.reason ? h("p", { class: "notice error", attrs: { role: "alert" }, text: policy.reason }) : null,
        confirm ? h("div", { class: "check" }, confirm, h("label", { attrs: { for: confirmId }, text: "I have read the warnings and want to install this skill." })) : null,
        h("div", { class: "row" }, policy.allowed ? install : null, cancel),
      ),
    );
    (policy.allowed && !policy.needsConfirm ? install : (confirm ?? cancel)).focus();
  }

  async function onInstall(text: string, scan: ScanReport, allowWarnings: boolean): Promise<void> {
    if (!installPolicy(scan).allowed) return;
    addStatus.textContent = "Installing…";
    upgrade.hidden = true;
    try {
      const r = await api.call("skills.install", { source: text, allowWarnings });
      if (r.installed) {
        replace(report);
        source.value = "";
        addStatus.textContent = `Installed ${r.skill?.manifest.frontmatter.name ?? scan.skill}.`;
        ctx.notify(addStatus.textContent);
        await refresh();
      } else {
        addStatus.textContent = `Not installed: ${r.reason ?? "the security check did not pass."}`;
        renderReport(text, r.scan, r.lint);
      }
    } catch (e) {
      if (isUpgradeError(e)) {
        // Free plan: say so in the daemon's words, with the way to a plan.
        addStatus.textContent = "Not installed.";
        replace(upgrade, h("p", { text: describeError(e) }), button("See plans", () => ctx.navigate("plan"), { kind: "primary" }));
        upgrade.hidden = false;
        return;
      }
      addStatus.textContent = `Could not install: ${describeError(e)}`;
    }
  }

  async function onRestore(name: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    restoreStatus.textContent = `Restoring ${name}…`;
    try {
      const r = await api.call("skills.restore", { name });
      if (r.installed) {
        restoreStatus.textContent = "";
        ctx.notify(`Restored ${name}.`);
        await refresh();
        // The section hides once nothing is left to restore, so say it where the skill now is.
        listStatus.textContent = `Restored ${name}.`;
      } else {
        restoreStatus.textContent = `Could not restore ${name}: ${r.reason ?? "the security check did not pass."}`;
        btn.disabled = false;
      }
    } catch (e) {
      restoreStatus.textContent = `Could not restore ${name}: ${describeError(e)}`;
      btn.disabled = false;
    }
  }

  function restoreItem(s: RestorableSkill): HTMLElement {
    const restore: HTMLButtonElement = button("Restore", () => void onRestore(s.name, restore), { kind: "primary", ariaLabel: `Restore ${s.name}` });
    return h(
      "article",
      { class: "skill", attrs: { "data-restorable": s.name, "aria-labelledby": `restore-${s.name}` } },
      h("h3", { id: `restore-${s.name}`, attrs: { dir: "auto" }, text: s.name }),
      s.description ? h("p", { attrs: { dir: "auto" }, text: s.description }) : null,
      h("div", { class: "row" }, restore),
    );
  }

  async function onRemove(name: string): Promise<void> {
    try {
      const r = await api.call("skills.remove", { name });
      ctx.notify(r.ok ? `Removed ${name}.` : `${name} was not installed.`);
      await refresh();
    } catch (e) {
      ctx.notify(`Could not remove ${name}: ${describeError(e)}`, "error");
    }
  }

  function skillCard(s: InstalledSkill): HTMLElement {
    const m = s.manifest;
    const name = m.frontmatter.name;
    const perms = describePermissions(m.permissions);
    const remove: HTMLButtonElement = button("Remove", () => confirmInline(remove, `Remove ${name}`, () => void onRemove(name)), { kind: "ghost" });
    return h(
      "article",
      { class: "skill", attrs: { "data-skill": name, "aria-labelledby": `skill-${name}` } },
      h("h3", { id: `skill-${name}` }, name, h("span", { class: "muted", text: ` v${s.version}` })),
      h("p", { attrs: { dir: "auto" }, text: m.frontmatter.description }),
      m.effects.length ? h("p", { class: "effects", text: `Asks you before it ${m.effects.map((e) => (e === "send" ? "sends" : e === "pay" ? "pays" : "deletes")).join(", ")} anything.` }) : null,
      perms.length ? h("p", { class: "muted", text: perms.join(" · ") }) : null,
      h("p", { class: "muted", text: `${describeSource(s.source)} · installed ${formatTime(s.installedAt)}` }),
      h("div", { class: "row" }, remove),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const r = await api.call("skills.list", {});
      listStatus.textContent = r.skills.length ? "" : "No skills installed yet.";
      replace(list, ...r.skills.map(skillCard));
      installedNames = new Set(r.skills.map((s) => s.manifest.frontmatter.name));
      if (lastResults.length) renderResults();
    } catch (e) {
      listStatus.textContent = `Could not load skills: ${describeError(e)}`;
    }
    await refreshRestorable();
  }

  async function refreshRestorable(): Promise<void> {
    try {
      const r = await api.call("skills.restorable", {});
      replace(restoreList, ...r.skills.map(restoreItem));
      restoreCard.hidden = r.skills.length === 0;
    } catch {
      // An older engine without restore: nothing to offer.
      restoreCard.hidden = true;
    }
  }

  async function refreshPlan(): Promise<void> {
    try {
      const ent = await api.call("license.status", {});
      planNote.hidden = ent.features.includes("import_skills");
    } catch {
      planNote.hidden = true;
    }
  }

  return {
    el,
    show: () => {
      void refresh();
      void refreshPlan();
    },
  };
}
