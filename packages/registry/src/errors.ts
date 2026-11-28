// Errors raised by the registry. Source-level failures (network, 404, no skill
// found) throw RegistryError. Unsafe content in a source (path traversal, a
// symlink that escapes, a device file) throws UnsafeSourceError, which the
// store turns into a "block" scan report so the person sees why.

export type RegistryErrorCode =
  | "bad-source"
  | "fetch-failed"
  | "too-large"
  | "too-many-files"
  | "no-skills"
  | "skill-not-found"
  | "duplicate-skill"
  | "not-installed"
  | "bad-path"
  | "unsafe-source"
  | "lockfile";

export class RegistryError extends Error {
  override name = "RegistryError";
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface UnsafeEntry {
  /** Path of the offending entry, as written in the source. */
  path: string;
  rule: string;
  message: string;
}

export class UnsafeSourceError extends RegistryError {
  override name = "UnsafeSourceError";
  constructor(readonly entries: UnsafeEntry[]) {
    super("unsafe-source", `unsafe source: ${entries.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  }
}
