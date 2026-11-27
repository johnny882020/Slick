// Stores schedules and fires due ones. The clock and timer are injectable so tests
// can drive time. A schedule missed while the daemon was off fires once on the next
// tick, then moves to its next future time.

import type { Schedule } from "@oneseat/contracts";
import { nextRun, parseCron } from "./cron.js";
import type { ScheduleStore } from "./stores.js";
import { errorMessage, newId, silentLogger, type Logger } from "./util.js";

export type ScheduleInput = Omit<Schedule, "lastRunAt" | "nextRunAt" | "id"> & { id?: string };

export interface SchedulerOptions {
  store: ScheduleStore;
  /** Start a run for the schedule; resolves with its runId. */
  fire: (schedule: Schedule) => Promise<string>;
  now?: () => Date;
  intervalMs?: number;
  logger?: Logger;
  onFired?: (scheduleId: string, runId: string) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class Scheduler {
  private readonly now: () => Date;
  private handle: unknown;
  private ticking: Promise<{ scheduleId: string; runId: string }[]> | undefined;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  list(): Schedule[] {
    return this.opts.store.list();
  }

  get(id: string): Schedule | undefined {
    return this.opts.store.get(id);
  }

  /** Create or replace a schedule. Throws CronError on a bad expression. */
  upsert(input: ScheduleInput): Schedule {
    const spec = parseCron(input.cron);
    const id = input.id ?? newId("sch");
    const existing = this.opts.store.get(id);
    const next = input.enabled ? nextRun(spec, this.now()) : undefined;
    const s: Schedule = { id, cron: input.cron.trim(), task: input.task, enabled: input.enabled };
    if (existing?.lastRunAt) s.lastRunAt = existing.lastRunAt;
    if (next) s.nextRunAt = next.toISOString();
    return this.opts.store.put(s);
  }

  remove(id: string): boolean {
    return this.opts.store.remove(id);
  }

  /** Fire every enabled schedule whose next run is due. Concurrent calls share one tick. */
  tick(): Promise<{ scheduleId: string; runId: string }[]> {
    if (!this.ticking) {
      this.ticking = this.doTick().finally(() => {
        this.ticking = undefined;
      });
    }
    return this.ticking;
  }

  private async doTick(): Promise<{ scheduleId: string; runId: string }[]> {
    const now = this.now();
    const fired: { scheduleId: string; runId: string }[] = [];
    for (const s of this.opts.store.list()) {
      if (!s.enabled) continue;
      if (!s.nextRunAt) {
        // Written without a next time (older row): schedule it, do not fire now.
        const next = safeNext(s.cron, now);
        this.opts.store.put({ ...s, ...(next ? { nextRunAt: next.toISOString() } : {}) });
        continue;
      }
      if (new Date(s.nextRunAt).getTime() > now.getTime()) continue;
      const next = safeNext(s.cron, now);
      const updated: Schedule = { ...s, lastRunAt: now.toISOString() };
      if (next) updated.nextRunAt = next.toISOString();
      else delete updated.nextRunAt;
      this.opts.store.put(updated);
      try {
        const runId = await this.opts.fire(updated);
        fired.push({ scheduleId: s.id, runId });
        this.opts.onFired?.(s.id, runId);
      } catch (e) {
        (this.opts.logger ?? silentLogger).error(`schedule ${s.id} failed to start`, errorMessage(e));
      }
    }
    return fired;
  }

  start(): void {
    if (this.handle !== undefined) return;
    const set = this.opts.setInterval ?? ((fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
    this.handle = set(() => void this.tick(), this.opts.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.handle === undefined) return;
    const clear = this.opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
    clear(this.handle);
    this.handle = undefined;
  }

  get running(): boolean {
    return this.handle !== undefined;
  }
}

function safeNext(cron: string, from: Date): Date | undefined {
  try {
    return nextRun(cron, from);
  } catch {
    return undefined;
  }
}
