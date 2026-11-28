// Content hashing and the local install-signing key.
//
// contentHash = sha256 over every file, in sorted POSIX-path order, of
//   path NUL byteLength NUL bytes
// The byte length makes the stream unambiguous: two different file sets can
// never produce the same input (with plain "path NUL bytes" one file holding
// "a" + "b\0..." collides with two files). A symlink or special file in an
// installed folder is hashed as a marker, so adding one is detected.
//
// The signing key is a local integrity key (ed25519, PKCS#8 PEM, mode 0600).
// It proves that files have not changed since this machine installed them.
// It is not an API key and never leaves the machine.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { toPosix } from "./files.js";
import { RegistryError } from "./errors.js";

export interface HashInput {
  path: string;
  bytes: Uint8Array;
}

/** sha256 hex over sorted (path, length, bytes) triples. */
export function hashFiles(files: readonly HashInput[]): string {
  const h = createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    h.update(f.path, "utf8");
    h.update("\0");
    h.update(String(f.bytes.length));
    h.update("\0");
    h.update(f.bytes);
  }
  return h.digest("hex");
}

/** Hash an installed skill folder as it is on disk now. */
export async function hashDir(dir: string): Promise<string> {
  const files: HashInput[] = [];
  async function walk(abs: string): Promise<void> {
    for (const name of (await readdir(abs)).sort()) {
      const child = join(abs, name);
      const rel = toPosix(relative(dir, child));
      const st = await lstat(child);
      if (st.isDirectory()) await walk(child);
      else if (st.isFile()) files.push({ path: rel, bytes: new Uint8Array(await readFile(child)) });
      else if (st.isSymbolicLink()) files.push({ path: rel, bytes: new TextEncoder().encode(`\0symlink\0${await readlink(child)}`) });
      else files.push({ path: rel, bytes: new TextEncoder().encode("\0special\0") });
    }
  }
  await walk(dir);
  return hashFiles(files);
}

export class InstallSigner {
  private constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    readonly keyPath: string,
  ) {}

  /**
   * Load the key at `keyPath`, creating it (0600, folder 0700) when `create`
   * is true and it does not exist yet.
   */
  static async open(keyPath: string, opts: { create?: boolean } = {}): Promise<InstallSigner> {
    let pem: string | undefined;
    try {
      pem = await readFile(keyPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (pem === undefined) {
      if (!opts.create) throw new RegistryError("lockfile", `install signing key is missing (${keyPath})`);
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
      const { privateKey } = generateKeyPairSync("ed25519");
      const fresh = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      try {
        await writeFile(keyPath, fresh, { mode: 0o600, flag: "wx" });
        pem = fresh;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        pem = await readFile(keyPath, "utf8"); // another process created it first
      }
    }
    if (process.platform !== "win32") {
      const st = await stat(keyPath);
      if ((st.mode & 0o077) !== 0) await chmod(keyPath, 0o600);
    }
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(pem);
    } catch (e) {
      throw new RegistryError("lockfile", `install signing key is unreadable: ${(e as Error).message}`);
    }
    if (privateKey.asymmetricKeyType !== "ed25519") throw new RegistryError("lockfile", "install signing key is not an ed25519 key");
    return new InstallSigner(privateKey, createPublicKey(privateKey), keyPath);
  }

  /** Base64 ed25519 signature over the UTF-8 bytes of `contentHash`. */
  sign(contentHash: string): string {
    return sign(null, Buffer.from(contentHash, "utf8"), this.privateKey).toString("base64");
  }

  verify(contentHash: string, signature: string): boolean {
    try {
      return verify(null, Buffer.from(contentHash, "utf8"), this.publicKey, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: "spki", format: "pem" }).toString();
  }
}
