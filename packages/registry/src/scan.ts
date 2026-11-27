// Gate 4: security scan. Reads every file in a skill (text and binary), finds
// what its code can do, and compares that with what oneseat.json declares.
//
// Severity rules:
//   block - undeclared network host; network use with nothing declared; a
//           declared host without a reason; a write outside the workspace that
//           is not declared; a program run that is not in `run`; eval and other
//           dynamic code; remote code; obfuscated code; credential harvesting;
//           secret environment variables; prompt injection or hidden
//           instructions in text the model reads; hidden Unicode; native
//           executables; symlinks or special files that escape the folder.
//   warn  - smaller gaps: undeclared env names or writes inside the workspace,
//           dynamic network targets or programs when some are declared,
//           npm:/jsr: imports, encoded blobs, archives, long HTML comments.
//   info  - context: declared use, documentation examples in Markdown, binaries.
//
// Code inside fenced blocks in Markdown is treated as documentation (info),
// because skills routinely show `curl` examples. Injection text is flagged in
// Markdown wherever it appears, fenced or not.

import {
  SKILL_FILE,
  SKILL_PERMISSIONS_FILE,
  emptyPermissions,
  parsePermissionsFile,
  parseSkillMd,
  type ScanFinding,
  type ScanReport,
  type SkillEffect,
  type SkillPermissions,
} from "@oneseat/contracts";
import {
  HIDDEN_CSS,
  CREDENTIAL_PATTERNS,
  codeLang,
  detectCode,
  detectHiddenChars,
  detectHtmlComments,
  detectInjection,
  extractUrls,
  fenceLang,
  isSecretName,
  stripComments,
  type Hit,
  type Lang,
  type UrlRef,
} from "./detect.js";
import { textOf, type LoadedSkill } from "./files.js";

type FileClass = "doc" | "html" | "data";

const DOC_EXT = new Set(["md", "markdown", "mdx", "txt", "text", "rst", "adoc"]);
const HTML_EXT = new Set(["html", "htm", "xhtml", "svg"]);

function extOf(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : undefined;
}

// ------------------------------------------------------------ binaries

/** Native executable formats, by magic bytes. */
export function executableFormat(b: Uint8Array): string | undefined {
  const at = (i: number) => b[i] ?? -1;
  const u32 = b.length >= 4 ? ((at(0) << 24) | (at(1) << 16) | (at(2) << 8) | at(3)) >>> 0 : 0;
  if (u32 === 0x7f454c46) return "ELF executable";
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(u32)) return "Mach-O executable";
  if (u32 === 0xcafebabe || u32 === 0xbebafeca) return "Mach-O universal binary or Java class";
  if (u32 === 0x0061736d) return "WebAssembly module";
  if (at(0) === 0x4d && at(1) === 0x5a && b.length >= 64 && isBinary(b)) return "Windows PE executable";
  return undefined;
}

function archiveFormat(b: Uint8Array): string | undefined {
  const s = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (s(0, 0x50, 0x4b, 0x03, 0x04)) return "zip archive";
  if (s(0, 0x1f, 0x8b)) return "gzip archive";
  if (s(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "7z archive";
  if (s(0, 0x52, 0x61, 0x72, 0x21)) return "rar archive";
  if (s(257, 0x75, 0x73, 0x74, 0x61, 0x72)) return "tar archive";
  return undefined;
}

/** True when the bytes are not UTF-8 text (NUL bytes or invalid sequences). */
export function isBinary(b: Uint8Array): boolean {
  const head = b.subarray(0, 8192);
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return false;
  } catch {
    return true;
  }
}

// ------------------------------------------------------- permission maths

function isOutsideWorkspace(p: string): boolean {
  return (
    p.startsWith("/") ||
    p.startsWith("~") ||
    /^\$\{?(?:HOME|USERPROFILE|APPDATA|TMPDIR)\b/.test(p) ||
    /^%[A-Za-z]+%/.test(p) ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    p.startsWith("\\\\") ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p)
  );
}

function normPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\$\{?WORKSPACE\}?\/?/, "")
    .replace(/^\.\//, "")
    .replace(/\/\*\*?$/, "")
    .replace(/\/+$/, "");
}

