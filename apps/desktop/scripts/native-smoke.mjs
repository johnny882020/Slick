#!/usr/bin/env node
// Native smoke test of a pinned window's sandbox, in the real Tauri shell.
//
// Starts the debug build of the shell (cargo build first) with the fake daemon, a throwaway
// data dir holding dev/probe-app, and ONESEAT_DEV_OPEN_APP=probe. The probe page tries
// daemon_call, key_*, pin_open, plugins, remote/local fetch and a skill outside its
// allowedSkills, then reports through oneseat.run. The fake daemon logs that report to stderr,
// the shell logs daemon stderr, and this script checks it.
//
//   cargo build --manifest-path src-tauri/Cargo.toml && node scripts/native-smoke.mjs
//
// Linux without a display: runs under xvfb-run (and dbus-run-session) when available.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const exe = join(desktop, "src-tauri", "target", "debug", `oneseat-desktop${process.platform === "win32" ? ".exe" : ""}`);

/** Parse the probe report out of the shell's log output. */
export function findReport(log) {
  const m = log.match(/apps\.run app=probe skill=invoice-chaser input=(\{"probeReport".*)$/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1]).probeReport;
  } catch {
    return null;
  }
}

/** What a sandboxed page must see. Returns a list of problems (empty = pass). */
export function checkReport(r) {
  const problems = [];
  if (JSON.stringify(r.surface) !== '["run"]') problems.push(`window.oneseat exposes ${JSON.stringify(r.surface)}`);
  if (r.frozen !== true) problems.push("window.oneseat is not frozen");
  for (const k of ["daemonCall", "appsRunDirect", "keyStatus", "keySave", "pinOpen", "eventListen", "opener", "windowCreate"])
    if (r[k] !== "denied") problems.push(`${k} was ${r[k]}`);
  for (const k of ["fetchRemote", "fetchLocal"]) if (r[k] !== "blocked") problems.push(`${k} was ${r[k]}`);
  if (r.notAllowedSkill !== "refused") problems.push("a skill outside allowedSkills ran");
  return problems;
}

function have(cmd) {
  return spawnSync(cmd, ["--help"], { stdio: "ignore" }).error === undefined;
}

async function main() {
  if (!existsSync(exe)) {
    console.error(`missing ${exe}; run: cargo build --manifest-path src-tauri/Cargo.toml`);
    process.exit(2);
  }
  const data = mkdtempSync(join(tmpdir(), "oneseat-native-smoke-"));
  cpSync(join(desktop, "dev", "probe-app"), join(data, "apps", "probe"), { recursive: true });
  const env = {
    ...process.env,
    ONESEAT_DEV_DATA_DIR: data,
    ONESEAT_DEV_MEMORY_KEYSTORE: "1",
    ONESEAT_DEV_OPEN_APP: "probe",
    ONESEAT_DAEMON: join(desktop, "dev", "fake-daemon.mjs"),
  };
  let cmd = exe;
  let args = [];
  if (process.platform === "linux" && !process.env.DISPLAY && have("xvfb-run")) {
    cmd = "xvfb-run";
    args = have("dbus-run-session") ? ["-a", "dbus-run-session", "--", exe] : ["-a", exe];
  }
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let log = "";
  const onData = (d) => (log += d.toString());
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const deadline = Date.now() + 60_000;
  let report = null;
  while (Date.now() < deadline && !(report = findReport(log))) await new Promise((r) => setTimeout(r, 250));
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  rmSync(data, { recursive: true, force: true });
  if (!report) {
    console.error("no probe report within 60 s. Shell output:\n" + log.split("\n").filter((l) => l.includes("[")).slice(-40).join("\n"));
    process.exit(1);
  }
  const problems = checkReport(report);
  console.log(JSON.stringify(report, null, 2));
  if (problems.length) {
    console.error(`FAIL:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("native smoke: pinned window sandbox OK");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
