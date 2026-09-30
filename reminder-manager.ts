export type ReminderKind = "reminder" | "poll";
export type ReminderDelivery = "wake" | "next_turn";

export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReminderSnapshot {
  id: string;
  kind: ReminderKind;
  message: string;
  delivery: ReminderDelivery;
  intervalSeconds: number;
  createdAt: number;
  nextAt: number;
  attempts: number;
  deliveredRuns: number;
  maxRuns: number;
}

export interface FiredReminder extends ReminderSnapshot {
  run: number;
}

interface ReminderEntry extends ReminderSnapshot {
  handle: unknown;
}

interface ReminderManagerOptions {
  scheduler?: Scheduler;
  maxActive?: number;
  onFire(reminder: FiredReminder): boolean;
  onChange?(): void;
  onError?(error: Error, reminder: FiredReminder): void;
}

const MIN_REMINDER_SECONDS = 1;
const MAX_REMINDER_SECONDS = 86_400;
const MIN_POLL_SECONDS = 10;
const MAX_POLL_SECONDS = 3_600;
const MAX_MESSAGE_LENGTH = 500;
const MAX_POLL_RUNS = 100;
const DEFAULT_MAX_ACTIVE = 20;

const systemScheduler: Scheduler = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class ReminderManager {
  private readonly scheduler: Scheduler;
  private readonly maxActive: number;
  private readonly onFire: ReminderManagerOptions["onFire"];
  private readonly onChange: () => void;
  private readonly onError: NonNullable<ReminderManagerOptions["onError"]>;
  private readonly reminders = new Map<string, ReminderEntry>();
  private sequence = 0;

  constructor(options: ReminderManagerOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
    this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
    this.onFire = options.onFire;
    this.onChange = options.onChange ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  startReminder(input: {
    seconds: number;
    message: string;
    delivery?: ReminderDelivery;
  }): ReminderSnapshot {
    this.assertCapacity();
    assertIntegerInRange(
      input.seconds,
      MIN_REMINDER_SECONDS,
      MAX_REMINDER_SECONDS,
      `Reminder delay must be between ${MIN_REMINDER_SECONDS} and ${MAX_REMINDER_SECONDS} seconds`,
    );
    const message = validateMessage(input.message);

    return this.addReminder({
      kind: "reminder",
      intervalSeconds: input.seconds,
      message,
      delivery: input.delivery ?? "wake",
      maxRuns: 1,
    });
  }

  startPoll(input: {
    intervalSeconds: number;
    message: string;
    maxRuns: number;
    delivery?: ReminderDelivery;
  }): ReminderSnapshot {
    this.assertCapacity();
    assertIntegerInRange(
      input.intervalSeconds,
      MIN_POLL_SECONDS,
      MAX_POLL_SECONDS,
      `Poll interval must be between ${MIN_POLL_SECONDS} and ${MAX_POLL_SECONDS} seconds`,
    );
    assertIntegerInRange(
      input.maxRuns,
      1,
      MAX_POLL_RUNS,
      `Poll maxRuns must be between 1 and ${MAX_POLL_RUNS}`,
    );
    const message = validateMessage(input.message);

    return this.addReminder({
      kind: "poll",
      intervalSeconds: input.intervalSeconds,
      message,
      delivery: input.delivery ?? "wake",
      maxRuns: input.maxRuns,
    });
  }

  list(): ReminderSnapshot[] {
    return [...this.reminders.values()]
      .sort((left, right) => left.nextAt - right.nextAt)
      .map(({ handle: _handle, ...reminder }) => ({ ...reminder }));
  }

  cancel(id: string): boolean {
    const reminder = this.reminders.get(id);
    if (!reminder) return false;

    this.scheduler.clearTimeout(reminder.handle);
    this.reminders.delete(id);
    this.onChange();
    return true;
  }

  cancelAll(): number {
    const count = this.reminders.size;
    for (const reminder of this.reminders.values()) {
      this.scheduler.clearTimeout(reminder.handle);
    }
    this.reminders.clear();
    if (count > 0) this.onChange();
    return count;
  }

  shutdown(): number {
    return this.cancelAll();
  }

  private assertCapacity(): void {
    if (this.reminders.size >= this.maxActive) {
      throw new Error(`Too many active reminders: limit is ${this.maxActive}. Cancel one and try again.`);
    }
  }

  private addReminder(input: {
    kind: ReminderKind;
    intervalSeconds: number;
    message: string;
    delivery: ReminderDelivery;
    maxRuns: number;
  }): ReminderSnapshot {
    const createdAt = this.scheduler.now();
    const id = `${input.kind}-${++this.sequence}`;
    const reminder: ReminderEntry = {
      ...input,
      id,
      createdAt,
      nextAt: createdAt + input.intervalSeconds * 1_000,
      attempts: 0,
      deliveredRuns: 0,
      handle: undefined,
    };

    reminder.handle = this.schedule(reminder);
    this.reminders.set(id, reminder);
    this.onChange();
    return this.snapshot(reminder);
  }

  private schedule(reminder: ReminderEntry): unknown {
    return this.scheduler.setTimeout(() => this.fire(reminder.id), reminder.intervalSeconds * 1_000);
  }

  private fire(id: string): void {
    const reminder = this.reminders.get(id);
    if (!reminder) return;

    reminder.attempts += 1;
    const firedReminder = {
      ...this.snapshot(reminder),
      run: reminder.attempts,
    };
    let accepted = false;
    try {
      accepted = this.onFire(firedReminder);
    } catch (error) {
      try {
        this.onError(toError(error), firedReminder);
      } catch {
        // Error reporting must not escape a timer callback.
      }
    }
    if (accepted) reminder.deliveredRuns += 1;

    if (reminder.kind === "reminder" || reminder.attempts >= reminder.maxRuns) {
      this.reminders.delete(id);
    } else {
      reminder.nextAt = this.scheduler.now() + reminder.intervalSeconds * 1_000;
      reminder.handle = this.schedule(reminder);
    }

    this.onChange();
  }

  private snapshot(reminder: ReminderEntry): ReminderSnapshot {
    const { handle: _handle, ...snapshot } = reminder;
    return { ...snapshot };
  }
}

function validateMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Reminder message must contain between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return trimmed;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertIntegerInRange(value: number, minimum: number, maximum: number, message: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${message}. Received: ${String(value)}.`);
  }
}
