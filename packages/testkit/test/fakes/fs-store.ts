// A disk-backed SkillStore built on the memory store: installs copy the folder into storeDir,
// so the conformance tamper check runs. The "no-traversal-check" bug reads any path.

import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledSkill, SkillStore } from "@oneseat/contracts";
import { createMemorySkillStore, hashSkillContents, readSkillFolder } from "../../src/index.js";

export function createFsStore(storeDir: string, bugs: ("no-traversal-check" | "install-blocked" | "index-bodies")[] = []): SkillStore {
  const mem = createMemorySkillStore();
  const dirs = new Map<string, { dir: string; hash: string }>();
  const withDir = (s: InstalledSkill | undefined) => (s && dirs.has(s.manifest.frontmatter.name) ? { ...s, manifest: { ...s.manifest, dir: dirs.get(s.manifest.frontmatter.name)!.dir } } : s);
  return {
    list: async () => (await mem.list()).map((s) => withDir(s)!),
    get: async (n) => withDir(await mem.get(n)),
    index: async () => (bugs.includes("index-bodies") ? (await mem.list()).map((s) => ({ name: s.manifest.frontmatter.name, description: s.manifest.frontmatter.description, body: s.manifest.body })) : mem.index()),
    async readFile(name, file) {
      if (bugs.includes("no-traversal-check") && dirs.has(name)) return readFile(join(dirs.get(name)!.dir, file), "utf8");
      return mem.readFile(name, file);
    },
    inspect: (s) => mem.inspect(s),
    async install(source, opts) {
      const r = await mem.install(source, opts);
      if (bugs.includes("install-blocked") && !r.installed && r.scan.verdict === "block") return { ...r, installed: true };
      if (r.installed && r.skill && source.kind === "local") {
        const name = r.skill.manifest.frontmatter.name;
        const dir = join(storeDir, name);
        await cp(source.path, dir, { recursive: true });
        dirs.set(name, { dir, hash: hashSkillContents((await readSkillFolder(dir)).contents) });
        return { ...r, skill: withDir(r.skill)! };
      }
      return r;
    },
    async remove(name) {
      dirs.delete(name);
      return mem.remove(name);
    },
    async verify(name) {
      const d = dirs.get(name);
      if (!d) return mem.verify(name);
      const now = hashSkillContents((await readSkillFolder(d.dir)).contents);
      return now === d.hash ? mem.verify(name) : { ok: false, reason: "installed files changed" };
    },
  };
}

