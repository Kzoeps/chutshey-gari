import assert from "node:assert/strict";
import test from "node:test";

import { registerRemindersExtension } from "../extension.ts";
import type { Scheduler } from "../reminder-manager.ts";

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

function setup() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const messages: Array<{ message: any; options: any }> = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const scheduler = new FakeScheduler();
  let idle = true;
  let pending = false;

  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
  };
  const schemas = {
    Object: (properties: unknown) => ({ properties }),
    String: (options?: unknown) => ({ type: "string", ...asObject(options) }),
    Integer: (options?: unknown) => ({ type: "integer", ...asObject(options) }),
    Optional: (schema: unknown) => schema,
    StringEnum: (values: readonly string[]) => ({ enum: values }),
  };
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: {
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  registerRemindersExtension(pi as any, schemas as any, { scheduler });
  handlers.get("session_start")?.({}, ctx);

  return {
    commands,
    handlers,
    messages,
    notifications,
    scheduler,
    statuses,
    tools,
    setBusy(value: boolean) {
      idle = !value;
      pending = value;
    },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

test("registers a small explicit tool and command surface", () => {
  const { tools, commands } = setup();

  assert.deepEqual([...tools.keys()], ["remind_after", "poll_every", "reminder_control"]);
  assert.deepEqual([...commands.keys()], ["reminders", "cancel-reminder"]);
});

test("remind_after schedules a bounded message that wakes Pi", async () => {
  const { tools, scheduler, messages } = setup();

  const result = await tools.get("remind_after").execute("call-1", {
    seconds: 2,
    message: "Check the build",
  });
  assert.match(result.content[0].text, /reminder-1.*2 seconds/);

  scheduler.advance(2_000);

  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /Check the build/);
  assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("next-turn delivery records the reminder without waking Pi", async () => {
  const { tools, scheduler, messages } = setup();
  await tools.get("remind_after").execute("call-1", {
    seconds: 1,
    message: "Mention this later",
    delivery: "next_turn",
  });

  scheduler.advance(1_000);

  assert.deepEqual(messages[0].options, { deliverAs: "nextTurn", triggerTurn: false });
});

test("poll_every skips polls while Pi is busy", async () => {
  const { tools, scheduler, messages, setBusy } = setup();
  await tools.get("poll_every").execute("call-1", {
    intervalSeconds: 10,
    message: "Poll CI",
    maxRuns: 2,
  });

  setBusy(true);
  scheduler.advance(10_000);
  setBusy(false);
  scheduler.advance(10_000);

  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /attempt 2 of 2/);
});

test("reminder_control lists and cancels active reminders", async () => {
  const { tools, scheduler, messages } = setup();
  await tools.get("remind_after").execute("call-1", { seconds: 2, message: "Cancel me" });

  const listed = await tools.get("reminder_control").execute("call-2", { action: "list" });
  assert.match(listed.content[0].text, /reminder-1/);

  const cancelled = await tools.get("reminder_control").execute("call-3", {
    action: "cancel",
    id: "reminder-1",
  });
  assert.match(cancelled.content[0].text, /Cancelled reminder-1/);

  scheduler.advance(2_000);
  assert.deepEqual(messages, []);
});

test("session shutdown clears pending work and the footer status", async () => {
  const { tools, handlers, scheduler, messages, statuses } = setup();
  await tools.get("remind_after").execute("call-1", { seconds: 2, message: "Do not survive" });

  handlers.get("session_shutdown")?.({}, {});
  scheduler.advance(2_000);

  assert.deepEqual(messages, []);
  assert.equal(statuses.at(-1), undefined);
});
