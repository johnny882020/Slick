import { describe, expect, it } from "vitest";
import { buildManifest, type Message } from "@oneseat/contracts";
import { fitContext } from "../src/context.js";
import { buildSystemPrompt, compactDescription, formatSkillIndex, renderSkill, SkillSession, toolMatches } from "../src/router.js";
import { MemorySkillStore, skillMd } from "./helpers.js";

describe("router", () => {
  it("formats a compact index, ~100 tokens per skill", () => {
    const long = "word ".repeat(300);
    const d = compactDescription(long);
    expect(d.length).toBeLessThanOrEqual(400);
    expect(d.endsWith("…")).toBe(true);
    expect(compactDescription("a\n  b")).toBe("a b");
    expect(compactDescription("x".repeat(500)).length).toBe(400);
    const idx = formatSkillIndex([
      { name: "a", description: "Does A." },
      { name: "b", description: long },
    ]);
    expect(idx.split("\n")).toHaveLength(2);
    expect(Math.ceil(idx.length / 4)).toBeLessThan(220);
  });

  it("builds the system prompt with index, active skills and reload hints", () => {
    const { manifest } = buildManifest({
      dir: "",
      skillMd: skillMd({ name: "s", description: "d", body: "BODY [t](t.md)", allowedTools: "db_query" }),
      permissionsJson: JSON.stringify({ effects: ["send"], scripts: { go: { file: "go.ts", description: "Goes" } } }),
      files: ["SKILL.md", "t.md", "go.ts"],
    });
    const rendered = renderSkill(manifest!);
    expect(rendered).toContain("- t.md");
    expect(rendered).toContain("- go: Goes");
    expect(rendered).toContain("This skill can send");
    expect(rendered).toContain("you may use: db_query");
    const now = new Date(2026, 10, 27);
    const p = buildSystemPrompt({ now, skillsEnabled: true, index: [{ name: "s", description: "d" }], active: [manifest!], reloadHints: ["old"] });
    expect(p).toContain("Today is Friday 2026-11-27.");
    expect(p).toContain("<skills>\n- s: d\n</skills>");
    expect(p).toContain("## Active skill");
    expect(p).toContain("loaded earlier in this conversation: old");
    const none = buildSystemPrompt({ now, skillsEnabled: false, index: [{ name: "s", description: "d" }], active: [], preamble: "P" });
    expect(none).toBe("P\n\nToday is Friday 2026-11-27.");
  });

  it("matches allowed-tools patterns", () => {
    expect(toolMatches("db_query", "db_query")).toBe(true);
    expect(toolMatches("memory_save", "memory_*")).toBe(true);
    expect(toolMatches("mcp__gmail__send", "mcp__gmail__*")).toBe(true);
    expect(toolMatches("mcp__gmailx__send", "mcp__gmail__*")).toBe(false);
    expect(toolMatches("Bash", "Bash(git:*)")).toBe(true);
    expect(toolMatches("db_query", "db.query")).toBe(false);
    expect(toolMatches("x", "()")).toBe(false);
  });

  it("SkillSession tracks loads, allowed skills and tool restrictions", async () => {
    const store = new MemorySkillStore();
    store.add({ name: "a", description: "A", allowedTools: "db_query" });
    store.add({ name: "b", description: "B", allowedTools: "memory_*" });
    store.add({ name: "c", description: "C" });
    const s = new SkillSession({ store, allowedSkills: ["a", "b", "c"], loaded: [{ name: "z", reason: "router" }] });
    expect(s.loaded).toEqual([]);
    expect((await s.index()).map((e) => e.name)).toEqual(["a", "b", "c"]);
    expect(await s.allowedToolPatterns()).toBeUndefined();
    expect(await s.toolAllowed("workspace_write")).toBe(true);
    expect(s.markLoaded("c", "router")).toBe(true);
    expect(await s.allowedToolPatterns()).toBeUndefined();
    s.markLoaded("a", "router");
    s.markLoaded("b", "router");
    expect(await s.allowedToolPatterns()).toEqual(["db_query", "memory_*"]);
    expect(await s.toolAllowed("memory_save")).toBe(true);
    expect(await s.toolAllowed("workspace_write")).toBe(false);
    expect(await s.toolAllowed("load_skill")).toBe(true);
    expect(s.markLoaded("a", "forced")).toBe(false);
    expect(s.loaded.find((l) => l.name === "a")!.reason).toBe("forced");
    expect(await s.manifest("missing")).toBeUndefined();

    const restricted = new SkillSession({ store, allowedSkills: ["a"] });
    expect(await restricted.manifest("b")).toBeUndefined();
    expect((await restricted.index()).map((e) => e.name)).toEqual(["a"]);
    const off = new SkillSession({ store, disabled: true });
    expect(await off.index()).toEqual([]);
    expect(off.isAllowed("a")).toBe(false);
  });
});

