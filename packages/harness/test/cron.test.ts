import { afterEach, describe, expect, it, vi } from "vitest";
import { cronMatches, CronError, isValidCron, nextRun, parseCron } from "../src/cron.js";
import { OneSeatDb } from "../src/db.js";
import { Scheduler } from "../src/scheduler.js";
import { ScheduleStore } from "../src/stores.js";
import { onCleanup, tmpDir } from "./helpers.js";

/** Local wall-clock fields of a date, so assertions do not depend on the machine's zone. */
function local(d: Date | undefined): string {
  if (!d) return "none";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("parseCron", () => {
  it("parses lists, ranges, steps, names and aliases", () => {
    const s = parseCron("*/15 9-17/4 1,15 JAN-mar mon-FRI");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([9, 13, 17]);
    expect([...s.daysOfMonth]).toEqual([1, 15]);
    expect([...s.months]).toEqual([1, 2, 3]);
    expect([...s.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(s.domRestricted && s.dowRestricted).toBe(true);
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 5-7").daysOfWeek].sort()).toEqual([0, 5, 6]);
    expect([...parseCron("10/20 * * * *").minutes]).toEqual([10, 30, 50]);
    expect([...parseCron("0 0 * * */2").daysOfWeek]).toEqual([0, 2, 4, 6]);
    expect(parseCron("@daily").source).toBe("@daily");
    expect([...parseCron("@hourly").minutes]).toEqual([0]);
    expect(parseCron("@weekly").dowRestricted).toBe(true);
    expect(parseCron("*/2 * * * *").domRestricted).toBe(false);
  });

  it("rejects bad expressions", () => {
    for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "a * * * *", "1-2-3 * * * *", "1,,2 * * * *", "1/2/3 * * * *", "-1 * * * *"]) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
      expect(isValidCron(bad)).toBe(false);
    }
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
  });
});

