# dsh-session-bot

[中文](#中文) · [English](#english)

---

## 中文

**你的会话本来就可以是 BOT。这个插件只是给它挂一块牌子。**

DSH 上大多数「BOT 团队」插件会让你从头再来：装完插件、新建几个 BOT，而你已有的会话——连同工作目录、上下文、历史——全被丢在一边。`dsh-session-bot` 反过来：任何一个你已经在用的会话，一句话就认领成 BOT，立刻有了档案、记忆，以及给别的 BOT 派活的能力。

> **Your sessions are already bots. This plugin just gives them a badge.**

### 你会得到

- **零迁移。** 没有新的 BOT 实体、没有新的 agent preset、没有新的工作目录。BOT 就是你的会话。
- **派活不用点名。** 你说要做什么，手里有活的 BOT 自己决定找谁。你不需要 `@某人`。
- **是任务，不是群聊消息。** 一次派活带期望完成数和截止时间。三个 BOT 都报完，发起方**只被唤醒一次**，一次拿到三份结果。
- **档案归人，记忆归 BOT。** BOT 改不了自己的名字、工具权限和协作名单；它只能写自己的记忆和简介。
- **不用学新面板。** 会话标题栏一个按钮、侧栏一个图标。侧栏原样保留。

### 安装

```sh
dsh plugin --profile web add dsh-session-bot
```

然后在 profile 的 `cordis.patch.yml` 里给插件填配置：

```yaml
- id: dsh-session-bot
  config:
    stateDir: /path/to/bot-state     # 档案、任务、交接笔记存在这里
    workspace: /path/to/workspace    # 换段后新会话的落点（一般不用改）
```

`stateDir` 必填——插件不猜目录，留空会拒绝激活。

### 30 秒上手

1. 打开你正在用的那个会话（有仓库、有上下文、有历史的那个）。
2. 点会话标题栏右上角的 **`+ BOT`**，填个名字保存。侧栏那一行会出现机器人徽章。
3. 跟它说：**「你是前端 BOT，负责 `packages/main`，改完要跑 pnpm test。」**
4. 在另一个会话里做同样的事：**「你是项目经理。」**
5. 在经理里说：**「让前端 BOT 修一下排序。」** 经理调 `task_create`，前端被唤醒，干完上报。

没有新建 BOT，没有搬工作目录。这就是全部。

### 工具

只注册在已认领的会话里。未认领的会话拿不到任何工具——这是刻意的。

| 工具 | 作用 |
| --- | --- |
| `bot_list` | 所有 BOT 的名字、简介、状态，以及你能不能叫得动它；带两个方向的未完成任务数 |
| `bot_info` | 某个 BOT 的详情（不含它的记忆） |
| `bot_activity` | 某个 BOT 现在手上有哪些活、卡了多久、最后说了什么。**纯读，不会打断它** |
| `bot_remember` | 往自己的记忆里追加 |
| `bot_forget` | 重写或清空自己的记忆 |
| `bot_edit` | 改自己的简介和工作约束 |
| `bot_ask` | 问人一件事，不阻塞自己 |
| `task_create` | 把活派给一到多个协作 BOT，返回任务 id |
| `task_report` | 上报 `done` / `blocked` / `failed` |
| `task_list` | 自己派出去、还没结清的任务 |

### 派活怎么走

```
经理                              前端
   task_create([{bot: 前端, brief: "..."}])
        │
        └── 任务 T-abc ──────────► [任务 T-abc · 来自 经理]
                                    ...干活...
                                    task_report(T-abc, done, "...")
        ◄── 只唤醒一次 ────────────┘
```

- **聚合**：一个任务派给三个人，三份都报完才唤醒发起方一次，不是三次。
- **截止**：每个任务都有超时（默认 30 分钟）。到期时唤醒发起方，并说明还差谁。
- **漏报兜底**：BOT 结束回合时手里还压着没上报的任务，发起方立刻收到提示，不用等超时。
- **单向协作**：一个 BOT 只能派给自己档案里列出的那些 BOT——你画的关系图就是实际的关系图。

### 换段

长对话由 DSH 自己压缩。当你想划一条干净的界线——一批活干完了、下一批开始——就换段：

```
/bot_new_session
  → 写交接笔记（这一段最后说的话 + 记忆）
  → 归档旧段
  → 开新段（同一个工作区、同一个标题）
  → 笔记作为新段的第一条消息
```

历史段可以用 `session_search` 搜（可传 `sessionIds` 限定到某几段）。

换段只能在 BOT 的**当前段**里做；历史段要先在「BOT 信息 → 分段」里设为当前。

### 界面

| 位置 | 作用 |
| --- | --- |
| 会话标题栏右上角 | `+ BOT` / `BOT`：认领或打开档案 |
| 侧栏会话行 | 机器人徽章：蓝色是当前段，灰色是历史段 |
| 侧栏顶部 BOT 图标 | 打开面板 |
| 面板 · 待办 | BOT 用 `bot_ask` 提的问题，可以就地回答 |
| 面板 · BOT | 按项目分组的 BOT 卡片 |
| 面板 · 动态 | 认领、派活、上报、超时、提问、换段的时间线 |

BOT 信息对话框分三个 tab：**档案**（名称/简介/项目/工作约束/记忆）、**分段**（设为当前 / 移除）、**协作**（可派活给谁）。

### 配置

| 键 | 含义 |
| --- | --- |
| `stateDir` | 档案、任务、交接笔记存哪里（**必填**） |
| `workspace` | 换段后新会话的默认工作目录 |
| `bots` | 可选的预置档案，省得手工认领 |

```yaml
bots:
  - sessionId: session-xxxxxxxx
    name: 前端
    brief: 前端 BOT
    detail: 负责 packages/main。Vue + TS。上报前要跑 pnpm test。
    project: LCP
    peers: [bot-yyyyyyyy]      # 它可以派活给谁
```

### 限制

- 同一个工作目录的并发没有协调。两个 BOT 同时改一个仓库，那是你们之间的事。
- 没有群聊。任务有明确的收件人；想让几个 BOT 讨论，写进任务描述里。
- BOT 改不了自己的协作名单和项目——那是人的决定。

### 许可

MIT

---

## English

**Your sessions are already bots. This plugin just gives them a badge.**

Most "bot team" plugins for DSH make you start over: install the plugin, create new bots, and your existing sessions — with their working directories, their context, their history — are left behind. `dsh-session-bot` goes the other way. Any session you already have can be claimed as a bot in one sentence, and immediately gains a profile, a memory, and the ability to hand work to the other bots in your workspace.

### What you get

- **Zero migration.** No new bot entity, no new agent preset, no new working directory. A bot *is* your session.
- **Hand work to the others without naming them.** You say what needs doing; the bot that owns the work decides who does it. You never type `@someone`.
- **Tasks, not messages.** A hand-off is a task with an expected completion count and a deadline, not a message in a group chat. Three bots finish, and the initiator is woken **once** with all three results.
- **The profile belongs to you, the memory belongs to the bot.** A bot cannot rename itself or grant itself new collaborators. It can only edit its own brief, working constraints and memory.
- **No dashboard to learn.** One button in the session header and one icon in the sidebar. Your existing sidebar stays yours.

### Install

```sh
dsh plugin --profile web add dsh-session-bot
```

Then point the plugin at a state directory in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-session-bot
  config:
    stateDir: /path/to/bot-state     # where profiles, tasks and handoff notes live
    workspace: /path/to/workspace    # where rotated sessions land (usually leave this alone)
```

`stateDir` is required — the plugin refuses to guess a directory and will not activate without it.

### Use it in 30 seconds

1. Open any session you already work in — the one with the repository, the context, the history.
2. Click **`+ BOT`** in the session header and give it a name. A badge appears on that sidebar row.
3. Say: **"You are the frontend bot. You own `packages/main`. Run `pnpm test` before reporting."**
4. Do the same in another session: **"You are the project manager."**
5. In the manager, say: **"Ask the frontend bot to fix the sorting."** The manager calls `task_create`, the frontend session wakes, does the work, and reports back.

That's the whole loop. No new bots were created, and no working directory moved.

### Tools

Registered only in claimed sessions. Unclaimed sessions get none — that is deliberate.

| Tool | What it does |
| --- | --- |
| `bot_list` | All bots with purpose and status, whether you may call them, and pending counts in both directions |
| `bot_info` | One bot's details (never its memory) |
| `bot_activity` | What a bot is holding right now, how long it has waited, what it said last. **Read-only, never interrupts it.** |
| `bot_remember` | Append to your own memory |
| `bot_forget` | Rewrite or clear your own memory |
| `bot_edit` | Edit your own brief and working constraints |
| `bot_ask` | Ask the human a question without blocking |
| `task_create` | Hand work to one or more collaborator bots; returns a task id |
| `task_report` | Report `done` / `blocked` / `failed` on a task handed to you |
| `task_list` | Your own outbound tasks that are still pending |

### How a hand-off works

```
manager                          frontend
   task_create([{bot: frontend, brief: "..."}])
        │
        └── task T-abc ──────────► [task T-abc · from manager]
                                    ...does the work...
                                    task_report(T-abc, done, "...")
        ◄── woken once ────────────┘
```

- **Aggregation.** Create one task with three targets, and the initiator is woken when all three report — not three times.
- **Deadline.** Every task expires (30 minutes by default). On expiry the initiator is woken with exactly who is missing, so nobody waits forever.
- **Forgotten reports.** If a bot ends a turn while holding an unreported task, the initiator hears about it instead of waiting for the deadline.
- **One-way collaboration.** A bot can only hand work to bots listed in *its own* profile, so the graph is exactly the one you drew.

### Rotation

Long conversations get compacted by DSH itself. When you want a clean boundary — a batch of related work is finished and the next batch starts — rotate:

```
/bot_new_session
  → handoff note written (the last thing said in this segment + memory)
  → old segment archived
  → new segment opened, same workspace and title
  → the note becomes the first message of the new segment
```

Archived segments stay searchable through `session_search` (pass `sessionIds` to narrow it down).

Rotation only works in a bot's **current** segment. To go back to an older one, open **BOT info → Segments** and set it as current.

### UI

| Where | What |
| --- | --- |
| Session header, top right | `+ BOT` / `BOT`: claim a session or open its profile |
| Sidebar session row | Robot badge: blue for the current segment, grey for a historical one |
| Sidebar top, BOT icon | Opens the panel |
| Panel · Pending | Questions asked through `bot_ask`, answerable in place |
| Panel · Bots | Bot cards grouped by project |
| Panel · Activity | Timeline of claims, hand-offs, reports, expiries, questions, rotations |

The bot profile dialog has three tabs: **Profile** (name, brief, project, working constraints, memory), **Segments** (set current / remove), **Collaboration** (who this bot may hand work to).

### Configuration

| Key | Meaning |
| --- | --- |
| `stateDir` | Where bot profiles, tasks and handoff notes are stored (**required**) |
| `workspace` | Working directory for sessions created by a rotation |
| `bots` | Optional preset profiles, so you do not have to claim them by hand |

```yaml
bots:
  - sessionId: session-xxxxxxxx
    name: frontend
    brief: Frontend bot
    detail: Owns packages/main. Vue + TS. Run pnpm test before reporting.
    project: LCP
    peers: [bot-yyyyyyyy]      # who this bot may hand work to
```

### Limits

- Concurrency on the same working directory is not coordinated. If two bots edit the same repo at once, that is between you and them.
- No group chat. A task has explicit recipients; if you want a conversation among several bots, that is what the task brief is for.
- No automatic profile editing. Changing a bot's collaborators or project is a human action.

### License

MIT
