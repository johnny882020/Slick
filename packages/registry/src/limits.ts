/** Total bytes of file content a source may hold (after decompression). */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** Files a source may hold. */
export const MAX_SOURCE_FILES = 2000;
/** Files larger than this in a skill get a lint warning. */
export const LARGE_FILE_BYTES = 1024 * 1024;
/** Deepest folder (root = 0) searched for SKILL.md files. */
export const MAX_DISCOVERY_DEPTH = 4;
/** Folders never searched or copied. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

export interface SourceLimits {
  maxBytes: number;
  maxFiles: number;
}

export const DEFAULT_LIMITS: SourceLimits = { maxBytes: MAX_SOURCE_BYTES, maxFiles: MAX_SOURCE_FILES };