describe("nextRun", () => {
  it("finds the next minute, hour, day, month and year", () => {
    expect(local(nextRun("* * * * *", at(2026, 3, 10, 9, 59)))).toBe("2026-03-10 10:00");
    expect(local(nextRun("30 9 * * *", at(2026, 3, 10, 9, 30)))).toBe("2026-03-11 09:30");
    expect(local(nextRun("30 9 * * *", at(2026, 3, 10, 9, 29)))).toBe("2026-03-10 09:30");
    expect(local(nextRun("0 0 1 * *", at(2026, 12, 15)))).toBe("2027-01-01 00:00");
    expect(local(nextRun("0 12 31 * *", at(2026, 4, 1)))).toBe("2026-05-31 12:00");
    expect(local(nextRun("0 0 29 2 *", at(2026, 3, 1)))).toBe("2028-02-29 00:00");
    expect(local(nextRun("15 10 * 6 *", at(2026, 7, 1)))).toBe("2027-06-01 10:15");
    expect(local(nextRun("0 23 * * *", at(2026, 12, 31, 23, 30)))).toBe("2027-01-01 23:00");
    // Seconds are ignored: from 09:00:30 the next 09:01 is used.
    expect(local(nextRun("* * * * *", new Date(2026, 0, 1, 9, 0, 30)))).toBe("2026-01-01 09:01");
  });

  it("weekday schedules (local time)", () => {
    // 2026-03-13 is a Friday.
    expect(local(nextRun("0 9 * * 1-5", at(2026, 3, 13, 10)))).toBe("2026-03-16 09:00");
    expect(local(nextRun("0 9 * * MON", at(2026, 3, 13, 10)))).toBe("2026-03-16 09:00");
    expect(local(nextRun("0 18 * * 0", at(2026, 3, 13, 10)))).toBe("2026-03-15 18:00");
  });

  it("applies the day-of-month OR day-of-week rule", () => {
    // 1st of the month OR any Monday. 2026-06-02 is a Tuesday; the next Monday is 06-08.
    expect(local(nextRun("0 8 1 * 1", at(2026, 6, 2)))).toBe("2026-06-08 08:00");
    // From 2026-06-29 (Mon) 09:00 the 1st of July (Wed) comes before the next Monday.
    expect(local(nextRun("0 8 1 * 1", at(2026, 6, 29, 9)))).toBe("2026-07-01 08:00");
    // Only dom restricted: weekday ignored.
    expect(local(nextRun("0 8 1 * *", at(2026, 6, 2)))).toBe("2026-07-01 08:00");
    // dom "*" with dow restricted: only the weekday matters.
    expect(local(nextRun("0 8 * * 3", at(2026, 6, 2)))).toBe("2026-06-03 08:00");
    // "*/1" in dom counts as unrestricted (starts with *), so only the weekday applies.
    expect(local(nextRun("0 8 */1 * 3", at(2026, 6, 2)))).toBe("2026-06-03 08:00");
    expect(cronMatches(parseCron("0 8 1 * 1"), at(2026, 6, 8, 8))).toBe(true);
    expect(cronMatches(parseCron("0 8 1 * 1"), at(2026, 6, 9, 8))).toBe(false);
  });

  it("returns undefined for dates that never happen", () => {
    expect(nextRun("0 0 30 2 *", at(2026, 1, 1))).toBeUndefined();
    expect(nextRun("0 0 31 4 *", at(2026, 1, 1), 2)).toBeUndefined();
  });

  describe("across DST (America/New_York)", () => {
    const tz = process.env["TZ"];
    afterEach(() => {
      if (tz === undefined) delete process.env["TZ"];
      else process.env["TZ"] = tz;
    });

    it("skips a wall time that does not exist and fires once for one that repeats", () => {
      process.env["TZ"] = "America/New_York";
      // 2026-03-08: clocks jump from 02:00 to 03:00.
      expect(local(nextRun("30 2 * * *", at(2026, 3, 8, 1, 0)))).toBe("2026-03-09 02:30");
      expect(local(nextRun("0 3 * * *", at(2026, 3, 8, 1, 0)))).toBe("2026-03-08 03:00");
      // Hourly keeps going through the gap without repeating.
      const h1 = nextRun("0 * * * *", at(2026, 3, 8, 1, 30))!;
      expect(local(h1)).toBe("2026-03-08 03:00");
      expect(h1.getTime() - at(2026, 3, 8, 1, 30).getTime()).toBe(30 * 60_000);
      // 2026-11-01: 01:00-02:00 happens twice; a daily 01:30 fires once.
      const first = nextRun("30 1 * * *", at(2026, 11, 1, 0, 0))!;
      expect(local(first)).toBe("2026-11-01 01:30");
      expect(local(nextRun("30 1 * * *", first))).toBe("2026-11-02 01:30");
      // Starting inside the repeated hour (second 01:45, EST) still moves forward.
      const secondPass = new Date(first.getTime() + 75 * 60_000); // 01:45 EST
      expect(local(secondPass)).toBe("2026-11-01 01:45");
      const n = nextRun("*/30 * * * *", secondPass)!;
      expect(n.getTime()).toBeGreaterThan(secondPass.getTime());
      expect(local(n)).toBe("2026-11-01 02:00");
    });

    it("gives the same wall-clock answer in UTC", () => {
      process.env["TZ"] = "UTC";
      expect(local(nextRun("30 2 * * *", at(2026, 3, 8, 1, 0)))).toBe("2026-03-08 02:30");
    });
  });
});

