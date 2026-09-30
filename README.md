# chutshey-gari

A Pi package that adds non-blocking reminders and bounded periodic polling.

## Install

```sh
pi install npm:chutshey-gari
```

The package registers these tools:

- `remind_after`: schedule one reminder after 1–86,400 seconds.
- `poll_every`: poll every 10–3,600 seconds for at most 1–100 attempts (10 by default).
- `reminder_control`: list or cancel active reminders and polls.

It also adds `/reminders` and `/cancel-reminder <reminder-id|poll-id|all>` commands.

`delivery: "wake"` triggers an agent turn when a reminder fires. `delivery: "next_turn"` waits and includes it with the next user turn. Poll attempts are skipped while Pi is busy or has queued messages.

## Reminder lifetime

Schedules are held in memory for the active Pi session. Pi shutdown or extension reload cancels them; they do not survive a restart. One-shot reminders fire once. Polls stop after their configured maximum number of attempts.

Reminder text is added to model context when delivered. Do not include untrusted external text in reminder messages.

## Development

Requires Node.js 22.6 or newer and pnpm.

```sh
pnpm install
pnpm test
pnpm typecheck
```

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
