// The shell surface the UI talks to: Tauri commands (Rust core) or the dev bridge.
// Daemon methods go through `daemon_call`; the shell enforces the same allowlist.

import type { DaemonMethod, DaemonMethods, DaemonNotifications, ProviderId } from "@oneseat/contracts";

/** Daemon methods the main window may call. Mirrors src-tauri/src/allowlist.rs and dev/protocol.mjs. */
export const UI_METHODS = [
  "daemon.hello",
  "auth.clear",
  "auth.status",
  "models.list",
  "harness.run",
  "harness.cancel",
  "harness.approve",
  "skills.list",
  "skills.inspect",
  "skills.install",
  "skills.remove",
  "apps.pin",
  "apps.list",
  "apps.unpin",
  "schedules.list",
  "schedules.upsert",
  "schedules.remove",
  "actions.log",
] as const satisfies readonly DaemonMethod[];

/** Only the Rust core calls these: keys go through key_save, apps.run through bridge_run. */
export const SHELL_ONLY_METHODS = ["auth.set", "apps.run"] as const satisfies readonly DaemonMethod[];

export type UiMethod = (typeof UI_METHODS)[number];

// Compile-time check: every DaemonMethod is either UI-callable or shell-only.
type Missing = Exclude<DaemonMethod, UiMethod | (typeof SHELL_ONLY_METHODS)[number]>;
const _exhaustive: [Missing] extends [never] ? true : Missing = true;
void _exhaustive;

export function isUiMethod(m: string): m is UiMethod {
  return (UI_METHODS as readonly string[]).includes(m);
}

export type Params<M extends DaemonMethod> = DaemonMethods[M]["params"];
export type Result<M extends DaemonMethod> = DaemonMethods[M]["result"];

/** Shell commands (Tauri `invoke` names). */
export const COMMANDS = ["daemon_call", "daemon_status", "key_save", "key_delete", "key_status", "pin_open", "app_export"] as const;
export type Command = (typeof COMMANDS)[number];

/** Events the shell sends to the main window. */
export const EVENT_NOTIFICATION = "daemon://notification";
export const EVENT_STATUS = "daemon://status";

export type DaemonNotification = {
  [N in keyof DaemonNotifications]: { method: N; params: DaemonNotifications[N] };
}[keyof DaemonNotifications];

export type DaemonState = "starting" | "running" | "restarting" | "failed" | "stopped";

export interface DaemonStatus {
  state: DaemonState;
  restarts: number;
  pid: number | null;
  version: string | null;
  lastError: string | null;
  description: string;
}

export interface ProviderKeyStatus {
  provider: ProviderId;
  /** A key is in the OS keychain (or bridge memory in dev). */
  stored: boolean;
  /** The daemon holds a key (null when the daemon did not answer). */
  active: boolean | null;
  baseUrl: string | null;
}

export interface KeyStatus {
  keychain: { available: boolean; message: string | null };
  providers: ProviderKeyStatus[];
  daemon: DaemonStatus | null;
}

export interface ExportResult {
  dir: string;
  command: string;
}

/** Returned by the dev bridge (browser mode) so the UI can open the page in a tab. Tauri returns null. */
export interface PinOpenResult {
  url?: string;
}

/** Error codes. RPC_ERRORS from contracts plus shell-side codes (see src-tauri/src/rpc.rs). */
export const SHELL_ERRORS = {
  daemonUnavailable: -32010,
  timeout: -32011,
  forbidden: -32012,
  keychain: -32013,
} as const;