/** True when a declared path list covers `p` (same path, or a parent folder). */
export function pathCovered(p: string, declared: string[]): boolean {
  const n = normPath(p);
  return declared.some((d) => {
    const dn = normPath(d);
    if (dn === "" || dn === ".") return !isOutsideWorkspace(p);
    return n === dn || n.startsWith(`${dn}/`);
  });
}

/** True when `host` (with optional port) is allowed by a declared net entry. */
export function hostAllowed(host: string, port: string | undefined, declared: string[]): boolean {
  return declared.some((raw) => {
    const d = raw.trim().toLowerCase();
    const [dh, dp] = d.startsWith("[") ? [d.slice(0, d.indexOf("]") + 1), d.slice(d.indexOf("]") + 2) || undefined] : d.split(":");
    if (dp !== undefined && port !== undefined && dp !== port) return false;
    if (dp !== undefined && port === undefined) return false;
    if (dh!.startsWith("*.")) return host.endsWith(dh!.slice(1)) && host.length > dh!.length - 1;
    return dh === host;
  });
}

function hostLabel(u: { host: string; port?: string }): string {
  return u.port ? `${u.host}:${u.port}` : u.host;
}

// ----------------------------------------------------------- the scanner

interface CodeFile {
  path: string;
  lang: Lang;
  hits: Hit[];
  urls: UrlRef[];
}

interface Collector {
  findings: ScanFinding[];
  add(severity: ScanFinding["severity"], rule: string, file: string, line: number | undefined, message: string): void;
}

function collector(): Collector {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  return {
    findings,
    add(severity, rule, file, line, message) {
      const key = `${severity}|${rule}|${file}|${line ?? ""}|${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      const f: ScanFinding = { severity, rule, file, message };
      if (line !== undefined) f.line = line;
      findings.push(f);
    },
  };
}

function scanDocText(path: string, text: string, cls: FileClass, c: Collector, docExamples: Set<string>): void {
  // Eval cases are read by the eval runner, never by the model at run time,
  // and often hold adversarial inputs on purpose.
  const evalFile = path.startsWith("evals/");
  const strongSeverity = evalFile ? "info" : cls === "data" ? "warn" : "block";
  for (const inj of detectInjection(text))
    c.add(inj.strength === "strong" ? strongSeverity : evalFile ? "info" : "warn", "prompt-injection", path, inj.line, `Text ${inj.what}.`);
  if (cls === "data") return;
  for (const hc of detectHtmlComments(text)) {
    if (hc.severity === "info" && cls === "html") continue;
    c.add(hc.severity, hc.severity === "info" ? "html-comment" : "hidden-instruction", path, hc.line, `${capital(hc.what)}.`);
  }
  if (cls === "html") return;
  // Markdown: prose vs fenced code.
  const lines = text.split("\n");
  let fence: { char: string; len: number; lang: Lang | undefined; start: number; body: string[] } | undefined;
  lines.forEach((line, i) => {
    const n = i + 1;
    const open = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(line);
    if (fence) {
      if (open && open[1]![0] === fence.char && open[1]!.length >= fence.len && open[2] === "") {
        docExampleHits(path, fence.body.join("\n"), fence.lang, fence.start + 1, c, docExamples);
        fence = undefined;
      } else fence.body.push(line);
      return;
    }
    if (open) {
      fence = { char: open[1]![0]!, len: open[1]!.length, lang: fenceLang(open[2] ?? ""), start: n, body: [] };
      return;
    }
    const prose = line.replace(/`[^`]*`/g, "");
    for (const cred of CREDENTIAL_PATTERNS)
      if (cred.re.test(prose)) c.add("warn", "credential-mention", path, n, `Mentions ${cred.what} in the instructions.`);
    if (HIDDEN_CSS.test(line)) c.add("warn", "hidden-text", path, n, "Uses styling that hides text from the person but not from the model.");
  });
  if (fence) docExampleHits(path, fence.body.join("\n"), fence.lang, fence.start + 1, c, docExamples);
}

