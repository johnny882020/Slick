// Skill library: installed skills, add (inspect first, then install on confirm), remove.

import type { InstalledSkill, LintReport, ScanReport, SkillPermissions } from "@oneseat/contracts";
import { parseSkillSource } from "@oneseat/contracts";
import { describeError } from "../api";
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
    report,
  );

  const el = h(
    "section",
    { class: "view", attrs: { "aria-labelledby": "skills-title" } },
    h("h1", { id: "skills-title", text: "Skill library" }),
    addForm,
    h("section", { class: "card", attrs: { "aria-labelledby": "installed-title" } }, h("h2", { id: "installed-title", text: "Installed skills" }), listStatus, list),
  );

  async function onInspect(): Promise<void> {
    const text = source.value.trim();
    if (!text) {
      addStatus.textContent = "Enter where the skill is.";
      source.focus();
      return;
    }
    checkBtn.disabled = true;
    replace(report);
    addStatus.textContent = "Checking the skill…";
    try {
      const r = await api.call("skills.inspect", { source: text });
      addStatus.textContent = "";
      renderReport(text, r.scan, r.lint);
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
        h("p", { class: "scan-summary", text: scan.summary }),
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
      addStatus.textContent = `Could not install: ${describeError(e)}`;
    }
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
      h("p", { text: m.frontmatter.description }),
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
    } catch (e) {
      listStatus.textContent = `Could not load skills: ${describeError(e)}`;
    }
  }

  return { el, show: () => void refresh() };
}
