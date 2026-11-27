// Line-level detectors used by the scanner (gate 4). Each detector reads a
// file's lines and reports raw "hits": what the code does (network, files,
// processes, environment, remote code, obfuscation, credentials). The scanner
// decides how serious each hit is by comparing it with what the skill declared.

export type Lang = "js" | "py" | "sh" | "ps" | "other";

export type HitKind =
  | "net"
  | "read"
  | "write"
  | "delete"
  | "exec"
  | "eval"
  | "native"
  | "env"
  | "env-dump"
  | "remote-code"
  | "package-import"
  | "dynamic-import"
  | "decoder"
  | "blob"
  | "charcode"
  | "credential";

export interface Hit {
  kind: HitKind;
  /** 1-based line number. */
  line: number;
  /** Short description of what was seen, e.g. "fetch()". */
  detail: string;
  /** Host, path, executable or variable name when it is a literal. */
  value?: string;
}

// ---------------------------------------------------------------- helpers

/** Content of the first string literal right after `from` (skipping "(" and spaces). */
export function literalAfter(line: string, from: number): string | undefined {
  const m = /^\s*\(?\s*(?:\[\s*)?(["'`])((?:\\.|(?!\1).)*)\1/.exec(line.slice(from));
  if (!m) return undefined;
  const v = m[2]!;
  if (m[1] === "`" && v.includes("${")) return undefined;
  return v;
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

/** Strip a leading path from an executable ("/usr/bin/git" -> "git"). */
export function exeName(raw: string): string {
  const s = raw.replace(/^["']|["']$/g, "");
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

export interface UrlRef {
  host: string;
  port?: string;
  line: number;
}

/** Hostnames that appear in URLs as identifiers (XML namespaces, schemas), not as network targets. */
export const NAMESPACE_HOSTS: ReadonlySet<string> = new Set([
  "www.w3.org",
  "w3.org",
  "json-schema.org",
  "schemas.xmlsoap.org",
  "schemas.microsoft.com",
  "schemas.openxmlformats.org",
  "purl.org",
  "xmlns.com",
  "ns.adobe.com",
  "www.apple.com/dtds",
]);

const URL_RE = /\b(?:https?|wss?|ftp):\/\/(?:[^\s"'`<>()/@]*@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?/g;

export function extractUrls(line: string, lineNo: number): UrlRef[] {
  const out: UrlRef[] = [];
  for (const m of line.matchAll(URL_RE)) {
    const host = m[1]!.toLowerCase().replace(/\.+$/, "");
    if (!host || !/[a-z0-9]/.test(host) || NAMESPACE_HOSTS.has(host)) continue;
    const ref: UrlRef = { host, line: lineNo };
    if (m[2]) ref.port = m[2];
    out.push(ref);
  }
  return out;
}

const SECRET_NAME_RE =
  /(?:^|_)(?:API_?KEY|APIKEY|SECRET|SECRET_KEY|CLIENT_SECRET|TOKEN|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|PASSWORD|PASSWD|PASS|PRIVATE_KEY|CREDENTIALS?|ACCESS_KEY(?:_ID)?|SESSION_KEY)(?:_|$)/;

/** True for environment variable names that look like they hold secrets (OPENAI_API_KEY, GITHUB_TOKEN). */
export function isSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && SECRET_NAME_RE.test(name.toUpperCase());
}

// ------------------------------------------------------- shared detectors

export const CREDENTIAL_PATTERNS: readonly { re: RegExp; what: string }[] = [
  {
    re: /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|homedir\(\))[^\s"'`]{0,4}[\\/]\.ssh\b|\.ssh[\\/](?:id_|authorized_keys|known_hosts|config\b)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i,
    what: "SSH keys",
  },
  {
    re: /\.aws[\\/](?:credentials|config)\b|\.config[\\/]gcloud\b|\.azure[\\/]|\.kube[\\/]config\b|\.docker[\\/]config\.json|(?:^|[\s"'`/\\(=])\.(?:netrc|npmrc|pypirc|git-credentials|pgpass)\b|\.gnupg\b/i,
    what: "cloud or developer-tool credentials",
  },
  {
    re: /Library[\\/]Keychains|\blogin\.keychain|\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b|\bkeyring\s*\.\s*get_password\b|\bcmdkey\b|\bvaultcmd\b|\bCredRead\w*|\bsecret-tool\s+lookup\b|\bkwallet/i,
    what: "the system keychain",
  },
  {
    re: /Google[\\/]Chrome|Chrome[\\/]User Data|BraveSoftware|Microsoft[\\/]Edge[\\/]User Data|Mozilla[\\/]Firefox|Firefox[\\/]Profiles|\.mozilla[\\/]firefox|Login Data|cookies\.sqlite|Cookies\.binarycookies|logins\.json|\bkey[34]\.db\b|Safari[\\/](?:Cookies|History)/i,
    what: "browser profiles, cookies or saved passwords",
  },
  {
    re: /(?:^|[\s"'`/\\(=])\.env(?:\.(?!example\b|sample\b|template\b)[A-Za-z0-9_-]+)?(?=$|[\s"'`)\],;])|\bdotenv\b|\bload_dotenv\b/,
    what: ".env files",
  },
  {
    re: /\/etc\/(?:shadow|gshadow|sudoers)\b|\bwallet\.dat\b|\.bitcoin[\\/]|\.electrum[\\/]|\bExodus[\\/]|\bMetaMask\b/i,
    what: "system secrets or crypto wallets",
  },
];

const SECRET_LITERAL_RE = /["'`]([A-Z][A-Z0-9_]{3,})["'`]/g;

/** Credentials, secret-name literals and obfuscation, for any code language. */
function detectCommon(lines: string[]): Hit[] {
  const hits: Hit[] = [];
  let charcodes = 0;
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const c of CREDENTIAL_PATTERNS) if (c.re.test(line)) hits.push({ kind: "credential", line: n, detail: c.what });
    for (const m of line.matchAll(SECRET_LITERAL_RE))
      if (isSecretName(m[1]!)) hits.push({ kind: "env", line: n, detail: `secret variable name "${m[1]}"`, value: m[1]! });
    // Long base64 runs (not data: URIs of images/fonts) and hex runs.
    for (const m of line.matchAll(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{120,}={0,2}(?![A-Za-z0-9+/=_-])/g)) {
      const s = m[0];
      const before = line.slice(Math.max(0, m.index - 40), m.index);
      if (/data:(?:image|font|audio|video)\/[\w.+-]+;base64,$/i.test(before)) continue;
      if (/[0-9+/]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s))
        hits.push({ kind: "blob", line: n, detail: `a long encoded blob (${s.length} characters)` });
    }
    if (/(?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u[0-9a-fA-F]{4}){16,}|(?<![0-9a-fA-F])[0-9a-fA-F]{160,}(?![0-9a-fA-F])/.test(line))
      hits.push({ kind: "blob", line: n, detail: "a long hex-encoded string" });
    const fcc = line.match(/String\s*\.\s*fromCharCode\s*\(([^)]*)\)/g) ?? [];
    for (const call of fcc) {
      charcodes += 1;
      if ((call.match(/,/g) ?? []).length >= 5 || charcodes === 3)
        hits.push({ kind: "charcode", line: n, detail: "String.fromCharCode() chain" });
    }
    if (
      /\batob\s*\(|Buffer\s*\.\s*from\s*\([^)]*["'](?:base64|hex)["']|\bunescape\s*\(|\b(?:b64decode|b32decode|a85decode|unhexlify|fromhex)\s*\(|codecs\s*\.\s*decode\s*\(|\bzlib\s*\.\s*decompress\s*\(|\bmarshal\s*\.\s*loads\s*\(|\bbase64\s+(?:-d|--decode|-D)\b|\bxxd\s+-r\b|FromBase64String/i.test(
        line,
      )
    )
      hits.push({ kind: "decoder", line: n, detail: "decodes hidden data" });
  });
  return hits;
}

// ----------------------------------------------------- JavaScript / TypeScript

const JS_IMPORT = String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)`;
function jsImport(mods: string): RegExp {
  return new RegExp(JS_IMPORT + String.raw`["'\`](?:node:|npm:)?(?:${mods})(?:@[^"'\`/]*)?(?:\/[^"'\`]*)?["'\`]`, "m");
}
const JS_NET_IMPORT = jsImport("http|https|http2|net|dgram|tls|dns");
const JS_NET_PKG = jsImport("axios|got|node-fetch|undici|superagent|request|needle|ky|cross-fetch|isomorphic-fetch|ws|socket\\.io-client");
const JS_FS_IMPORT = jsImport("fs|fs-extra|graceful-fs");
const JS_CP_IMPORT = jsImport("child_process|execa|shelljs|cross-spawn|zx");
const JS_VM_IMPORT = jsImport("vm");

const JS_NET: readonly [RegExp, string][] = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+WebSocket(?:Stream)?\s*\(/, "WebSocket"],
  [/\bnew\s+EventSource\s*\(/, "EventSource"],
  [/\bnavigator\s*\.\s*sendBeacon\s*\(/, "navigator.sendBeacon()"],
  [/\bDeno\s*\.\s*(?:connect|connectTls|listen|listenTls|listenDatagram|serve|startTls|resolveDns|createHttpClient)\b/, "Deno network API"],
];

const DENO_READ = /\bDeno\s*\.\s*(readTextFile|readFile|readDir|readLink|stat|lstat|realPath|watchFs|readTextFileSync|readFileSync|readDirSync|readLinkSync|statSync|lstatSync|realPathSync)\s*\(/g;
const DENO_WRITE = /\bDeno\s*\.\s*(writeTextFile|writeFile|writeTextFileSync|writeFileSync|create|createSync|mkdir|mkdirSync|makeTempFile|makeTempDir|makeTempFileSync|makeTempDirSync|rename|renameSync|copyFile|copyFileSync|symlink|symlinkSync|link|linkSync|chmod|chmodSync|chown|chownSync|truncate|truncateSync|utime|utimeSync)\s*\(/g;
const DENO_DELETE = /\bDeno\s*\.\s*(remove|removeSync)\s*\(/g;
const DENO_OPEN = /\bDeno\s*\.\s*(open|openSync)\s*\(/g;
const NODE_FS_WRITE = /(?<![\w$])(?:\w+\s*\.\s*)?(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|chmod|chmodSync|chown|chownSync|truncate|truncateSync|outputFile|outputFileSync|writeJson|writeJsonSync)\s*\(/g;
const NODE_FS_DELETE = /(?<![\w$])(?:\w+\s*\.\s*)?(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|remove|removeSync)\s*\(/g;
const NODE_FS_READ = /(?<![\w$])(?:\w+\s*\.\s*)?(readFile|readFileSync|readdir|readdirSync|createReadStream|stat|statSync|lstat|lstatSync|access|accessSync|existsSync|opendir|readlink|realpath|readJson|readJsonSync)\s*\(/g;

function jsHits(lines: string[], text: string): Hit[] {
  const hits: Hit[] = [];
  const fsImported = JS_FS_IMPORT.test(text);
  const cpImported = JS_CP_IMPORT.test(text);
  let fsCalls = 0;
  let cpCalls = 0;
  lines.forEach((line, i) => {
    const n = i + 1;
    for (const [re, what] of JS_NET) if (re.test(line)) hits.push({ kind: "net", line: n, detail: what });
    if (JS_NET_IMPORT.test(line)) hits.push({ kind: "net", line: n, detail: "imports a Node network module" });
    if (JS_NET_PKG.test(line)) hits.push({ kind: "net", line: n, detail: "imports an HTTP client package" });

    for (const m of line.matchAll(DENO_READ)) hits.push({ kind: "read", line: n, detail: `Deno.${m[1]}()`, ...val(literalAfter(line, m.index + m[0].length - 1)) });
    for (const m of line.matchAll(DENO_WRITE)) hits.push({ kind: "write", line: n, detail: `Deno.${m[1]}()`, ...val(literalAfter(line, m.index + m[0].length - 1)) });
    for (const m of line.matchAll(DENO_DELETE)) hits.push({ kind: "delete", line: n, detail: `Deno.${m[1]}()`, ...val(literalAfter(line, m.index + m[0].length - 1)) });
    for (const m of line.matchAll(DENO_OPEN)) {
      const kind = /\b(?:write|append|create|truncate)\s*:\s*true/.test(line) ? "write" : "read";
      hits.push({ kind, line: n, detail: `Deno.${m[1]}()`, ...val(literalAfter(line, m.index + m[0].length - 1)) });
    }
    if (fsImported) {
      for (const [re, kind] of [
        [NODE_FS_WRITE, "write"],
        [NODE_FS_DELETE, "delete"],
        [NODE_FS_READ, "read"],
      ] as const) {
        for (const m of line.matchAll(re)) {
          fsCalls += 1;
          hits.push({ kind, line: n, detail: `fs ${m[1]}()`, ...val(literalAfter(line, m.index + m[0].length - 1)) });
        }
      }
    }

    // Processes and dynamic code.
    for (const m of line.matchAll(/\bnew\s+Deno\s*\.\s*Command\s*\(/g))
      hits.push({ kind: "exec", line: n, detail: "Deno.Command", ...val(literalAfter(line, m.index + m[0].length - 1), exeName) });
    for (const m of line.matchAll(/\bDeno\s*\.\s*run\s*\(/g)) {
      const cmd = /cmd\s*:\s*\[\s*(["'`])([^"'`]+)\1/.exec(line.slice(m.index));
      hits.push({ kind: "exec", line: n, detail: "Deno.run", ...val(cmd?.[2], exeName) });
    }
    if (/\bBun\s*\.\s*(?:spawn|spawnSync|\$)\b/.test(line)) hits.push({ kind: "exec", line: n, detail: "Bun.spawn" });
    if (cpImported) {
      for (const m of line.matchAll(/(?<![\w$])(?:\w+\s*\.\s*)?(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|execa|execaSync|execaCommand)\s*\(/g)) {
        const lit = literalAfter(line, m.index + m[0].length - 1);
        cpCalls += 1;
        hits.push({ kind: "exec", line: n, detail: `${m[1]}()`, ...val(lit ? firstWord(lit) : undefined, exeName) });
      }
    }
    if (/(?<![\w$.])eval\s*\(/.test(line)) hits.push({ kind: "eval", line: n, detail: "eval()" });
    if (/\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(\s*["'`]/.test(line)) hits.push({ kind: "eval", line: n, detail: "Function constructor" });
    if (/\bset(?:Timeout|Interval)\s*\(\s*["'`]/.test(line)) hits.push({ kind: "eval", line: n, detail: "string passed to setTimeout/setInterval" });
    if (JS_VM_IMPORT.test(line)) hits.push({ kind: "eval", line: n, detail: "imports node:vm" });
    if (/\bDeno\s*\.\s*dlopen\s*\(|\bprocess\s*\.\s*dlopen\s*\(/.test(line)) hits.push({ kind: "native", line: n, detail: "loads a native library" });

    // Environment.
    for (const m of line.matchAll(/\bDeno\s*\.\s*env\s*\.\s*(get|has|set|delete)\s*\(/g)) {
      const lit = literalAfter(line, m.index + m[0].length - 1);
      hits.push({ kind: "env", line: n, detail: `Deno.env.${m[1]}()`, ...val(lit) });
    }
    if (/\bDeno\s*\.\s*env\s*\.\s*toObject\s*\(/.test(line)) hits.push({ kind: "env-dump", line: n, detail: "Deno.env.toObject()" });
    const destructure = /\{([^}]*)\}\s*=\s*process\s*\.\s*env\b/.exec(line);
    if (destructure) {
      for (const part of destructure[1]!.split(",")) {
        const name = part.split(":")[0]!.split("=")[0]!.trim();
        if (/^[A-Za-z_]\w*$/.test(name)) hits.push({ kind: "env", line: n, detail: "process.env", value: name });
      }
    } else {
      for (const m of line.matchAll(/\bprocess\s*\.\s*env\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*(["'`])([A-Za-z_]\w*)\2\s*\])/g)) {
        hits.push({ kind: "env", line: n, detail: "process.env", value: m[1] ?? m[3]! });
      }
      if (/\bprocess\s*\.\s*env\s*\[\s*(?!["'`][A-Za-z_]\w*["'`]\s*\])/.test(line)) hits.push({ kind: "env", line: n, detail: "process.env[...]" });
      if (/\bprocess\s*\.\s*env\b(?!\s*[.[])/.test(line)) hits.push({ kind: "env-dump", line: n, detail: "reads all of process.env" });
    }

    // Remote and dynamic imports.
    if (/\bimport\s*\(\s*["'`](?:https?:)?\/\/|\bfrom\s*["'`](?:https?:)?\/\/|^\s*import\s*["'`](?:https?:)?\/\/|\brequire\s*\(\s*["'`]https?:\/\//.test(line))
      hits.push({ kind: "remote-code", line: n, detail: "imports code from a URL" });
    else if (/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'`](?:npm|jsr):/.test(line))
      hits.push({ kind: "package-import", line: n, detail: "imports an npm:/jsr: package (downloaded at run time)" });
    if (/\bimport\s*\(\s*(?!["'`])[^)]/.test(line) || /\brequire\s*\(\s*(?!["'`])[A-Za-z_$]/.test(line))
      hits.push({ kind: "dynamic-import", line: n, detail: "imports a module from a computed name" });
  });
  // An import with no call we recognise still means the file can touch files / start programs.
  if (fsImported && fsCalls === 0) hits.push({ kind: "read", line: importLine(lines, JS_FS_IMPORT), detail: "imports node:fs" });
  if (cpImported && cpCalls === 0) hits.push({ kind: "exec", line: importLine(lines, JS_CP_IMPORT), detail: "imports child_process" });
  return hits;
}

function importLine(lines: string[], re: RegExp): number {
  const i = lines.findIndex((l) => re.test(l));
  return i === -1 ? 1 : i + 1;
}

function val(v: string | undefined, map?: (s: string) => string): { value?: string } {
  if (v === undefined || v === "") return {};
  return { value: map ? map(v) : v };
}

// ---------------------------------------------------------------- Python

function pyHits(lines: string[]): Hit[] {
  const hits: Hit[] = [];
  let subprocessImport = 0;
  let subprocessCalls = 0;
  const fromImport = /^\s*from\s+subprocess\s+import\b/m.test(lines.join("\n"));
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/(^|\s)#.*$/, "$1");
    if (/^\s*(?:import|from)\s+(?:requests|urllib|urllib2|urllib3|httpx|socket|aiohttp|http\.client|httplib|ftplib|smtplib|telnetlib|paramiko|websocket|websockets|pycurl|xmlrpc)\b/.test(line))
      hits.push({ kind: "net", line: n, detail: "imports a network module" });
    if (/\b(?:requests|httpx|urllib\.request|urllib3|aiohttp)\s*\.\s*\w+\s*\(|\burlopen\s*\(|\bsocket\s*\.\s*(?:socket|create_connection)\s*\(/.test(line))
      hits.push({ kind: "net", line: n, detail: "network call" });

    for (const m of line.matchAll(/(?<![.\w])open\s*\(/g)) {
      const rest = line.slice(m.index);
      const write = /^open\s*\([^)]*?,\s*(?:mode\s*=\s*)?["'][rbt]*[wax+]/.test(rest);
      hits.push({ kind: write ? "write" : "read", line: n, detail: "open()", ...val(literalAfter(line, m.index + m[0].length - 1)) });
    }
    for (const m of line.matchAll(/\b(?:os\s*\.\s*(remove|unlink|rmdir|removedirs)|shutil\s*\.\s*(rmtree))\s*\(/g))
      hits.push({ kind: "delete", line: n, detail: `${m[1] ?? m[2]}()`, ...val(literalAfter(line, m.index + m[0].length - 1)) });
    for (const m of line.matchAll(/\b(?:shutil\s*\.\s*(copy|copy2|copyfile|copytree|move)|os\s*\.\s*(rename|replace|makedirs|mkdir|chmod|chown|symlink|link|truncate))\s*\(/g)) {
      const lit = literalAfter(line, m.index + m[0].length - 1);
      // For copy/move/rename the destination is the second argument.
      const second = /^\s*\(\s*(["'])(?:(?!\1).)*\1\s*,\s*(["'])((?:(?!\2).)*)\2/.exec(line.slice(m.index + m[0].length - 1));
      hits.push({ kind: "write", line: n, detail: `${m[1] ?? m[2]}()`, ...val(second?.[3] ?? lit) });
    }
    if (/\bos\s*\.\s*(?:listdir|scandir|walk|stat)\s*\(|\.\s*(?:read_text|read_bytes|iterdir|rglob)\s*\(/.test(line))
      hits.push({ kind: "read", line: n, detail: "reads files" });
    for (const m of line.matchAll(/(?:Path\s*\(\s*(["'])((?:(?!\1).)*)\1\s*\)\s*)?\.\s*(write_text|write_bytes|touch|unlink)\s*\(/g))
      hits.push({ kind: m[3] === "unlink" ? "delete" : "write", line: n, detail: `${m[3]}()`, ...val(m[2]) });

    if (/^\s*(?:import|from)\s+subprocess\b/.test(line) && !subprocessImport) subprocessImport = n;
    const spCall = fromImport
      ? /(?<![\w.])(?:subprocess\s*\.\s*)?(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)\s*\(/g
      : /\bsubprocess\s*\.\s*(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)\s*\(/g;
    for (const m of line.matchAll(spCall)) {
      subprocessCalls += 1;
      const lit = literalAfter(line, m.index + m[0].length - 1);
      hits.push({ kind: "exec", line: n, detail: `subprocess.${m[1]}()`, ...val(lit ? firstWord(lit) : undefined, exeName) });
    }
    for (const m of line.matchAll(/\bos\s*\.\s*(system|popen|exec\w*|spawn\w*|posix_spawn\w*)\s*\(/g)) {
      const lit = literalAfter(line, m.index + m[0].length - 1);
      hits.push({ kind: "exec", line: n, detail: `os.${m[1]}()`, ...val(lit ? firstWord(lit) : undefined, exeName) });
    }
    if (/\bpty\s*\.\s*spawn\s*\(/.test(line)) hits.push({ kind: "exec", line: n, detail: "pty.spawn()" });
    if (/(?<![.\w])(?:eval|exec|compile)\s*\(/.test(line)) hits.push({ kind: "eval", line: n, detail: "eval/exec/compile()" });
    if (/\b__import__\s*\(|\bimportlib\s*\.\s*import_module\s*\(/.test(line))
      hits.push({ kind: "dynamic-import", line: n, detail: "imports a module from a computed name" });
    if (/^\s*(?:import|from)\s+ctypes\b/.test(line)) hits.push({ kind: "native", line: n, detail: "imports ctypes" });

    let named = false;
    for (const m of line.matchAll(/\bos\s*\.\s*(?:environ\s*\[\s*(["'])([^"']+)\1\s*\]|(?:environ\s*\.\s*get|getenv)\s*\(\s*(["'])([^"']+)\3)/g)) {
      named = true;
      hits.push({ kind: "env", line: n, detail: "os.environ", value: m[2] ?? m[4]! });
    }
    if (!named && /\bos\s*\.\s*(?:getenv|environ\s*\.\s*get)\s*\(/.test(line)) hits.push({ kind: "env", line: n, detail: "os.getenv()" });
    else if (!named && /\bos\s*\.\s*environ\b(?!\s*(?:\[|\.\s*get\b))/.test(line))
      hits.push({ kind: "env-dump", line: n, detail: "reads all of os.environ" });
    if (/\bpip3?\s+install\b|\bpip\b["']?\s*,\s*["']install/.test(line))
      hits.push({ kind: "package-import", line: n, detail: "installs packages at run time" });
  });
  if (subprocessImport && subprocessCalls === 0) hits.push({ kind: "exec", line: subprocessImport, detail: "imports subprocess" });
  return hits;
}

// ------------------------------------------------------------------ shell

const SH_CMD = String.raw`(?:^|[|;&(\x60]|\$\(|\b(?:then|do|else|sudo|exec|nohup|time|xargs|command)\s+)\s*`;
const SH_NET = new RegExp(SH_CMD + String.raw`(curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|telnet|ftp|aria2c)(?=\s|$|;|\|)`, "g");
const SH_WRITE = new RegExp(SH_CMD + String.raw`(mv|cp|mkdir|touch|chmod|chown|ln|dd|tee|install|truncate)(?=\s)`, "g");
const SH_DELETE = new RegExp(SH_CMD + String.raw`(rm|rmdir|shred|unlink)(?=\s)`, "g");
const SH_INTERP = new RegExp(SH_CMD + String.raw`(bash|sh|zsh|dash|ksh|python3?|node|deno|perl|ruby|php|pwsh|powershell|osascript)(?=\s|$)`, "g");
const SH_PKG = new RegExp(SH_CMD + String.raw`(pip3?|npm|npx|yarn|pnpm|bunx|brew|apt-get|apt|gem|cargo|go)\s+(?:install|add|i|x|get|exec)?\b`, "g");
const SH_ENV_DUMP = new RegExp(SH_CMD + String.raw`(?:printenv|env|export\s+-p)\s*(?:$|[|;&>])`);

/** Arguments of the command that starts at `from`, up to the next | ; & or ). */
function shArgs(line: string, from: number): string[] {
  const seg = line.slice(from).split(/[|;&)]/)[0] ?? "";
  return seg
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((a) => a.replace(/^["']|["']$/g, ""));
}

function shPath(args: string[], which: "first" | "last"): string | undefined {
  const plain = args.filter((a) => a && !a.startsWith("-") && !/^[<>]/.test(a));
  const p = which === "first" ? plain[0] : plain[plain.length - 1];
  if (!p) return undefined;
  if (p.startsWith("of=")) return p.slice(3);
  return p.includes("$") || p.includes("`") ? undefined : p;
}

function shHits(lines: string[]): Hit[] {
  // `lines` come from stripComments(): comments and heredoc bodies are already blank.
  const hits: Hit[] = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    const netTools: string[] = [];
    for (const m of line.matchAll(SH_NET)) {
      netTools.push(m[1]!);
      hits.push({ kind: "net", line: n, detail: m[1]! });
      hits.push({ kind: "exec", line: n, detail: m[1]!, value: m[1]! });
    }
    if (/\/dev\/(?:tcp|udp)\//.test(line)) hits.push({ kind: "net", line: n, detail: "/dev/tcp socket" });
    for (const m of line.matchAll(SH_WRITE)) {
      const args = shArgs(line, m.index + m[0].length - m[1]!.length);
      const which = m[1] === "mkdir" || m[1] === "touch" || m[1] === "tee" || m[1] === "truncate" ? "first" : "last";
      hits.push({ kind: "write", line: n, detail: m[1]!, ...val(m[1] === "dd" ? args.find((a) => a.startsWith("of="))?.slice(3) : shPath(args, which)) });
    }
    for (const m of line.matchAll(SH_DELETE)) {
      const args = shArgs(line, m.index + m[0].length - m[1]!.length);
      hits.push({ kind: "delete", line: n, detail: m[1]!, ...val(shPath(args, "first")) });
    }
    if (!/\[\[|\(\(/.test(line)) {
      for (const m of line.matchAll(/(?<![<>&\d=-])(>>?)\s*(?!&)([^\s;&|<>()]+)/g)) {
        const target = m[2]!.replace(/^["']|["']$/g, "");
        if (/^\/dev\/(?:null|stderr|stdout|tty|fd\/\d)$/.test(target)) continue;
        hits.push({ kind: "write", line: n, detail: `${m[1]} redirection`, ...val(target.includes("$") ? undefined : target) });
      }
    }
    for (const m of line.matchAll(/\$\((?!\()\s*([A-Za-z0-9_./-]+)/g)) hits.push({ kind: "exec", line: n, detail: "$(...)", value: exeName(m[1]!) });
    for (const m of line.matchAll(/`\s*([A-Za-z0-9_./-]+)[^`]*`/g)) hits.push({ kind: "exec", line: n, detail: "backticks", value: exeName(m[1]!) });
    for (const m of line.matchAll(SH_INTERP)) hits.push({ kind: "exec", line: n, detail: m[1]!, value: m[1]! });
    const piped = /\|\s*(?:sudo\s+)?(?:\/usr\/bin\/env\s+)?(sh|bash|zsh|dash|ksh|python3?|perl|ruby|node|deno|pwsh|powershell)\b/.exec(line);
    if (piped) {
      if (!hits.some((h) => h.kind === "exec" && h.line === n && h.value === piped[1]))
        hits.push({ kind: "exec", line: n, detail: `| ${piped[1]}`, value: piped[1]! });
      if (netTools.length || /\b(?:curl|wget)\b/.test(line)) hits.push({ kind: "remote-code", line: n, detail: "pipes a download into a shell" });
    }
    if (/(?:source|\.|bash|sh|zsh)\s+<\(\s*(?:curl|wget)\b/.test(line)) hits.push({ kind: "remote-code", line: n, detail: "runs a downloaded script" });
    if (/(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)eval\s/.test(line)) hits.push({ kind: "eval", line: n, detail: "eval" });
    for (const m of line.matchAll(SH_PKG)) {
      hits.push({ kind: "package-import", line: n, detail: `${m[1]} downloads packages` });
      hits.push({ kind: "exec", line: n, detail: m[1]!, value: m[1]! });
    }
    if (SH_ENV_DUMP.test(line)) hits.push({ kind: "env-dump", line: n, detail: "prints every environment variable" });
    for (const m of line.matchAll(/\$\{?([A-Z][A-Z0-9_]{3,})\}?/g))
      if (isSecretName(m[1]!)) hits.push({ kind: "env", line: n, detail: `$${m[1]}`, value: m[1]! });
  });
  return hits;
}

// ------------------------------------------------------------- PowerShell

function psPathArg(line: string, from: number): string | undefined {
  const m = /^\s+(?:-(?:Path|LiteralPath|FilePath|Destination)\s+)?(["']?)([^\s"'|;]+)\1/i.exec(line.slice(from));
  if (!m) return undefined;
  const p = m[2]!;
  return p.startsWith("$") || p.startsWith("-") ? undefined : p;
}

function psHits(lines: string[]): Hit[] {
  const hits: Hit[] = [];
  lines.forEach((line, i) => {
    const n = i + 1;
    const net =
      /\b(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Send-MailMessage|Test-NetConnection)\b/i.test(line) ||
      /(?:^|[|;(=]\s*)(?:iwr|irm|curl|wget)\b/i.test(line) ||
      /\bNet\.WebClient\b|\bSystem\.Net\.(?:WebClient|Http|Sockets|WebRequest)|\[Net\.(?:WebClient|Sockets)/i.test(line);
    if (net) hits.push({ kind: "net", line: n, detail: "PowerShell web request" });
    if (/\b(?:Invoke-Expression|iex)\b/i.test(line)) {
      hits.push({ kind: "eval", line: n, detail: "Invoke-Expression" });
      if (net) hits.push({ kind: "remote-code", line: n, detail: "runs downloaded code" });
    }
    if (/\s-e(?:nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}/i.test(line)) hits.push({ kind: "eval", line: n, detail: "-EncodedCommand" }, { kind: "decoder", line: n, detail: "encoded command" });
    for (const m of line.matchAll(/\bStart-Process\b/gi))
      hits.push({ kind: "exec", line: n, detail: "Start-Process", ...val(psPathArg(line, m.index + m[0].length), exeName) });
    for (const m of line.matchAll(/(?:^|[;|]\s*)&\s*(["']?)([A-Za-z0-9_.\\/:-]+)\1/g)) hits.push({ kind: "exec", line: n, detail: "& call", value: exeName(m[2]!) });
    if (/\bInvoke-Command\b/i.test(line)) hits.push({ kind: "exec", line: n, detail: "Invoke-Command" });
    for (const m of line.matchAll(/\b(Get-Content|Import-Csv|Import-Clixml|Get-ChildItem|Select-String)\b/gi))
      if (!/^\s+env:/i.test(line.slice(m.index + m[0].length)))
        hits.push({ kind: "read", line: n, detail: m[1]!, ...val(psPathArg(line, m.index + m[0].length)) });
    for (const m of line.matchAll(/\b(Set-Content|Add-Content|Out-File|Export-Csv|New-Item|Copy-Item|Move-Item|Rename-Item|Clear-Content|Tee-Object)\b/gi)) {
      let p = psPathArg(line, m.index + m[0].length);
      if (/^(?:Copy|Move)-Item$/i.test(m[1]!)) {
        const dest = /-Destination\s+(["']?)([^\s"'|;]+)\1/i.exec(line);
        if (dest) p = dest[2]!.startsWith("$") ? undefined : dest[2];
      }
      hits.push({ kind: "write", line: n, detail: m[1]!, ...val(p) });
    }
    for (const m of line.matchAll(/\bRemove-Item\b/gi)) hits.push({ kind: "delete", line: n, detail: "Remove-Item", ...val(psPathArg(line, m.index + m[0].length)) });
    for (const m of line.matchAll(/\[(?:System\.)?IO\.File\]::(\w+)\s*\(/gi)) {
      const op = m[1]!;
      const kind = /^Delete$/i.test(op) ? "delete" : /^(?:Write|Append|Copy|Move|Create|Replace)/i.test(op) ? "write" : "read";
      hits.push({ kind, line: n, detail: `[IO.File]::${op}`, ...val(literalAfter(line, m.index + m[0].length - 1)) });
    }
    for (const m of line.matchAll(/\$env:([A-Za-z_]\w*)/gi)) hits.push({ kind: "env", line: n, detail: "$env:", value: m[1]! });
    for (const m of line.matchAll(/\[(?:System\.)?Environment\]::GetEnvironmentVariable\(\s*(["'])([^"']+)\1/gi))
      hits.push({ kind: "env", line: n, detail: "GetEnvironmentVariable", value: m[2]! });
    if (/\b(?:Get-ChildItem|gci|dir|ls)\s+env:|GetEnvironmentVariables\s*\(/i.test(line))
      hits.push({ kind: "env-dump", line: n, detail: "lists every environment variable" });
  });
  return hits;
}

/**
 * Blank out comments (keeping strings and line breaks), so a comment that
 * mentions fetch() or a URL is not mistaken for code. JS-style for js/other,
 * "#" for Python; shell and PowerShell comments are skipped by their detectors.
 */
export function stripComments(text: string, lang: Lang): string {
  if (lang === "sh" || lang === "ps") return stripShellComments(text, lang);
  const js = lang === "js" || lang === "other";
  const py = lang === "py";
  let out = "";
  let i = 0;
  let state: "code" | "str" | "line" | "block" = "code";
  let quote = "";
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < text.length) {
    const ch = text[i]!;
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (state === "code") {
      if (js && two === "//") {
        state = "line";
        out += "  ";
        i += 2;
      } else if (js && two === "/*") {
        state = "block";
        out += "  ";
        i += 2;
      } else if (py && ch === "#") {
        state = "line";
        out += " ";
        i += 1;
      } else if (py && (three === '"""' || three === "'''")) {
        state = "str";
        quote = three;
        out += three;
        i += 3;
      } else if (ch === '"' || ch === "'" || (js && ch === "`")) {
        state = "str";
        quote = ch;
        out += ch;
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    } else if (state === "str") {
      if (ch === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (text.startsWith(quote, i)) {
        out += quote;
        i += quote.length;
        state = "code";
      } else {
        // An unterminated single-line string ends at the line break.
        if (ch === "\n" && quote.length === 1 && quote !== "`") state = "code";
        out += ch;
        i += 1;
      }
    } else if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += "\n";
      } else out += " ";
      i += 1;
    } else {
      if (two === "*/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += blank(ch);
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Shell / PowerShell: blank "#" comments (and PowerShell <# #> blocks) and
 * heredoc bodies, which are data rather than commands. Line numbers are kept.
 */
function stripShellComments(text: string, lang: "sh" | "ps"): string {
  let heredoc: string | undefined;
  let block = false;
  return text
    .split("\n")
    .map((line) => {
      if (heredoc !== undefined) {
        if (line.trim() === heredoc) heredoc = undefined;
        return "";
      }
      if (lang === "ps") {
        if (block) {
          const end = line.indexOf("#>");
          if (end === -1) return "";
          block = false;
          line = line.slice(end + 2);
        }
        const start = line.indexOf("<#");
        if (start !== -1) {
          const end = line.indexOf("#>", start + 2);
          if (end === -1) {
            block = true;
            line = line.slice(0, start);
          } else line = line.slice(0, start) + line.slice(end + 2);
        }
      }
      if (/^\s*#/.test(line)) return "";
      const code = line.replace(/(^|\s)#.*$/, "$1");
      const hd = lang === "sh" ? /<<-?\s*["']?([A-Za-z_]\w*)["']?/.exec(code) : null;
      if (hd) heredoc = hd[1];
      return code;
    })
    .join("\n");
}

/** All hits for a code file in `lang`. */
export function detectCode(raw: string, lang: Lang): Hit[] {
  const text = stripComments(raw, lang);
  const lines = text.split("\n");
  const hits = detectCommon(lines);
  if (lang === "js" || lang === "other") hits.push(...jsHits(lines, text));
  if (lang === "py" || lang === "other") hits.push(...pyHits(lines));
  if (lang === "sh") hits.push(...shHits(lines));
  if (lang === "ps") hits.push(...psHits(lines));
  return hits;
}

/** Language for a file path (and its first line, for shebangs). Undefined: not code. */
export function codeLang(path: string, firstLine: string): Lang | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return "js";
    case "py":
    case "pyw":
      return "py";
    case "sh":
    case "bash":
    case "zsh":
    case "ksh":
    case "command":
    case "bat":
    case "cmd":
      return "sh";
    case "ps1":
    case "psm1":
    case "psd1":
      return "ps";
    case "rb":
    case "pl":
    case "pm":
    case "php":
    case "lua":
    case "go":
    case "rs":
    case "java":
    case "kt":
    case "swift":
    case "cs":
    case "c":
    case "cc":
    case "cpp":
    case "r":
    case "applescript":
    case "scpt":
      return "other";
  }
  {
    const sb = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\S*\/)?(\S+)/.exec(firstLine);
    if (sb) {
      const interp = sb[1]!;
      if (/^(?:ba|z|k|da)?sh$/.test(interp)) return "sh";
      if (/^python/.test(interp)) return "py";
      if (/^(?:node|deno|bun|tsx|ts-node)$/.test(interp)) return "js";
      if (/^pwsh|powershell/.test(interp)) return "ps";
      return "other";
    }
  }
  return undefined;
}

/** Map a Markdown fence info string to a language. */
export function fenceLang(info: string): Lang | undefined {
  const l = info.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (/^(?:js|javascript|ts|typescript|jsx|tsx|mjs|deno|node)$/.test(l)) return "js";
  if (/^(?:py|python|python3)$/.test(l)) return "py";
  if (/^(?:sh|bash|shell|zsh|console|terminal|shellsession)$/.test(l)) return "sh";
  if (/^(?:ps|ps1|powershell|pwsh)$/.test(l)) return "ps";
  if (l === "") return undefined;
  return undefined;
}

// --------------------------------------------------- Markdown / prompt text

export interface InjectionHit {
  line: number;
  what: string;
  /** "strong" findings block in docs; "weak" ones warn. */
  strength: "strong" | "weak";
}

const NEGATION = /\b(?:never|not|don't|dont|do\s+not|must\s+not|mustn't|cannot|can't|no|avoid|refuse|without)\b/i;

interface InjectionRule {
  re: RegExp;
  what: string;
  strength: "strong" | "weak";
  /** Skip when the sentence before the match negates it ("never ... without approval"). */
  negatable: boolean;
  /** Upgrade weak to strong when the sentence also names a destination (URL, email, IP). */
  destinationUpgrades?: boolean;
}

const INJECTION_RULES: readonly InjectionRule[] = [
  {
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|of\s+|my\s+)*(?:previous|prior|above|earlier|preceding|original|system|developer|safety|other)\s+(?:instructions?|prompts?|messages?|rules|directions|guidelines|context|constraints)\b/i,
    what: "tells the model to ignore its instructions",
    strength: "strong",
    negatable: true,
  },
  {
    re: /\b(?:ignore|disregard|forget)\s+(?:everything|all)\s+(?:you\s+(?:were|have\s+been)\s+told|above|before\s+this)\b/i,
    what: "tells the model to ignore its instructions",
    strength: "strong",
    negatable: true,
  },
  {
    re: /\byou\s+are\s+(?:now\s+)?(?:in\s+)?(?:developer|god|jailbreak|dan|unrestricted|unfiltered)\s+mode\b|\byou\s+are\s+no\s+longer\s+bound\b|\bact\s+as\s+an?\s+(?:unrestricted|unfiltered|jailbroken)\b/i,
    what: "tries to jailbreak the model",
    strength: "strong",
    negatable: false,
  },
  {
    re: /<\|im_start\|>|<\|(?:system|endoftext|im_end)\|>|^\s*(?:\[system\]|<\/?system>|###\s*system\s*:)|^\s*(?:new\s+)?system\s+(?:prompt|instructions?)\s*:/im,
    what: "pretends to be a system message",
    strength: "strong",
    negatable: false,
  },
  {
    re: /\bwithout\s+(?:telling|informing|alerting|notifying|asking)\s+the\s+(?:user|person|human|operator)\b|\b(?:hide|conceal)\s+(?:this|it|these|that|them|the\s+\w+)\s+from\s+the\s+(?:user|person|human)\b|\bwithout\s+(?:the\s+user's|their)\s+knowledge\b|\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|notify)\s+the\s+(?:user|person|human)\s+(?:about|of|that)\b|\bsecretly\b|\bsilently\s+(?:send|upload|post|forward|copy|email|delete|run|execute|install)\b/i,
    what: "asks the model to hide actions from the person",
    strength: "strong",
    negatable: false,
  },
  {
    re: /\b(?:reveal|print|output|show|display|disclose|repeat|dump|share|leak)\s+(?:me\s+)?(?:your|the|all|any)?\s*(?:system\s+prompt|hidden\s+instructions|initial\s+instructions|original\s+instructions)\b/i,
    what: "asks the model to reveal its instructions",
    strength: "strong",
    negatable: true,
  },
  {
    re: /\b(?:reveal|print|output|show|display|disclose|dump|share|leak)\s+(?:me\s+)?(?:your|the|all|any)?\s*(?:api[\s_-]?keys?|secrets?|credentials|private\s+keys?|access\s+tokens?|environment\s+variables)\b/i,
    what: "asks the model to reveal keys or secrets",
    strength: "weak",
    negatable: true,
    destinationUpgrades: true,
  },
  {
    re: /\b(?:send|post|upload|forward|transmit|email|leak|copy|paste)\b[^.]{0,100}?(?:api[\s_-]?keys?|access[\s_-]?tokens?|auth[\s_-]?tokens?|session[\s_-]?tokens?|credentials?|private[\s_-]?keys?|ssh[\s_-]?keys?|\.ssh\b|id_rsa|\.env\b|cookies|keychain|secrets?\b|system\s+prompt)/i,
    what: "tells the model to send keys, secrets or credentials somewhere",
    strength: "weak",
    negatable: true,
    destinationUpgrades: true,
  },
  {
    re: /\bexfiltrat\w*/i,
    what: "talks about exfiltrating data",
    strength: "strong",
    negatable: true,
  },
  {
    re: /\b(?:without|skip(?:ping)?|bypass(?:ing)?|no\s+need\s+(?:for|to\s+ask\s+for))\s+(?:asking\s+(?:for\s+)?|the\s+(?:user'?s?|person'?s?)\s+|any\s+|an?\s+)?(?:approval|confirmation|permission|consent)\b/i,
    what: "tells the model to skip the person's approval",
    strength: "strong",
    negatable: true,
  },
];

const DESTINATION = /\bhttps?:\/\/|\b[\w.+-]+@[\w-]+\.[\w.-]+\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|\battacker\b/i;

function sentenceAround(text: string, index: number, length: number): { before: string; sentence: string } {
  const head = text.slice(0, index);
  const brk = Math.max(...[". ", "! ", "? ", ".\n", "!\n", "?\n"].map((p) => head.lastIndexOf(p)));
  const start = brk === -1 ? 0 : brk + 2;
  const endRel = text.slice(index + length).search(/[.!?](?:\s|$)/);
  const end = endRel === -1 ? text.length : index + length + endRel;
  return { before: text.slice(start, index), sentence: text.slice(start, end) };
}

/**
 * Prompt-injection phrases in `text` (any file the model may read). Matched
 * per paragraph, so a sentence wrapped over several lines is still one sentence.
 */
export function detectInjection(text: string): InjectionHit[] {
  const out: InjectionHit[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim()) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i]!.trim()) i += 1;
    const para = lines.slice(start, i).join("\n");
    for (const rule of INJECTION_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
      for (const m of para.matchAll(re)) {
        const { before, sentence } = sentenceAround(para, m.index, m[0].length);
        if (rule.negatable && NEGATION.test(before)) continue;
        let strength = rule.strength;
        if (rule.destinationUpgrades && (DESTINATION.test(sentence) || CREDENTIAL_PATTERNS.some((c) => c.re.test(sentence)))) strength = "strong";
        const line = start + 1 + (para.slice(0, m.index).match(/\n/g)?.length ?? 0);
        if (!out.some((o) => o.line === line && o.what === rule.what)) out.push({ line, what: rule.what, strength });
      }
    }
  }
  return out;
}

export interface HiddenCharHit {
  line: number;
  severity: "block" | "warn";
  what: string;
}

const PICTO = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️⃣]/u;

/** Zero-width, bidi-control and tag characters (hidden text, "Trojan Source"). */
export function detectHiddenChars(text: string): HiddenCharHit[] {
  const out: HiddenCharHit[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const cps = Array.from(line);
    const found = new Map<string, "block" | "warn">();
    cps.forEach((ch, k) => {
      const cp = ch.codePointAt(0)!;
      const prev = cps[k - 1] ?? "";
      const next = cps[k + 1] ?? "";
      if (cp === 0xfeff && i === 0 && k === 0) return; // byte-order mark
      if (cp === 0x200d && (PICTO.test(prev) || PICTO.test(next))) return; // emoji joiner
      if (cp === 0x200c && /\p{L}/u.test(prev) && /\p{L}/u.test(next) && !/\p{Script=Latin}/u.test(prev + next)) return;
      if ((cp >= 0x200b && cp <= 0x200d) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff || cp === 0x180e)
        found.set("zero-width characters (hidden text)", "block");
      else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069))
        found.set("bidirectional control characters (text that reads differently than it runs)", "block");
      else if (cp >= 0xe0000 && cp <= 0xe007f) found.set("Unicode tag characters (invisible ASCII smuggling)", "block");
      else if (cp >= 0xe0100 && cp <= 0xe01ef) found.set("variation-selector characters used to hide data", "block");
      else if (cp === 0x200e || cp === 0x200f || cp === 0x061c || cp === 0x00ad)
        found.set("invisible direction marks or soft hyphens", "warn");
    });
    for (const [what, severity] of found) out.push({ line: i + 1, severity, what });
  });
  return out;
}

export interface CommentHit {
  line: number;
  severity: "block" | "warn" | "info";
  what: string;
}

const HARMLESS_COMMENT = /^\s*(?:TODO|FIXME|NOTE|XXX|markdownlint|prettier|toc|end\s*toc|eslint|lint|region|endregion|cspell|vale|omit|more|BEGIN|END)\b/i;
const DIRECTIVE = /\b(?:assistant|claude|ai|model|agent|llm|chatgpt|gpt|you\s+(?:must|should|will|are|need)|always|never|instructions?|ignore|execute|run|send|email|upload|delete|fetch|call|reveal|download|install|tell)\b/i;

/** HTML comments in Markdown: the person never sees them, the model does. */
export function detectHtmlComments(text: string): CommentHit[] {
  const out: CommentHit[] = [];
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    const body = m[1]!.trim();
    const line = text.slice(0, m.index).split("\n").length;
    const words = body.split(/\s+/).filter(Boolean).length;
    if (!body || HARMLESS_COMMENT.test(body)) {
      out.push({ line, severity: "info", what: "HTML comment (tooling marker)" });
      continue;
    }
    if (detectInjection(body).length) out.push({ line, severity: "block", what: "hidden instruction in an HTML comment (prompt injection)" });
    else if (DIRECTIVE.test(body) && words >= 5) out.push({ line, severity: "block", what: "hidden instruction to the model in an HTML comment" });
    else if (words >= 12) out.push({ line, severity: "warn", what: "long HTML comment: hidden text the person does not see but the model reads" });
    else out.push({ line, severity: "info", what: "short HTML comment" });
  }
  return out;
}

export const HIDDEN_CSS = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|<[a-z]+\b[^>]*\shidden(?=[\s>=])/i;
