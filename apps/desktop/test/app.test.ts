import { describe, expect, it } from "vitest";
import { startApp } from "../src/app";
import type { KeyStatus } from "../src/protocol";
import type { Transport } from "../src/transport";

/** In-memory shell: records calls, answers a few commands, lets the test push events. */
function memoryShell() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  let stored = false;
  let daemonStatus: KeyStatus["daemon"] = { state: "running", restarts: 0, pid: 1, version: "t", lastError: null, description: "memory" };
  const status = (): KeyStatus => ({
    keychain: { available: true, message: null },
    providers: [
      { provider: "anthropic", stored, active: stored, baseUrl: null },
      { provider: "openai", stored: false, active: false, baseUrl: null },
    ],
    daemon: daemonStatus,
  });
  const daemon: Record<string, (p: Record<string, unknown>) => unknown> = {
    "models.list": () => ({ models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "frontier" }] }),
    "skills.list": () => ({ skills: [] }),
    "harness.approve": () => ({ ok: true }),
    "harness.run": () => ({ runId: "run-1" }),
  };
  const transport: Transport = {
    kind: "memory",
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      calls.push(args === undefined ? { cmd } : { cmd, args });
      if (cmd === "key_status") return status() as T;
      if (cmd === "key_save") {
        stored = true;
        return status() as T;
      }
      if (cmd === "daemon_call") {
        const fn = daemon[args!["method"] as string];
        if (!fn) throw { code: -32601, message: "not found" };
        return fn((args!["params"] ?? {}) as Record<string, unknown>) as T;
      }
      return null as T;
    },
    async listen<T>(event: string, handler: (p: T) => void) {
      const list = listeners.get(event) ?? [];
      list.push(handler as (p: unknown) => void);
      listeners.set(event, list);
      return () => {};
    },
    close() {},
  };
  const emit = (event: string, payload: unknown) => {
    if (event === "daemon://status") daemonStatus = payload as KeyStatus["daemon"];
    (listeners.get(event) ?? []).forEach((h) => h(payload));
  };
  return { transport, calls, emit };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("app shell", () => {
  it("first run goes to setup; saving a key sends key_save and shows the status", async () => {
    location.hash = "";
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const shell = memoryShell();
    await startApp(root, shell.transport);
    await tick();
    expect(location.hash).toBe("#/setup");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await tick();
    expect(root.querySelector("h1")?.textContent).toBe("Connect a model");
    const key = root.querySelector('input[name="api-key"]') as HTMLInputElement;
    key.value = "sk-ant-test-0123456789";
    (root.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    await tick();
    expect(shell.calls.find((c) => c.cmd === "key_save")?.args).toEqual({ provider: "anthropic", apiKey: "sk-ant-test-0123456789", baseUrl: null });
    expect(key.value).toBe(""); // the key does not stay in the page
    expect(root.textContent).toContain("Claude key saved in your keychain and ready to use.");
    expect(root.querySelector('tr[data-provider="anthropic"]')?.textContent).toContain("Saved");
  });

  it("shows an approval dialog for any run and answers with harness.approve", async () => {
    location.hash = "#/run";
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const shell = memoryShell();
    // Pretend a key exists so the app opens on Run.
    shell.calls.length = 0;
    const { store } = await startApp(root, shell.transport);
    store.setKeyStatus({
      keychain: { available: true, message: null },
      providers: [{ provider: "anthropic", stored: true, active: true, baseUrl: null }],
      daemon: null,
    });
    shell.emit("daemon://notification", {
      method: "harness.event",
      params: {
        runId: "bg-1",
        event: { type: "approval_request", approvalId: "ap-9", call: { id: "c", name: "email_send", input: { to: "x@y.z" } }, effects: ["send"], summary: "Send an email to x@y.z" },
      },
    });
    await tick();
    const dialog = document.querySelector("dialog.approval-dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("Send an email to x@y.z");
    expect(dialog.textContent).toContain("background run");
    (dialog.querySelector('textarea[name="approval-note"]') as HTMLTextAreaElement).value = "wait until Friday";
    const deny = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Deny")!;
    deny.click();
    await tick();
    await tick();
    const approve = shell.calls.find((c) => c.cmd === "daemon_call" && c.args?.["method"] === "harness.approve");
    expect(approve?.args?.["params"]).toEqual({ approvalId: "ap-9", approved: false, note: "wait until Friday" });
    expect(dialog.open).toBe(false);
    expect(store.pendingApprovals()).toEqual([]);
  });

  it("reflects daemon status in a banner", async () => {
    location.hash = "#/run";
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const shell = memoryShell();
    await startApp(root, shell.transport);
    await tick();
    shell.emit("daemon://status", { state: "restarting", restarts: 1, pid: null, version: null, lastError: "daemon exited (3)", description: "d" });
    await tick();
    const banner = root.querySelector(".banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("restarting");
  });
});