describe("fitContext", () => {
  const tools = [{ name: "t", description: "d", inputSchema: { type: "object" } }];
  const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
  const asst = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
  const call = (id: string, name = "t", input: Record<string, unknown> = {}): Message => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  });
  const result = (id: string, content: string, name = "t"): Message => ({
    role: "user",
    content: [{ type: "tool_result", toolUseId: id, name, content }],
  });

  it("returns the messages unchanged under budget", () => {
    const msgs = [user("hi")];
    const r = fitContext({ system: "s", messages: msgs, tools }, { budgetTokens: 1000 });
    expect(r.messages).toBe(msgs);
    expect(r.truncatedResults).toBe(0);
  });

  it("truncates old tool results first, keeping the latest and skill loads", () => {
    const big = "A".repeat(8000);
    const msgs = [
      user("q"),
      call("1", "load_skill", { name: "s" }),
      result("1", "S".repeat(8000), "load_skill"),
      call("2"),
      result("2", big),
      call("3"),
      result("3", big),
    ];
    const r = fitContext({ system: "s", messages: msgs, tools }, { budgetTokens: 4500 });
    expect(r.truncatedResults).toBe(1);
    expect(r.droppedMessages).toBe(0);
    const c = (i: number) => (r.messages[i]!.content[0] as { content: string }).content;
    expect(c(2)).toHaveLength(8000);
    expect(c(4)).toContain("[tool result truncated");
    expect(c(6)).toHaveLength(8000);
    // The original array is untouched.
    expect((msgs[4]!.content[0] as { content: string }).content).toHaveLength(8000);
  });

  it("drops whole earlier turns, then truncates skill loads, then drops old tool steps", () => {
    const msgs = [
      user("old " + "x".repeat(8000)),
      call("1", "load_skill", { name: "weekly" }),
      result("1", "W".repeat(400), "load_skill"),
      asst("old answer"),
      user("new question"),
      call("2"),
      result("2", "short"),
      call("3"),
      result("3", "y".repeat(3000)),
    ];
    const r = fitContext({ system: "s", messages: msgs, tools }, { budgetTokens: 900 });
    expect(r.droppedMessages).toBe(4);
    expect(r.droppedSkillLoads).toEqual(["weekly"]);
    expect(r.messages[0]!.role).toBe("user");
    expect((r.messages[0]!.content[0] as { text: string }).text).toContain("removed to fit");
    expect(r.messages[0]!.content[1]).toEqual({ type: "text", text: "new question" });

    const tight = fitContext(
      {
        system: "s",
        messages: [user("q"), call("1", "load_skill", { name: "k" }), result("1", "K".repeat(4000), "load_skill"), call("2"), result("2", "z".repeat(4000)), call("3"), result("3", "ok")],
        tools,
      },
      { budgetTokens: 300 },
    );
    expect(tight.truncatedResults).toBeGreaterThanOrEqual(2);
    expect(tight.droppedMessages).toBe(2);
    expect(tight.droppedSkillLoads).toEqual(["k"]);
    expect(tight.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(tight.estimatedTokens).toBeLessThanOrEqual(300);
  });

  it("adds a leading user note when the first kept message is not a user turn", () => {
    const msgs: Message[] = [asst("x".repeat(4000)), user("q"), call("1"), result("1", "ok")];
    const r = fitContext({ system: "s", messages: msgs, tools }, { budgetTokens: 200 });
    expect(r.messages[0]!.role).toBe("user");
  });
});
