// @oneseat/registry: the SkillStore (install from a folder, GitHub or
// skills.sh; scan; lint; sign; version) plus the gate 3 / gate 4 checks.

export {
  createSkillStore,
  skillVersion,
  LOCK_FILE,
  SIGNING_KEY_FILE,
  type RegistryInstallResult,
  type RegistrySkillStore,
  type SkillStoreOptions,
} from "./store.js";
export { scanSkill, executableFormat, isBinary, hostAllowed, pathCovered } from "./scan.js";
export { lintSkill, lintDescription, lintEvalSuite, isSemver, EVALS_FILE, EVAL_CASES_EXPECTED, DESCRIPTION_MIN } from "./lint.js";
export {
  checkDir,
  combineLints,
  combineScans,
  inspectSource,
  unsafeReports,
  type InspectOptions,
  type InspectOutcome,
  type SkillCheck,
} from "./inspect.js";
export { describeSource, download, skillNameOf, stageSource, tarballUrl, type FetchLike, type StagedSource, type StageOptions } from "./sources.js";
export {
  parseSearchEntry,
  searchSkillsSh,
  skillsShSource,
  REGISTRY_HOSTS,
  SEARCH_LIMIT,
  SEARCH_MAX_BYTES,
  SEARCH_QUERY_MAX,
  SEARCH_TIMEOUT_MS,
  SKILLS_SH_URL,
  type SearchOptions,
  type SkillsShResult,
} from "./search.js";
export { checkArchivePath, extractTarGz, gunzipLimited, readTar, type TarFile, type TarOptions } from "./tar.js";
export { copyTree, discoverSkillDirs, loadSkillDir, writeSkill, type LoadedSkill, type SkillEntry } from "./files.js";
export { InstallSigner, hashDir, hashFiles, type HashInput } from "./integrity.js";
export { RegistryError, UnsafeSourceError, type RegistryErrorCode, type UnsafeEntry } from "./errors.js";
export {
  DEFAULT_LIMITS,
  LARGE_FILE_BYTES,
  MAX_DISCOVERY_DEPTH,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  type SourceLimits,
} from "./limits.js";
export {
  CREDENTIAL_PATTERNS,
  codeLang,
  detectCode,
  detectHiddenChars,
  detectHtmlComments,
  detectInjection,
  extractUrls,
  isSecretName,
  type Hit,
  type HitKind,
  type Lang,
} from "./detect.js";
export { main as runCli, formatLint, formatScan, parseArgs, resolveSourceArg } from "./cli.js";
