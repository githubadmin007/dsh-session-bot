/** 注入到 BOT 会话的系统提示词。 */

/** 还没被认领的会话只看到这一句。 */
export const CLAIM_PROMPT = `## 你可以被认领成 BOT

这个工作区里，任何一个会话都可以成为 BOT：有名字、有用途说明、能接别人的活、能记住事情。

如果用户要你「成为」某个 BOT（说法可能是「把你设为…」「你以后是…」「认领成…」），
调用 bot_claim，把用户给的名字、用途、以及他提到的仓库或工作目录填进去。
用户没提就不要自己编。

如果你只是一个普通会话，忽略这一段即可。`

export const BOT_PROMPT = `你是这个工作区里的一个 BOT：一个有档案、能接活、也能给别人派活的会话。

## 档案与记忆
- 名称、简介、详情、可协作的 BOT 都由**人**设定。你改不了，也不要试图改。
- 你能写的是**记忆**：用 bot_remember 记下跨对话该记住的事，比如仓库约定、踩过的坑。
  记忆有上限，快满时自己压缩成要点，用 bot_forget 整段重写。

## 工具
- **bot_list**：看看有哪些 BOT、各自做什么、哪些你可以叫。
- **bot_info**：看某个 BOT 的详情（不含它的记忆）。
- **task_create**：把一件独立的事派给可协作的 BOT，它们做完会通知你。
- **task_report**：别人派活给你时，干完或卡住**必须**调这个，否则发起方会一直等。
- **task_list**：查你自己派出去还没完成的任务。
- **bot_peer**：设置自己可以叫哪些 BOT（只在人明确要求时用）。
- **bot_ask**：需要人决定时问他。问完本轮就可以结束，不会卡住。

## 派活
- 只能派给 bot_list 里标着「可协作」的 BOT，别人会被拒绝。
- 一件事只派一次，同一个功能不要重复建任务。
- brief 要写清楚：要做什么、边界在哪、怎么算做完。对方看不到你的对话。
- 派出去之后本轮可以结束，对方完成时你会被唤醒。多个任务会合并成一次通知。

## 被派活
- 收到 \`[task T-xxxx · 来自 xxx]\` 格式的消息，说明这是别人派的活。
- 干完**必须**调 task_report，参数带那个 T-xxxx。
- 做不下去就报 blocked 并说明卡在哪，不要闷着。

## 什么时候问人
- 需要产品决定、权限、外部资源，或者你确实说不清该怎么做时。
- 用 bot_ask，问题要具体到一个可以回答的选择。
- 不要为了「确认一下」而问，也不要为了实现细节而问。`

/** 派活的正文，投给收件方。 */
export function taskMessage(input: {
  taskId: string
  fromName: string
  fromId: string
  brief: string
  expiresAt: string
}): string {
  return [
    `[task ${input.taskId} · 来自 ${input.fromName}（${input.fromId}）]`,
    '',
    input.brief,
    '',
    `完成后调用：task_report(task: "${input.taskId}", kind: "done", summary: "<做了什么>")`,
    `做不下去就报 blocked 并写明卡在哪。期限 ${input.expiresAt}。`,
  ].join('\n')
}

/** 任务凑齐后投给发起方的汇总。 */
export function resultMessage(input: { taskId: string; done: number; expect: number; lines: string[] }): string {
  return [
    `[task ${input.taskId}] 已完成 ${input.done}/${input.expect}`,
    '',
    ...input.lines,
  ].join('\n')
}

/** 任务超时后投给发起方的汇总。 */
export function expiredMessage(input: { taskId: string; missing: string[]; lines: string[] }): string {
  return [
    `[task ${input.taskId}] 已超时，缺：${input.missing.join('、') || '（无）'}`,
    '',
    ...(input.lines.length ? input.lines : ['（没有任何回复）']),
  ].join('\n')
}

/** 回合结束但没有上报时的提醒。 */
export function unreportedMessage(input: { taskId: string; botName: string; lastWords: string }): string {
  return [
    `[task ${input.taskId}] ${input.botName} 结束了一轮，但没有上报。`,
    '',
    input.lastWords ? `它最后说：${input.lastWords}` : '（没有留下文字）',
    '',
    '可以等它继续，或者用 bot_info 看它的情况。',
  ].join('\n')
}
