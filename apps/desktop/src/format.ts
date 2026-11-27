// Formatting helpers (pure).

import type { ProviderId, SkillSource, ToolEffect, Usage } from "@oneseat/contracts";

export const PROVIDERS: { id: ProviderId; label: string; keyHint: string }[] = [
  { id: "anthropic", label: "Claude", keyHint: "Starts with sk-ant-. Create one in the Anthropic Console." },
  { id: "openai", label: "OpenAI", keyHint: "Starts with sk-. Create one in the OpenAI dashboard." },
  { id: "google", label: "Gemini", keyHint: "Create one in Google AI Studio." },
  { id: "local", label: "Local", keyHint: "An OpenAI-compatible server on your computer, such as Ollama or LM Studio. A key is optional." },
];

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

const EFFECT_LABELS: Record<ToolEffect, string> = {
  read: "reads data",
  write: "changes data",
  network: "uses the internet",
  send: "sends a message",
  pay: "makes a payment",
  delete: "deletes something",
};

export function effectLabel(e: ToolEffect): string {
  return EFFECT_LABELS[e] ?? e;
}

const nf = new Intl.NumberFormat("en-US");

export function formatTokens(n: number): string {
  return nf.format(Math.max(0, Math.round(n)));
}

export function formatUsage(u: Usage): string {
  const parts = [`${formatTokens(u.inputTokens)} in`, `${formatTokens(u.outputTokens)} out`];
  if (u.cacheReadTokens) parts.push(`${formatTokens(u.cacheReadTokens)} cached`);
  return `${parts.join(" · ")} tokens`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

export function formatTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function describeSource(s: SkillSource): string {
  switch (s.kind) {
    case "local":
      return `Folder ${s.path}`;
    case "github":
      return `GitHub ${s.owner}/${s.repo}${s.path ? `/${s.path}` : ""}${s.ref ? ` @ ${s.ref}` : ""}`;
    case "skills.sh":
      return `skills.sh ${s.owner}/${s.repo}${s.skill ? `@${s.skill}` : ""}`;
  }
}

/** Short, single-line JSON preview of tool input. */
export function previewJson(v: unknown, max = 160): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "";
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
