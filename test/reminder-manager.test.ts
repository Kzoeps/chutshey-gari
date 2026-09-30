import assert from "node:assert/strict";
import test from "node:test";

import {
  ReminderManager,
  type FiredReminder,
  type Scheduler,
} from "../reminder-manager.ts";

class FakeScheduler implements Scheduler {
  private clock = 0;
  private sequence = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.clock;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.sequence;
    this.jobs.set(id, { at: this.clock + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  advance(milliseconds: number): void {
    const target = this.clock + milliseconds;

    while (true) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];

      if (!next) break;

      const [id, job] = next;
      this.jobs.delete(id);
      this.clock = job.at;
      job.callback();
    }

    this.clock = target;
  }
}

function setup(options: { acceptPoll?: () => boolean; maxActive?: number } = {}) {
  const scheduler = new FakeScheduler();
  const fired: FiredReminder[] = [];
  let changes = 0;
  const manager = new ReminderManager({
    scheduler,
    maxActive: options.maxActive,
    onFire(reminder) {
      if (reminder.kind === "poll" && options.acceptPoll?.() === false) {
        return false;
      }
      fired.push(reminder);
      return true;
    },
    onChange() {
      changes += 1;
    },
  });

  return { scheduler, fired, manager, changes: () => changes };
}

test("a reminder fires once at its deadline and is removed", () => {
  const { scheduler, fired, manager } = setup();
  const reminder = manager.startReminder({ seconds: 3, message: "Check the build" });

  scheduler.advance(2_999);
  assert.equal(fired.length, 0);

  scheduler.advance(1);
  assert.deepEqual(fired.map(({ id, message, run }) => ({ id, message, run })), [
    { id: reminder.id, message: "Check the build", run: 1 },
  ]);
  assert.deepEqual(manager.list(), []);

  scheduler.advance(30_000);
  assert.equal(fired.length, 1);
});

test("a poll stops after its bounded number of attempts", () => {
  const { scheduler, fired, manager } = setup();
  const poll = manager.startPoll({
    intervalSeconds: 10,
    message: "Check deployment status",
    maxRuns: 3,
  });

  scheduler.advance(30_000);

  assert.deepEqual(fired.map(({ id, run, maxRuns }) => ({ id, run, maxRuns })), [
    { id: poll.id, run: 1, maxRuns: 3 },
    { id: poll.id, run: 2, maxRuns: 3 },
    { id: poll.id, run: 3, maxRuns: 3 },
  ]);
  assert.deepEqual(manager.list(), []);
});

test("a poll skips busy attempts instead of queueing overlapping turns", () => {
  let attempt = 0;
  const { scheduler, fired, manager } = setup({
    acceptPoll: () => ++attempt !== 2,
  });
  manager.startPoll({ intervalSeconds: 10, message: "Poll CI", maxRuns: 3 });

  scheduler.advance(30_000);

  assert.deepEqual(fired.map(({ run }) => run), [1, 3]);
  assert.deepEqual(manager.list(), []);
});

test("delivery errors are contained and reported", () => {
  const scheduler = new FakeScheduler();
  const errors: Array<{ id: string; message: string }> = [];
  const manager = new ReminderManager({
    scheduler,
    onFire() {
      throw new Error("delivery failed");
    },
    onError(error, reminder) {
      errors.push({ id: reminder.id, message: error.message });
    },
  });
  const reminder = manager.startReminder({ seconds: 1, message: "Fail safely" });

  assert.doesNotThrow(() => scheduler.advance(1_000));
  assert.deepEqual(errors, [{ id: reminder.id, message: "delivery failed" }]);
  assert.deepEqual(manager.list(), []);
});

test("cancelling a reminder prevents it from firing", () => {
  const { scheduler, fired, manager } = setup();
  const reminder = manager.startReminder({ seconds: 2, message: "Never fire" });

  assert.equal(manager.cancel(reminder.id), true);
  assert.equal(manager.cancel(reminder.id), false);
  scheduler.advance(5_000);

  assert.deepEqual(fired, []);
});

test("shutdown cancels every reminder", () => {
  const { scheduler, fired, manager } = setup();
  manager.startReminder({ seconds: 2, message: "Reminder" });
  manager.startPoll({ intervalSeconds: 10, message: "Poll", maxRuns: 2 });

  assert.equal(manager.shutdown(), 2);
  scheduler.advance(30_000);

  assert.deepEqual(fired, []);
  assert.deepEqual(manager.list(), []);
});

test("limits reject unsafe or ambiguous reminder requests", () => {
  const { manager } = setup({ maxActive: 1 });

  assert.throws(
    () => manager.startReminder({ seconds: 0, message: "Too soon" }),
    /Reminder delay must be between 1 and 86400 seconds/,
  );
  assert.throws(
    () => manager.startPoll({ intervalSeconds: 9, message: "Too frequent", maxRuns: 2 }),
    /Poll interval must be between 10 and 3600 seconds/,
  );
  assert.throws(
    () => manager.startReminder({ seconds: 1, message: " ".repeat(501) }),
    /Reminder message must contain between 1 and 500 characters/,
  );
  assert.throws(
    () => manager.startPoll({ intervalSeconds: 10, message: "No bound", maxRuns: 101 }),
    /Poll maxRuns must be between 1 and 100/,
  );

  manager.startReminder({ seconds: 1, message: "Only slot" });
  assert.throws(
    () => manager.startReminder({ seconds: 1, message: "Overflow" }),
    /Too many active reminders: limit is 1/,
  );
});
