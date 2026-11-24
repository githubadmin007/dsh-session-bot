/** 插件配置。 */
import { z } from 'zod'

const absolute = (description: string) =>
  z.string().trim().regex(/^([A-Za-z]:[\\/]|\/)/, 'An absolute path').describe(description)

export const ConfigSchema = z.object({
  stateDir: absolute('Where bot profiles, tasks and handoff notes are kept'),
  /** 换段后新会话的默认工作目录。 */
  workspace: absolute('Working directory for sessions created after a rotation'),
  /** 预置档案：省得每次都要从界面认领。键是 DSH 会话 id。 */
  bots: z.array(z.object({
    sessionId: z.string().min(1),
    name: z.string().min(1),
    brief: z.string().default(''),
    detail: z.string().default(''),
    project: z.string().default(''),
    peers: z.array(z.string()).default([]),
  })).default([]),
}).strict()

export type Config = z.infer<typeof ConfigSchema>