/** Code in a Markdown fence: documentation, reported as info (remote-code pipes warn). */
function docExampleHits(path: string, body: string, lang: Lang | undefined, firstLine: number, c: Collector, docExamples: Set<string>): void {
  const langs: Lang[] = lang ? [lang] : ["sh", "js", "py"];
  for (const l of langs) {
    for (const h of detectCode(body, l)) {
      const line = firstLine + h.line - 1;
      if (h.kind === "remote-code") {
        c.add("warn", "doc-remote-code", path, line, `Documentation example ${h.detail}; the model may copy it.`);
        continue;
      }
      if (h.kind === "decoder" || h.kind === "blob" || h.kind === "charcode") continue;
      docExamples.add(describeKind(h));
      c.add("info", "doc-example", path, line, `Documentation example uses ${h.detail} (not run by the skill).`);
    }
  }
}

function describeKind(h: Hit): string {
  switch (h.kind) {
    case "net":
      return "network commands";
    case "read":
    case "write":
    case "delete":
      return "file commands";
    case "exec":
    case "eval":
      return "running programs";
    case "env":
    case "env-dump":
      return "environment variables";
    default:
      return "code";
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Lines of `text` inside <script>...</script>, as a code body with the same line numbers. */
function scriptRegions(text: string): string {
  const lines = text.split("\n");
  const out = lines.map(() => "");
  let inside = false;
  lines.forEach((line, i) => {
    let rest = line;
    let kept = "";
    for (;;) {
      if (!inside) {
        const open = /<script\b[^>]*>/i.exec(rest);
        if (!open) break;
        rest = rest.slice(open.index + open[0].length);
        inside = true;
      } else {
        const close = /<\/script\s*>/i.exec(rest);
        if (!close) {
          kept += rest;
          break;
        }
        kept += `${rest.slice(0, close.index)} `;
        rest = rest.slice(close.index + close[0].length);
        inside = false;
      }
    }
    out[i] = kept;
  });
  return out.join("\n");
}

/** Scan a loaded skill. Never throws on bad content; everything becomes a finding. */
export function scanSkill(skill: LoadedSkill): ScanReport {
  const c = collector();
  const docExamples = new Set<string>();
  let filesRead = 0;
  let bytesRead = 0;

  // Declared permissions and identity.
  const skillMdEntry = skill.entries.find((e) => e.path === SKILL_FILE && e.kind === "file");
  const permEntry = skill.entries.find((e) => e.path === SKILL_PERMISSIONS_FILE && e.kind === "file");
  const permText = permEntry && permEntry.kind === "file" ? textOf(permEntry.bytes) : undefined;
  const perms = parsePermissionsFile(permText);
  if (perms.issues.some((i) => i.severity === "error" && i.rule !== "net-reason"))
    c.add("warn", "permissions-invalid", SKILL_PERMISSIONS_FILE, undefined, "oneseat.json is invalid, so nothing counts as declared.");
  const declared: SkillPermissions = perms.value.permissions;
  const effects: SkillEffect[] = perms.value.effects;
  const reasons = perms.value.reasons;
  const scripts = perms.value.scripts;
  let name = skill.dirName;
  let description = "";
  let body = "";
  if (skillMdEntry && skillMdEntry.kind === "file") {
    try {
      const p = parseSkillMd(textOf(skillMdEntry.bytes));
      if (typeof p.frontmatter["name"] === "string" && p.frontmatter["name"]) name = p.frontmatter["name"];
      if (typeof p.frontmatter["description"] === "string") description = p.frontmatter["description"].trim();
      body = p.body;
    } catch {
      c.add("warn", "skill-md-invalid", SKILL_FILE, 1, "SKILL.md frontmatter cannot be parsed.");
    }
  } else c.add("warn", "skill-md-missing", SKILL_FILE, undefined, "The skill has no SKILL.md.");

  const codeFiles: CodeFile[] = [];
  for (const e of skill.entries) {
    if (e.kind === "symlink") {
      if (e.resolved === undefined) c.add("block", "symlink-escape", e.path, undefined, `Symlink points outside the skill folder (${e.target}).`);
      else if (e.dangling) c.add("warn", "symlink", e.path, undefined, `Symlink points at nothing (${e.target}); it will be left out.`);
      else c.add("warn", "symlink", e.path, undefined, `Symlink to ${e.resolved}; it will be installed as a plain copy.`);
      continue;
    }
    if (e.kind === "special") {
      c.add("block", "special-file", e.path, undefined, `A ${e.type} is not allowed in a skill.`);
      continue;
    }
    filesRead += 1;
    bytesRead += e.bytes.length;
    const exe = executableFormat(e.bytes);
    if (exe) {
      c.add("block", "binary-executable", e.path, undefined, `${exe}: native programs cannot be checked and are not allowed.`);
      continue;
    }
    const archive = archiveFormat(e.bytes);
    if (archive) {
      c.add("warn", "archive", e.path, undefined, `${capital(archive)}: its contents cannot be checked.`);
      continue;
    }
    if (isBinary(e.bytes)) {
      c.add("info", "binary-file", e.path, undefined, `Binary file (${e.bytes.length} bytes), not code.`);
      continue;
    }
    const text = textOf(e.bytes).replace(/\r\n?/g, "\n");
    for (const h of detectHiddenChars(text)) c.add(h.severity, "hidden-characters", e.path, h.line, `Contains ${h.what}.`);
    const ext = extOf(e.path);
    const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    const lang = ext && (DOC_EXT.has(ext) || HTML_EXT.has(ext)) ? undefined : codeLang(e.path, firstLine);
    if (lang) {
      const hits = detectCode(text, lang);
      const urls = stripComments(text, lang)
        .split("\n")
        .flatMap((l, i) => extractUrls(l, i + 1));
      codeFiles.push({ path: e.path, lang, hits, urls });
      for (const inj of detectInjection(text)) c.add("warn", "prompt-injection", e.path, inj.line, `Code contains text that ${inj.what}.`);
      continue;
    }
    const cls: FileClass = ext && HTML_EXT.has(ext) ? "html" : ext === undefined || DOC_EXT.has(ext) ? "doc" : "data";
    scanDocText(e.path, text, cls, c, docExamples);
    if (cls === "html") {
      const js = scriptRegions(text);
      const hits = detectCode(js, "js");
      const urls = stripComments(js, "js")
        .split("\n")
        .flatMap((l, i) => extractUrls(l, i + 1));
      codeFiles.push({ path: e.path, lang: "js", hits, urls });
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/<(script|link|img|iframe|video|audio|source|embed|object)\b[^>]*\b(?:src|href|data)\s*=\s*["']?(?:https?:)?\/\/([^"'\s>/]+)/gi)) {
          if (m[1]!.toLowerCase() === "script" || m[1]!.toLowerCase() === "iframe")
            c.add("block", "remote-code", e.path, i + 1, `Loads ${m[1]} code from ${m[2]}.`);
          else c.add("warn", "remote-resource", e.path, i + 1, `Loads a remote ${m[1]} from ${m[2]} (blocked in pinned apps).`);
        }
      });
    }
  }

  const observed = judgeCode(codeFiles, declared, effects, reasons, c);

  // Declared but questionable.
  for (const host of declared.net)
    if (!reasons[host]) c.add("block", "network-no-reason", SKILL_PERMISSIONS_FILE, undefined, `Network host "${host}" is declared without a reason.`);
  for (const env of declared.env)
    if (isSecretName(env)) c.add("block", "secret-env-declared", SKILL_PERMISSIONS_FILE, undefined, `Declares secret variable "${env}"; keys never reach skills.`);
  for (const host of declared.net)
    if (!observed.net.some((o) => hostAllowed(o.split(":")[0]!, o.split(":")[1], [host])))
      c.add("info", "unused-permission", SKILL_PERMISSIONS_FILE, undefined, `Declares network host "${host}" but no code was seen using it.`);
  const scriptFiles = new Set(Object.values(scripts).map((s) => s.file.replace(/^\.\//, "")));
  for (const f of codeFiles)
    if (!scriptFiles.has(f.path) && !HTML_EXT.has(extOf(f.path) ?? ""))
      c.add("info", "helper-file", f.path, undefined, "Code file not listed in oneseat.json scripts (a helper, or not run).");

  const findings = sortFindings(c.findings);
  const verdict: ScanReport["verdict"] = findings.some((f) => f.severity === "block")
    ? "block"
    : findings.some((f) => f.severity === "warn")
      ? "warn"
      : "pass";
  const report: ScanReport = {
    skill: name,
    verdict,
    summary: "",
    findings,
    declared,
    observed: {
      net: observed.net,
      read: observed.read,
      write: observed.write,
      env: observed.env,
      run: observed.run,
    },
    filesRead,
    bytesRead,
  };
  report.summary = summarise({ report, description, body, effects, reasons, scripts, docExamples });
  return report;
}

const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 } as const;
function sortFindings(f: ScanFinding[]): ScanFinding[] {
  return [...f].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.rule.localeCompare(b.rule),
  );
}

function judgeCode(
  files: CodeFile[],
  declared: SkillPermissions,
  effects: SkillEffect[],
  reasons: Record<string, string>,
  c: Collector,
): SkillPermissions {
  const observed = emptyPermissions();
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  const anyNetwork = files.some((f) => f.hits.some((h) => h.kind === "net"));

  for (const f of files) {
    const hasNet = f.hits.some((h) => h.kind === "net");
    // Hosts. When any file uses the network, every host named in code is treated as a target.
    const seenHosts = new Set<string>();
    for (const u of f.urls) {
      const label = hostLabel(u);
      if (seenHosts.has(label)) continue;
      seenHosts.add(label);
      if (anyNetwork) {
        add(observed.net, label);
        const entry = declared.net.find((d) => hostAllowed(u.host, u.port, [d]));
        if (entry) c.add("info", "network-declared", f.path, u.line, `Reaches declared host ${label} (${reasons[entry] ?? "no reason given"}).`);
        else c.add("block", "undeclared-network-host", f.path, u.line, `Reaches ${label}, which oneseat.json does not declare.`);
      } else if (!hostAllowed(u.host, u.port, declared.net))
        c.add("warn", "url-in-code", f.path, u.line, `Names ${label} in code (no network call seen); it is not declared.`);
    }
    // Templated URLs ("https://${host}/") yield no host, so they land here too.
    if (hasNet && f.urls.length === 0) {
      const h = f.hits.find((x) => x.kind === "net")!;
      if (declared.net.length === 0)
        c.add("block", "undeclared-network", f.path, h.line, `Uses the network (${h.detail}) but declares no network hosts.`);
      else c.add("warn", "dynamic-network-target", f.path, h.line, `Uses the network (${h.detail}) with a computed address; only declared hosts will be reachable.`);
    }

    // Decoders + dynamic code = obfuscated code.
    const decoder = f.hits.find((h) => h.kind === "decoder");
    const evalHit = f.hits.find((h) => h.kind === "eval" || h.kind === "exec");
    const blob = f.hits.find((h) => h.kind === "blob");
    if ((decoder || blob) && evalHit)
      c.add("block", "obfuscated-code", f.path, evalHit.line, `Decodes hidden data and runs code (${(decoder ?? blob)!.detail} + ${evalHit.detail}).`);

    for (const h of f.hits) {
      switch (h.kind) {
        case "read": {
          const p = h.value;
          add(observed.read, p ?? "(computed path)");
          if (p && isOutsideWorkspace(p) && !pathCovered(p, declared.read))
            c.add("warn", "undeclared-read", f.path, h.line, `Reads ${p} (${h.detail}), outside the workspace and not declared.`);
          else c.add("info", "file-read", f.path, h.line, `Reads files (${h.detail}${p ? ` ${p}` : ""}).`);
          break;
        }
        case "write":
        case "delete": {
          const p = h.value;
          add(observed.write, p ?? "(computed path)");
          const verb = h.kind === "delete" ? "Deletes" : "Writes";
          if (p && isOutsideWorkspace(p) && !pathCovered(p, declared.write))
            c.add("block", "undeclared-write", f.path, h.line, `${verb} ${p} (${h.detail}), outside the workspace and not declared.`);
          else if (declared.write.length === 0)
            c.add("warn", "undeclared-write", f.path, h.line, `${verb} files (${h.detail}${p ? ` ${p}` : ""}) but declares no write paths.`);
          else if (p && !pathCovered(p, declared.write))
            c.add("warn", "undeclared-write", f.path, h.line, `${verb} ${p} (${h.detail}), which is not under a declared write path.`);
          else c.add("info", "file-write", f.path, h.line, `${verb} files (${h.detail}${p ? ` ${p}` : ""}).`);
          if (h.kind === "delete" && !effects.includes("delete"))
            c.add("warn", "delete-without-effect", f.path, h.line, `Deletes files but does not declare the "delete" effect.`);
          break;
        }
        case "exec": {
          const exe = h.value;
          if (exe) {
            add(observed.run, exe);
            if (declared.run.some((r) => r === exe || r.split(/[\\/]/).pop() === exe))
              c.add("info", "process-declared", f.path, h.line, `Runs declared program ${exe}.`);
            else c.add("block", "undeclared-process", f.path, h.line, `Runs ${exe}${h.detail === exe ? "" : ` (${h.detail})`}, which is not in oneseat.json "run".`);
          } else {
            add(observed.run, "(computed program)");
            if (declared.run.length === 0)
              c.add("block", "undeclared-process", f.path, h.line, `Starts programs (${h.detail}) but declares none in "run".`);
            else c.add("warn", "dynamic-process", f.path, h.line, `Starts a program chosen at run time (${h.detail}).`);
          }
          break;
        }
        case "eval":
          c.add("block", "dynamic-code", f.path, h.line, `Runs code built at run time (${h.detail}).`);
          break;
        case "native":
          c.add("block", "native-code", f.path, h.line, `${capital(h.detail)}: native code bypasses the sandbox.`);
          break;
        case "env": {
          const v = h.value;
          if (v && isSecretName(v)) {
            add(observed.env, v);
            c.add("block", "credential-env", f.path, h.line, `Reads secret variable ${v}; keys never reach skills.`);
          } else if (v) {
            add(observed.env, v);
            if (!declared.env.includes(v)) c.add("warn", "undeclared-env", f.path, h.line, `Reads environment variable ${v}, which is not declared.`);
            else c.add("info", "env-declared", f.path, h.line, `Reads declared variable ${v}.`);
          } else {
            add(observed.env, "(computed name)");
            c.add("warn", "dynamic-env", f.path, h.line, `Reads an environment variable chosen at run time (${h.detail}).`);
          }
          break;
        }
        case "env-dump":
          add(observed.env, "(all)");
          c.add("block", "env-dump", f.path, h.line, `${capital(h.detail)}: collects every variable, including keys.`);
          break;
        case "remote-code":
          c.add("block", "remote-code", f.path, h.line, `${capital(h.detail)}: code that was never scanned would run.`);
          break;
        case "package-import":
          c.add("warn", "package-import", f.path, h.line, `${capital(h.detail)}; that code is not scanned.`);
          break;
        case "dynamic-import":
          c.add("warn", "dynamic-import", f.path, h.line, `${capital(h.detail)}.`);
          break;
        case "blob":
          c.add("warn", "encoded-blob", f.path, h.line, `Contains ${h.detail}, which hides what it holds.`);
          break;
        case "charcode":
          c.add("warn", "obfuscation", f.path, h.line, `Builds strings from character codes (${h.detail}).`);
          break;
        case "credential":
          c.add("block", "credential-harvesting", f.path, h.line, `Touches ${h.detail}.`);
          break;
        case "decoder":
        case "net":
          break;
      }
    }
  }
  for (const list of Object.values(observed) as string[][]) list.sort();
  return observed;
}

// -------------------------------------------------------------- summary

/** Remove invisible characters so the summary never repeats hidden text. */
function visible(s: string): string {
  return s.replace(/[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu, "");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function firstParagraph(body: string): string {
  const lines = body.split("\n");
  const para: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      if (para.length) break;
      continue;
    }
    if (/^(#|<!--|[-*_]{3,}$|\||>)/.test(line)) {
      if (para.length) break;
      continue;
    }
    para.push(line.replace(/^[-*+]\s+|^\d+\.\s+/, ""));
  }
  let text = para.join(" ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "");
  if (text.length > 220) text = `${text.slice(0, 217).replace(/\s+\S*$/, "")}...`;
  return text;
}

function summarise(input: {
  report: ScanReport;
  description: string;
  body: string;
  effects: SkillEffect[];
  reasons: Record<string, string>;
  scripts: Record<string, { file: string; description: string }>;
  docExamples: Set<string>;
}): string {
  const { report, description, body, effects, reasons, scripts, docExamples } = input;
  const out: string[] = [];
  const desc = description ? visible(description).replace(/\s+/g, " ") : "No description.";
  out.push(`"${visible(report.skill)}": ${desc}${/[.!?]$/.test(desc) ? "" : "."}`);
  const para = visible(firstParagraph(body));
  if (para) out.push(`Its instructions start: "${para}"`);
  out.push(`It has ${report.filesRead} file${report.filesRead === 1 ? "" : "s"} (${formatBytes(report.bytesRead)}).`);

  const d = report.declared;
  const declaredParts: string[] = [];
  if (d.net.length) declaredParts.push(`the network (${d.net.map((h) => (reasons[h] ? `${h}: ${reasons[h]}` : `${h}: no reason given`)).join("; ")})`);
  if (d.read.length) declaredParts.push(`reading ${listText(d.read)}`);
  if (d.write.length) declaredParts.push(`writing ${listText(d.write)}`);
  if (d.env.length) declaredParts.push(`environment variables ${listText(d.env)}`);
  if (d.run.length) declaredParts.push(`running ${listText(d.run)}`);
  const scriptList = Object.entries(scripts);
  if (!declaredParts.length && !scriptList.length) out.push("It declares no access: it is instructions only.");
  else if (declaredParts.length) out.push(`It asks for ${listText(declaredParts)}.`);
  else out.push("Its scripts ask for no network, file, environment or program access.");
  if (scriptList.length) out.push(`Scripts it can run: ${scriptList.map(([k, s]) => `${k} (${s.file}): ${s.description.replace(/[.\s]+$/, "")}`).join("; ")}.`);
  if (effects.length) out.push(`Actions that need your approval each time: ${listText(effects)}.`);

  const o = report.observed;
  const seen: string[] = [];
  if (o.net.length) seen.push(`network calls to ${listText(o.net)}`);
  if (o.read.length) seen.push("reading files");
  if (o.write.length) seen.push("writing or deleting files");
  if (o.run.length) seen.push(`running ${listText(o.run)}`);
  if (o.env.length) seen.push(`environment variables (${listText(o.env)})`);
  if (seen.length) out.push(`The scan saw code that uses ${listText(seen)}.`);
  else out.push("The scan saw no network, file, program or environment use in its files.");
  if (docExamples.size) out.push(`Its documentation shows examples of ${listText([...docExamples].sort())}, which are not run.`);

  const reasonsText = (sev: "block" | "warn") => {
    const msgs = [...new Set(report.findings.filter((f) => f.severity === sev).map((f) => `${f.message.replace(/\.$/, "")} (${f.file}${f.line ? `:${f.line}` : ""})`))];
    const shown = msgs.slice(0, 3).join("; ");
    return msgs.length > 3 ? `${shown}; and ${msgs.length - 3} more` : shown;
  };
  const count = (sev: "block" | "warn") => report.findings.filter((f) => f.severity === sev).length;
  if (report.verdict === "block") out.push(`Verdict: blocked, ${count("block")} problem${count("block") === 1 ? "" : "s"}: ${reasonsText("block")}.`);
  else if (report.verdict === "warn") out.push(`Verdict: allowed with ${count("warn")} warning${count("warn") === 1 ? "" : "s"}: ${reasonsText("warn")}.`);
  else out.push("Verdict: pass.");
  return out.join(" ");
}
