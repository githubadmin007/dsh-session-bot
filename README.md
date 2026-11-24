# dsh-session-bot

**Your sessions are already bots. This plugin just gives them a badge.**

Most "bot team" plugins for DSH make you start over: install the plugin, create new bots, and
your existing sessions — with their working directories, their context, their history — are left
behind. `dsh-session-bot` goes the other way. Any session you already have can be claimed as a bot
in one sentence, and immediately gains a profile, a memory, and the ability to hand work to the
other bots in your workspace.

> 你的会话本来就可以是 BOT。装完不用重建，认领一下就行。

## What you get

- **Zero migration.** No new bot entity, no new agent preset, no new working directory. A bot *is*
  your session.
- **Hand work to the others without naming them.** You say what needs doing; the bot that owns
  the work decides who does it. You never type `@someone`.
- **Tasks, not messages.** A hand-off is a task with an expected completion count and a deadline,
  not a message in a group chat. Three bots finish, and the initiator is woken **once** with all
  three results.
- **The profile belongs to you, the memory belongs to the bot.** A bot cannot rename itself or
  grant itself new collaborators. It can only write its own memory.
- **No dashboard to learn.** A session menu item and a small panel. Your existing sidebar stays
  yours.

## Install

```sh
dsh plugin --profile web add dsh-session-bot
```

Then add the plugin's configuration to your profile's `cordis.patch.yml`:

```yaml
- id: dsh-session-bot
  config:
    stateDir: /path/to/bot-state     # where profiles, tasks and handoff notes live
    workspace: /path/to/workspace    # working directory for sessions created after a rotation
```

## Use it in 30 seconds

1. Open any session you already work in — the one with the repository, the context, the history.
2. Say: **"You are the frontend bot. You own `packages/main`."**
   The session claims itself with `bot_claim`.
3. Do the same in another session: **"You are the project manager."**
4. In the manager, say: **"Ask the frontend bot to fix the sorting."**
   The manager calls `task_create`, the frontend session wakes, does the work, and reports back.

That's the whole loop. No new bots were created, and no working directory moved.

## Tools

Registered only in claimed sessions. Unclaimed sessions get exactly one: `bot_claim`.

| Tool | What it does |
| --- | --- |
| `bot_claim` | Claim this session as a bot (name, purpose, details) |
| `bot_list` | All bots, their purpose and status, and which ones you may call |
| `bot_info` | One bot's details (never its memory) |
| `bot_remember` | Append to your own memory |
| `bot_forget` | Rewrite or clear your own memory |
| `bot_ask` | Ask the human a question without blocking |
| `task_create` | Hand work to one or more collaborator bots; returns a task id |
| `task_report` | Report `done` / `blocked` / `failed` on a task handed to you |
| `task_list` | Your own outbound tasks that are still pending |

## How a hand-off works

```
manager                          frontend
   task_create([{bot: frontend, brief: "..."}])
        │
        └── task T-abc ──────────► [task T-abc · from manager]
                                    ...does the work...
                                    task_report(T-abc, done, "...")
        ◄── woken once ────────────┘
```

- **Aggregation.** Create one task with three targets, and the initiator is woken when all three
  report — not three times.
- **Deadline.** Every task expires (30 minutes by default). On expiry the initiator is woken with
  exactly who is missing, so nobody waits forever.
- **Forgotten reports.** If a bot ends a turn while holding an unreported task, the initiator hears
  about it instead of waiting for the deadline.
- **One-way collaboration.** A bot can only hand work to bots listed in *its own* profile, so the
  graph is exactly the one you drew.

## Rotation

Long conversations get compacted by DSH itself. When you want a clean boundary — a batch of
related work is finished and the next batch starts — rotate:

```
bot rotates → handoff note written → old session archived → new session opened → note injected
```

The archived session cannot be reopened by DSH, so the handoff note and DSH's session search are
how you look back.

## Configuration

| Key | Meaning |
| --- | --- |
| `stateDir` | Where bot profiles, tasks and handoff notes are stored |
| `workspace` | Working directory for sessions created by a rotation |
| `bots` | Optional preset profiles, so you do not have to claim them by hand |

```yaml
bots:
  - sessionId: session-xxxxxxxx
    name: frontend
    brief: Frontend bot
    detail: Owns packages/main. Vue + TS. Run pnpm test before reporting.
    peers: [bot-yyyyyyyy]      # who this bot may hand work to
```

## Limits

- Concurrency on the same working directory is not coordinated. If two bots edit the same repo at
  once, that is between you and them.
- No group chat. A task has explicit recipients; if you want a conversation among several bots,
  that is what the task brief is for.
- No automatic profile editing. Changing a bot's name, purpose or collaborators is a human action.

## License

MIT