describe("Scheduler", () => {
  function make(now: { t: Date }) {
    const dir = tmpDir();
    const db = OneSeatDb.open(dir);
    onCleanup(() => db.close());
    const store = new ScheduleStore(db);
    const fired: string[] = [];
    let n = 0;
    const onFired = vi.fn();
    const scheduler = new Scheduler({
      store,
      now: () => now.t,
      fire: async (s) => {
        if (s.task.input === "explode") throw new Error("cannot start");
        fired.push(s.id);
        return `run_${++n}`;
      },
      onFired,
    });
    return { scheduler, store, fired, onFired };
  }

  it("computes next runs and fires due schedules once, as the clock moves", async () => {
    const now = { t: at(2026, 3, 13, 8, 0) };
    const { scheduler, fired, onFired } = make(now);
    const s = scheduler.upsert({ id: "daily", cron: "0 9 * * *", task: { input: "brief", provider: "local", model: "m" }, enabled: true });
    expect(local(new Date(s.nextRunAt!))).toBe("2026-03-13 09:00");
    expect(await scheduler.tick()).toEqual([]);
    now.t = at(2026, 3, 13, 9, 0);
    expect(await scheduler.tick()).toEqual([{ scheduleId: "daily", runId: "run_1" }]);
    expect(onFired).toHaveBeenCalledWith("daily", "run_1");
    expect(await scheduler.tick()).toEqual([]);
    const after = scheduler.get("daily")!;
    expect(after.lastRunAt).toBe(at(2026, 3, 13, 9, 0).toISOString());
    expect(local(new Date(after.nextRunAt!))).toBe("2026-03-14 09:00");
    // Missed several days: fires once, then moves to the next future time.
    now.t = at(2026, 3, 20, 12, 0);
    expect(await scheduler.tick()).toHaveLength(1);
    expect(local(new Date(scheduler.get("daily")!.nextRunAt!))).toBe("2026-03-21 09:00");
    expect(fired).toEqual(["daily", "daily"]);
  });

  it("skips disabled schedules, schedules rows without a next time, and survives a failing fire", async () => {
    const now = { t: at(2026, 3, 13, 8, 0) };
    const { scheduler, store, fired } = make(now);
    scheduler.upsert({ id: "off", cron: "* * * * *", task: { input: "x", provider: "local", model: "m" }, enabled: false });
    expect(scheduler.get("off")!.nextRunAt).toBeUndefined();
    store.put({ id: "raw", cron: "* * * * *", task: { input: "y", provider: "local", model: "m" }, enabled: true });
    scheduler.upsert({ id: "bad", cron: "* * * * *", task: { input: "explode", provider: "local", model: "m" }, enabled: true });
    store.put({ id: "never", cron: "0 0 30 2 *", task: { input: "z", provider: "local", model: "m" }, enabled: true, nextRunAt: at(2026, 1, 1).toISOString() });
    now.t = at(2026, 3, 13, 8, 5);
    const first = await scheduler.tick();
    // "never" was due (stored next time in the past): it fires once, then has no next time.
    expect(first.map((f) => f.scheduleId)).toEqual(["never"]);
    expect(scheduler.get("raw")!.nextRunAt).toBeDefined();
    expect(scheduler.get("never")!.nextRunAt).toBeUndefined();
    expect(scheduler.get("bad")!.lastRunAt).toBeDefined();
    now.t = at(2026, 3, 13, 8, 10);
    await scheduler.tick();
    expect(fired).toEqual(["never", "raw"]);
    expect(() => scheduler.upsert({ cron: "nope", task: { input: "x", provider: "local", model: "m" }, enabled: true })).toThrow(CronError);
    expect(scheduler.list().length).toBe(4);
    expect(scheduler.remove("off")).toBe(true);
  });

  it("shares a tick between concurrent callers and runs a timer loop", async () => {
    const now = { t: at(2026, 3, 13, 8, 0) };
    const { scheduler } = make(now);
    const a = scheduler.tick();
    expect(scheduler.tick()).toBe(a);
    await a;
    let tickFn: (() => void) | undefined;
    const cleared: unknown[] = [];
    const s2 = new Scheduler({
      store: new ScheduleStore(OneSeatDb.open(tmpDir())),
      fire: async () => "r",
      setInterval: (fn) => {
        tickFn = fn;
        return 42;
      },
      clearInterval: (h) => cleared.push(h),
    });
    s2.start();
    s2.start();
    expect(s2.running).toBe(true);
    tickFn!();
    s2.stop();
    s2.stop();
    expect(cleared).toEqual([42]);
    expect(s2.running).toBe(false);
    // Real timers path.
    const s3 = new Scheduler({ store: new ScheduleStore(OneSeatDb.open(tmpDir())), fire: async () => "r", intervalMs: 10_000 });
    s3.start();
    s3.stop();
  });
});
