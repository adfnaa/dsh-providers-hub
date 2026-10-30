import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isSignedQueryValueSafe, signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'

/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export const OPENGW_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export const SNAP_MODEL_BUILTIN_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin'

/**
 * snap-access AgentCenter 端点组 — **动态上下文窗口权威源**（2026-10-29 接入）。
 *
 * ## 为什么需要第三个来源
 *
 * 上下文窗口此前只有**静态表**（`CONTEXT_WINDOWS`，llm-adapter.ts），而静态表
 * 必然腐坏：GLM-5.2 实测 2026-09~10 为 202_752、10-21 起上游改成 1_048_576、
 * **10-29 IDE 0.2.6 抓包又改回 202_752** —— 每次漂移都让插件的下分母错数倍
 * （占用条 / 自动压缩阈值全错）。而 builtin 与 gateway/config 两个端点都实测
 * **不下发**任何窗口字段（providers-codearts.md 笔记）。
 *
 * AgentCenter（`codearts2api` 参考实现一直在用的两个端点，2026-10-29 用本仓
 * STS 凭据真机验证）是唯一找到的**按账号动态下发窗口**的来源：
 *
 * 1. `GET /v1/agent-center/agents/useragents?offset=0&limit=100`
 *    → `{ agents: [{ id, is_primary_agent, ... }] }`；
 * 2. `GET /v1/agent-center/agents/detail?agent_id={id}`
 *    → `{ gpts: { models: [{ model_id, model_alias, model_parameters:
 *         { context_window, max_tokens, supports_images } }] } }`。
 *
 * 实测 8 模型全带窗口，与 IDE 内核 `/cag/global/config` 权威**逐值一致**
 * （GLM-5.2=202752 max 65536、openpangu=524288、glm-5.3 / ds-v4.1-flash(-1017)
 * / kimi-k3=1048576）。取 primary agent（`is_primary_agent`，缺省第一条）。
 *
 * ## 签名与路由要求（全部真机判别过）
 *
 * - `agent-type: AgentCenter` + `x-language: zh-cn` 头**必须带且参与签名**
 *   （不带 x-language ⇒ 400 `TM.00001001`「未找到合法可路由api」；带 AgentCenter
 *   打 PromptCenter 专有端点也回同一 400 —— 该头是**路由判据**）；
 * - query 必须**排序**后签名（`offset` < `limit` 恰好已是字典序，但本 signer
 *   现已统一排序，见 `canonicalQueryOf`）；
 * - `accept` / `content-type`（GET）参与与否都 200（非必需）。
 */
export const SNAP_AGENT_CENTER_USERAGENTS_URL =
  'https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/useragents?offset=0&limit=100'
export const SNAP_AGENT_CENTER_DETAIL_URL =
  'https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/detail'

/** 远端动态模型列表缓存文件名（~/.cache/deveco/codearts_models.json）。 */
const CODEARTS_MODELS_CACHE_FILENAME = 'codearts_models.json'

/**
 * benefit（免费额度）模型 id 集合的缓存文件名
 * （~/.cache/deveco/codearts_benefit_models.json）。
 *
 * 与模型列表分开缓存：判定 `maas_type` 只关心 id 集合，且 chat 请求在每次
 * 签名前都要查它，独立文件可避免解析整份模型元数据。
 */
const CODEARTS_BENEFIT_CACHE_FILENAME = 'codearts_benefit_models.json'

/** 动态模型拉取超时（ms）。 */
const FETCH_TIMEOUT_MS = 10_000

/** 定时刷新远端模型列表的间隔（2 小时）。 */
export const MODEL_REFRESH_INTERVAL_MS = 2 * 3_600_000

export interface RemoteModel {
  id: string
  name: string
  /**
   * 消耗倍率的**展示串**（如 `0.7x`）；取不到时为 `undefined`。
   *
   * ⚠️ 为什么存**展示串**而不是数值（2026-10-21）：
   * 上游 `/v1/model/builtin` 的 `credit[]` 同时给了两个数 ——
   * `ratio`（`0.05`）与 `ratio_display`（`0.7x`），而**主界面显示的是后者**，
   * 两者**不是同一个量纲**（`GLM-5.2` ratio=0.05 却显示 0.7x；
   * `deepseek-v4.1-flash` 同样 ratio=0.05 却显示 0.18x）。
   * ⇒ 存数值再去拼 `x{n}` 会**编造出一个上游没显示过的倍率**（本仓红线：
   *   绝不臆造上游未下发的数）。故直接取 `ratio_display`，取不到就不显示。
   */
  rateLabel?: string
  /**
   * 上下文窗口（tokens）—— **仅来自 AgentCenter**（见
   * `SNAP_AGENT_CENTER_USERAGENTS_URL` 的注释），取不到时为 `undefined`
   * （调用方回退静态表，见 llm-adapter.ts 的 `codeartsContextWindow`）。
   *
   * ⚠️ 动态值**优先于**静态表（AgentCenter 与 IDE 内核权威逐值一致，静态表
   * 有腐坏史：GLM-5.2 三次漂移）；但它**不在**完整性判据里（`isRemoteCatalogComplete`
   * 不看它）—— AgentCenter 失败只是窗口退化到静态表，目录本身仍完整。
   */
  contextWindow?: number
  /**
   * ⚠️⚠️ **刻意移除**（2026-10-30 第二轮审计 D-4 修）：AgentCenter 的
   * `max_tokens`（单次输出上限）**不再**进 `RemoteModel`。
   *
   * 原因：它唯一的去处是 `CatalogEntry.maxTokens` ⇒ `defaultMaxTokens` ⇒
   * 宿主 `dsh-compaction-basic` 的 `reservedCompletionTokens` 把它**从上下文
   * 窗口里扣掉**（压缩触发点 162,201→109,772；窗口 131,072 的模型 ⇒ 宿主
   * **抛** `TargetPressureConfigError`）⇒ 那是**错的语义**（「上限」被当成
   * 「默认输出预算」+「上下文预留」）。
   *
   * ⚠️ **保留它作为死字段是有害的**：它会被 `saveModelsCache` **序列化进磁盘
   * 缓存**（误导后来者以为它在用）⇒ 一并移除。
   * ⚠️ 上游的 `max_tokens` 仍在 `readAgentCenterWindow` 的**原始读取**里
   * 可见（取证用），但**不再**流向任何出站预算 —— 出站预算由
   * `CODEARTS_MAX_OUTPUT_TOKENS`（llm-adapter.ts）**单点**决定。
   */
  /**
   * ⚠️⚠️ **只作窗口源、刻意不进目录**（2026-10-30 四路审计 P1-2 定案）。
   *
   * AgentCenter 有、而 builtin / gateway-config 目录里没有的 id（实测 `kimi-k3`）
   * **只提供窗口**，**不作为目录条目**。理由两条：
   *
   * 1. **倍率必然缺失** ⇒ 违反本仓红线「倍率必须进 name」
   *    （`src/llm-adapter.ts` 的 `toCatalogEntry` 注释逐字：「倍率**必须**拼进
   *    `name`（与 officeace / buddy / loomy / raccoon 同款）」）。AgentCenter 的
   *    `model_parameters` **只有** `context_window` / `max_tokens` /
   *    `supports_images`，**没有倍率** ⇒ 进目录后 `name` 是裸名 ⇒
   *    `src/aggregate-core.ts` 的 `priceFactorFromName('Kimi K3')` = **`Infinity`**
   *    ⇒ `rankCandidates` 的第三判据「同临期档内倍率升序」**恒挑不到它**
   *    ⇒ codearts 在聚合轮换列表里**永远排在最后**（静默）。
   *    这与 `docs/agent-notes/providers-accio.md` §7 记的「`CANONICAL_OVERRIDES`
   *    漏登记 ⇒ 拆分孤例 ⇒ 轮换列表看不到它」**完全同型**。
   * 2. 用户可见的一致性：同一渠道其它模型显示 `GLM-5.2 · x0.7`，这一条显示裸名
   *    ⇒ 用户会以为它免费/无倍率信息。
   *
   * ⇒ 这些 id **仍然能被正确解析**：`unknownModelContextWindow` 查的是
   * **独立的窗口表**（`src/llm-adapter.ts` 的 `remoteContextWindows`），与
   * 「目录可见性」解耦 ⇒ 手填 id 时分母仍取 AgentCenter 的权威值。
   */
  windowOnly?: boolean
}

/**
 * 一次远端目录拉取的**完整性**结果（issue IKJVTF，审计 I3）。
 *
 * ## 为什么需要它
 *
 * CodeArts 的目录来自**两个独立端点**（`opengw gateway/config` 给 benefit 模型、
 * `snap-access /v1/model/builtin` 给常规模型），而两处的失败路径都是
 * `fetchSignedGet` **静默返回 `undefined`**。于是「一个成功、一个失败」时
 * `models.length > 0` ⇒ 适配器判成「已拿到目录」⇒ **永久缓存**（
 * `if (this.remoteModels !== undefined) return` 短路）⇒ 残缺目录固化，
 * 只有重启 DSH 才能恢复（与 Cline 的缺陷② 完全同构）。
 *
 * ⇒ 取数函数必须**显式**回报「每个来源到底成功没有」，适配器据此决定
 * 「只展示（`got`）」还是「也永久缓存（`complete`）」。
 */
export interface RemoteCatalogOutcome {
  /** 各来源的成败（`gateway` / `builtin`），供适配器判完整性。 */
  gatewayOk: boolean
  builtinOk: boolean
}

/** 两个来源是否**都**取到了。 */
export function isRemoteCatalogComplete(outcome: RemoteCatalogOutcome): boolean {
  return outcome.gatewayOk && outcome.builtinOk
}

/** 模块级内存缓存：远端拉取或磁盘加载后填充；availableCodeArtsModels 优先读取。 */
let memoryCache: RemoteModel[] | undefined

/** benefit 模型 id 集合的内存缓存：远端拉取或磁盘加载后填充。 */
let benefitMemoryCache: string[] | undefined

/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 *
 * ⚠️⚠️ **2026-10-27 修订：本函数不再是「暴露给用户的那个 id」的裁剪刀。**
 *
 * 实测（IDE 内核日志 `kernel-codeartsdoer-incognito-2026-10-27T220300`）：
 * `/v1/model/builtin` **同时**下发两个**独立**条目 ——
 *
 * ```
 * {"model_id":"deepseek-v4.1-flash",      "model_name":"DeepSeek-V4.1-Flash",      ...}
 * {"model_id":"deepseek-v4.1-flash-1017", "model_name":"DeepSeek-V4.1-Flash-1017", ...}
 * ```
 *
 * 两者 `model_type` 都是 `admin`、`context` 都是 `1048576`，是**上游并存的旧版与新版**。
 * 修前 `parseModelInfo` 拿本函数的**产物**做 `seen` 去重键 ⇒ 带版本号的那条被静默吞掉
 * ⇒ 用户报障「IDE 里已更新到 1017，我们的列表没更新」（虽然不是没拉到远端，
 * 而是拉到后被自己去重吃掉）。
 *
 * ⇒ 现在 `parseModelInfo` 用**原始 `model_id`** 做去重键与对外 id，
 * 本函数只保留两处**内部**用途：
 * 1. gateway 分支判断「该 id 是否带日期后缀」（决定是否记为 benefit，见下方注释）；
 * 2. `model_name` 缺失时给一个不含版本号的兜底 id。
 *
 * ⚠️ 若将来发现某个带后缀的 id 在 chat 端点**不可用**，处置方式是在
 * `parseModelInfo` 里**显式跳过**那一条（并登记实测），**不要**退回「统一裁剪」——
 * 那会把上游有意并存的版本再次合并掉。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5)
    }
  }
  return id
}

function parseModelInfo(
  m: Record<string, unknown>,
  seen: Set<string>,
  /** 取倍率时用的「现在」（单测注入；缺省 `Date.now()`）。 */
  nowMs?: number,
): RemoteModel | undefined {
  const rawId = m['model_id']
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined
  /**
   * ⚠️⚠️ **对外 id 用原始 `model_id`，不裁版本后缀**（2026-10-27 修）。
   *
   * 上游把「旧版」与「带日期的新版」当成**两个独立条目**同时下发
   * （实测 `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-1017` 并存，
   * 两者 `model_type` 都是 `admin`、`context` 都是 1048576）。
   * 修前这里用 `normalizeModelId(rawId)` 的产物做 id 与去重键 ⇒ 带版本号的那条
   * 被静默吞掉 ⇒ 用户看到「IDE 已更新 1017，插件列表没更新」。
   *
   * ⚠️ 因此 `seen` 的键也必须是 rawId —— 用归一后的 id 会把两条并成一条。
   */
  const id = rawId
  // 过滤视觉（VL）多模态模型
  // id 含 -VL- 或以 -VL 结尾（如 Qwen3-VL-235B），上下文小、不支持工具调用，
  // 不适合当 agent 主模型，从列表隐藏；只通过 analyzeImage 等工具间接调用。
  if (id.includes('-VL-') || id.endsWith('-VL')) return undefined
  const rawName = m['model_name']
  /**
   * ⚠️ 展示名也**不裁版本后缀**：`DeepSeek-V4.1-Flash-1017` 里的 `1017` 正是
   * 用户要看的版本信息（裁掉就与旧版同名、无法区分）。
   */
  const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : id
  if (seen.has(id)) return undefined
  seen.add(id)
  return { id, name, ...readRateLabel(m, nowMs) }
}

/**
 * 从 `/v1/model/builtin` 的单条模型里读**展示用倍率串**。
 *
 * ## 字段实况（2026-10-21 真机取证，8 个模型）
 *
 * ```json
 * "credit": [{ "ratio":"0.05", "ratio_display":"0.7x", "before_display_ratio":null }]
 * ```
 *
 * 6 个常规模型有 `credit[0]`，两个 VL 模型（`Qwen3-VL-235B` / `kimi-k2.6-vl`）
 * **整个 `credit` 数组为空**（它们上面已被 `parseModelInfo` 滤掉，这里只是顺带记下）。
 *
 * ⚠️ **只取 `ratio_display`，不取 `ratio`**：
 * 两个字段不同量纲（见 `RemoteModel.rateLabel` 的注释），用 `ratio` 拼串
 * 会显示出一个上游主界面从未出现过的数字。
 *
 * ⚠️ 任何一步取不到就返回空对象（**不落 `rateLabel` 键**）—— 调用方据此
 * 保持裸名，与「上游没给倍率」完全同形（绝不用占位值冒充）。
 */
function readRateLabel(m: Record<string, unknown>, nowMs: number = Date.now()): { rateLabel?: string } {
  const credit = m['credit']
  if (!Array.isArray(credit) || credit.length === 0) return {}
  // ⚠️ **按时段选档**，不是无脑取 `credit[0]`（2026-10-21 真实缺陷）。
  //    `deepseek-v4.1-flash` 有两档，且**当前生效的可能是第二档**：
  //      · `default`  → 0.18x
  //      · `off_peak` → 0.09x（每晚 21:00 起、持续 11 小时 = 至次日 7:59，Asia/Shanghai）
  //    取 `credit[0]` 会在整个错峰时段显示**过高的 0.18x**（用户当场发现）。
  const slots = m['time_slots']
  const picked = pickActiveCredit(credit, slots, nowMs)
  if (picked === undefined) return {}
  const display = picked['ratio_display']
  if (typeof display !== 'string' || display.length === 0) return {}
  return { rateLabel: display }
}

/**
 * 从 `credit[]` 里挑出**当前时段生效**的那一档。
 *
 * ## 实况（2026-10-21 真机取证）
 *
 * ```json
 * "time_slots": {
 *   "off_peak": { "timezone":"Asia/Shanghai", "schedule":"0 0 21 * * *",
 *                 "duration":11, "timeunit":"hour", ... },
 *   "default":  { "schedule":null, "duration":null }
 * }
 * ```
 *
 * ⇒ `schedule` 是 **6 段 cron（秒 分 时 日 月 周）**，`duration`+`timeunit` 给窗口长度。
 * 只有 `deepseek-v4.1-flash` 真正带时段；`openpangu-2.0-pro` 虽有两档，但两档的
 * `time_slot_id` 都是 `null`、display 也相同 ⇒ 取任一都对。
 *
 * ⚠️ **不做通用 cron 解析器**（本仓红线：不为一种上游形态臆造一套通用实现）。
 * 只认已实测的这一种：固定的「时分 + 小时时长」窗口；解析不出就退回
 * `credit[0]`（与上游「无时段」时同形）。
 */
function pickActiveCredit(
  credit: unknown[],
  slots: unknown,
  nowMs: number,
): Record<string, unknown> | undefined {
  const entries = credit.filter(
    (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
  )
  if (entries.length === 0) return undefined
  if (typeof slots !== 'object' || slots === null) return entries[0]

  for (const entry of entries) {
    const slotId = entry['time_slot_id']
    if (typeof slotId !== 'string') continue
    const slot = (slots as Record<string, unknown>)[slotId]
    if (typeof slot !== 'object' || slot === null) continue
    if (isTimeSlotActive(slot as Record<string, unknown>, nowMs)) return entry
  }
  return entries[0]
}

/**
 * 判断一个 `time_slot` 此刻是否生效。
 *
 * ⚠️ 时区**硬取 Asia/Shanghai**（上游明确下发 `timezone` 字段，且本仓已有
 * 同口径先例：`auto-checkin.ts` 的 `utc8DateString` 用算术平移而非本机时区
 * —— 用户出差/改系统时区时不该改变结果）。
 */
function isTimeSlotActive(slot: Record<string, unknown>, nowMs: number): boolean {
  const schedule = slot['schedule']
  if (typeof schedule !== 'string' || schedule.length === 0) return false
  // 6 段 cron：秒 分 时 日 月 周（实测形态 `0 0 21 * * *`）
  const parts = schedule.trim().split(/\s+/)
  if (parts.length < 3) return false
  const hour = Number(parts[2])
  const minute = Number(parts[1])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false

  const duration = Number(slot['duration'])
  const unit = slot['timeunit']
  if (!Number.isFinite(duration) || duration <= 0) return false
  // 只认小时（实测唯一形态）；其他单位不臆造换算。
  if (unit !== 'hour') return false

  // 算术平移到 Asia/Shanghai（UTC+8）后取「当天已过分钟数」。
  const shanghaiMs = nowMs + 8 * 3600_000
  const dayMinutes = Math.floor(shanghaiMs / 60_000) % (24 * 60)
  const startMinutes = hour * 60 + minute
  const windowMinutes = duration * 60
  // ⚠️ 窗口可以**跨日界**（21:00 + 11h → 次日 7:59）：取模处理。
  const offset = (dayMinutes - startMinutes + 24 * 60) % (24 * 60)
  return offset < windowMinutes
}

/** 从 JSON 响应中沿路径指针取数组。 */
function extractJsonArray(text: string, path: string[]): unknown[] | undefined {
  try {
    let value: unknown = JSON.parse(text)
    for (const key of path) {
      if (typeof value !== 'object' || value === null) return undefined
      value = (value as Record<string, unknown>)[key]
    }
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 签名 GET 请求远端端点并读取文本；网络失败或非 200 时返回 undefined
 * （不阻断调用方）。
 */
async function fetchSignedGet(
  fetcher: typeof fetch,
  url: string,
  ak: string,
  sk: string,
  st: string,
  /** 签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）。 */
  extraUnsignedHeaders?: Readonly<Record<string, string>>,
  /**
   * **参与签名**的额外头（传入 `signRequestHuawei` 的 `extraHeaders`）——
   * AgentCenter 的 `agent-type` / `x-language` 是路由判据，必须签上
   * （builtin 的 Agent-Type 实测不签也能过，但 AgentCenter 按同口径从严）。
   */
  extraSignedHeaders?: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  // ⚠️⚠️ **query 值必须落在安全集内**，否则**不发这个请求**（2026-10-30 审计 P2 D1）。
  //
  //    `canonicalQueryOf` 的往返（decode → encode）在安全集外**可能与服务端口径
  //    分叉**（`+` 在表单语义下是空格、`&`/`=` 会被重编码）⇒ 服务端按自己收到
  //    的参数重算 canonical 时算出**另一个值** ⇒ `401 verify ak sk signature fail`。
  //
  //    ⇒ 与其静默 401（症状是「目录拿不到窗口 ⇒ 分母退化」，与「上游没这模型」
  //    **同形**，极难定位），不如**当场不发**并留一条脱敏日志。
  //    ⚠️ 现网全部 query 值都在安全集内（uuid、模型 id、`msg`、`DESKTOP`、数字）
  //    ⇒ 这道闸**当前不会拦掉任何真实请求**（它只拦「上游改口径」这种情况）。
  if (!isSignedQueryValueSafe(url)) {
    console.warn('[codearts] 已跳过一个 query 值不在安全集内的签名请求（避免验签分叉）')
    return undefined
  }
  const signed = await signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array(), extraSignedHeaders)
  const headers = new Headers()
  signed.forEach((v, k) => {
    if (k !== 'host') headers.set(k, v)
  })
  if (extraUnsignedHeaders !== undefined) {
    for (const [k, v] of Object.entries(extraUnsignedHeaders)) headers.set(k, v)
  }
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * AgentCenter 单模型的 `model_parameters` → 动态窗口。
 *
 * ⚠️ 只认**正整数**（上游实测形态 `202752` / `1048576`）；浮点、0、
 * 负数、字符串一律**不落键**（绝不臆造/强转 —— 字符串数字强转是「静态表
 * 腐坏」的同型病：上游改形态时就静默喂错值）。
 *
 * ⚠️⚠️ **`max_tokens` 刻意不取**（2026-10-30 第二轮审计 D-4 修）：
 * 它是「单次输出上限」，而本仓唯一的去处 `CatalogEntry.maxTokens` 会被
 * 宿主当成「默认输出预算」+「上下文预留」⇒ **压缩阈值掉 48%**、小窗口模型
 * 直接抛 `TargetPressureConfigError`。⇒ 上游的输出上限**不**进
 * `RemoteModel`（见该接口 `contextWindow` 旁的注释）；出站预算由
 * `CODEARTS_MAX_OUTPUT_TOKENS` 单点决定。
 */
export function readAgentCenterWindow(
  m: Record<string, unknown>,
): { contextWindow?: number } {
  const params = m['model_parameters']
  if (typeof params !== 'object' || params === null) return {}
  const p = params as Record<string, unknown>
  const out: { contextWindow?: number } = {}
  const ctx = p['context_window']
  if (typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0) out.contextWindow = ctx
  return out
}

/**
 * 拉 AgentCenter 的动态窗口表（best-effort：两步请求**任何一步**失败都返回
 * 空 Map，**不阻断**调用方 —— 窗口缺失只是退化到静态表，目录本身不受影响）。
 *
 * 流程：`useragents` 选 primary agent（`is_primary_agent`，无标记取第一条）
 * → `detail?agent_id=` → `gpts.models[]` 按 `model_id` 收
 * `{ contextWindow, name }`（name = `model_alias`）。
 * 只有带窗口的条目才收（无窗口的条目对调用方无信息量）。
 */
export async function fetchAgentCenterWindows(
  fetcher: typeof fetch,
  ak: string,
  sk: string,
  st: string,
): Promise<Map<string, { contextWindow: number; name?: string }>> {
  const out = new Map<string, { contextWindow: number; name?: string }>()
  // 路由判据头必须**参与签名**（去掉 x-language ⇒ 400 TM.00001001，
  // 真机判别 2026-10-29；accept 实测非必需）。
  const signedExtras = { 'agent-type': 'AgentCenter', 'x-language': 'zh-cn' } as const
  const listText = await fetchSignedGet(fetcher, SNAP_AGENT_CENTER_USERAGENTS_URL, ak, sk, st, undefined, signedExtras)
  if (listText === undefined) return out
  let agents: unknown[]
  try {
    const parsed: unknown = JSON.parse(listText)
    const arr = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['agents']
      : undefined
    if (!Array.isArray(arr)) return out
    agents = arr
  } catch {
    return out
  }
  // 选 primary agent：有标记的优先，否则第一条可用的（与 codearts2api 参考实现同口径）。
  let agentId: string | undefined
  for (const item of agents) {
    if (typeof item !== 'object' || item === null) continue
    const a = item as Record<string, unknown>
    const id = typeof a['id'] === 'string' ? a['id'] : undefined
    if (id === undefined || id.length === 0) continue
    if (a['is_primary_agent'] === true) { agentId = id; break }
    if (agentId === undefined) agentId = id
  }
  if (agentId === undefined) return out

  const detailUrl = `${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=${encodeURIComponent(agentId)}`
  const detailText = await fetchSignedGet(fetcher, detailUrl, ak, sk, st, undefined, signedExtras)
  if (detailText === undefined) return out
  try {
    const parsed: unknown = JSON.parse(detailText)
    if (typeof parsed !== 'object' || parsed === null) return out
    const gpts = (parsed as Record<string, unknown>)['gpts']
    if (typeof gpts !== 'object' || gpts === null) return out
    const gptsModels = (gpts as Record<string, unknown>)['models']
    if (!Array.isArray(gptsModels)) return out
    for (const item of gptsModels) {
      if (typeof item !== 'object' || item === null) continue
      const m = item as Record<string, unknown>
      const id = typeof m['model_id'] === 'string' ? m['model_id'] : ''
      if (id.length === 0) continue
      const w = readAgentCenterWindow(m)
      if (w.contextWindow === undefined) continue
      const alias = m['model_alias']
      out.set(id, {
        contextWindow: w.contextWindow,
        ...(typeof alias === 'string' && alias.length > 0 ? { name: alias } : {}),
      })
    }
  } catch {
    return out
  }
  return out
}

/**
 * 从三个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（benefit 模型）
 * 2. snap-access /v1/model/builtin → builtinModels（常规模型）
 * 3. snap-access AgentCenter → 动态上下文窗口（best-effort，见
 *    {@link fetchAgentCenterWindows}；**不参与**完整性判据）
 * 失败或空凭据时返回空数组（不阻断）。
 *
 * 同时把 gateway/config 下发的 benefit 模型 id 集合写入独立缓存
 * （见 {@link saveBenefitCache}），供 chat 请求判定是否带 `maas_type: benefit`。
 */
export async function fetchCodeArtsRemoteModels(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = fetch,
  /**
   * 各来源成败的**出参**（issue IKJVTF，审计 I3）。
   *
   * ⚠️ 用出参而非改返回值：本函数的既有调用方与 10 条单测都按「返回数组」用，
   * 改形状会波及它们；而完整性只对**适配器**有意义（它决定要不要永久缓存）。
   * 不传即不关心完整性，行为逐字节不变。
   */
  outcome?: RemoteCatalogOutcome,
  /**
   * 「现在」的时刻（毫秒）—— **只为倍率选时段**用。
   *
   * ⚠️ 加它是因为倍率**随时间变**（`deepseek-v4.1-flash` 错峰档 21:00–次日 7:59
   * 显示 0.09x，其余时段 0.18x）。单测必须能注入时刻，否则「是否落在错峰窗口」
   * 这条逻辑无法被确定性覆盖。缺省 `Date.now()` ⇒ 生产行为不变。
   */
  nowMs: number = Date.now(),
): Promise<RemoteModel[]> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) {
    // 无凭据时**两个来源都没取到** —— 不能默认成 true（否则残缺被判成完整）。
    if (outcome !== undefined) {
      outcome.gatewayOk = false
      outcome.builtinOk = false
    }
    return []
  }

  const models: RemoteModel[] = []
  const seen = new Set<string>()
  // 来自 gateway/config 的 benefit 模型 id —— 调用时必须带 maas_type: benefit。
  //
  // ⚠️ 只记录**未被去掉日期后缀**的 id（即 chat 请求真正发出的那个 id）。
  // 原因：normalizeModelId 会把 gateway 的 `deepseek-v4-flash-0731` 改写成
  // `deepseek-v4-flash`，而两者在后端是**不同模型**、benefit 属性相反
  // （实测：`-0731` 不带 maas_type → 404；无后缀的不带 → 成功、带上 →
  // `unsupported model`）。记录被改写过的 id 会把无后缀模型错误标记为
  // benefit，导致它反而调用失败。既然该 id 我们根本不发送，它也就无从
  // 决定我们发送的 id 的 benefit 属性。
  const benefitIds: string[] = []

  // 1. opengw gateway/config — benefit 模型（glm-5.3-flash 等）
  //
  // ⚠️ 成功判据是「**请求成功且形状可识别**」，不是「解析出非空列表」：
  // 上游把 benefit 模型全部下架时 `result.models: []` 是**合法**状态，
  // 把它当失败会让冷却永不清理（与 Cline 的 `isClineRecommendedShape` 同口径）。
  const gatewayText = await fetchSignedGet(fetcher, OPENGW_GATEWAY_CONFIG_URL, ak, sk, st)
  const gatewayArr = gatewayText === undefined
    ? undefined
    : extractJsonArray(gatewayText, ['result', 'models'])
  if (outcome !== undefined) outcome.gatewayOk = gatewayArr !== undefined
  if (gatewayArr !== undefined) {
    for (const item of gatewayArr) {
      if (typeof item === 'object' && item !== null) {
        const entry = item as Record<string, unknown>
        const rawId = typeof entry['model_id'] === 'string' ? entry['model_id'] : ''
        const mi = parseModelInfo(entry, seen, nowMs)
        if (mi) {
          // 仅当归一化未改写 id 时才记为 benefit（见上方说明）
          if (rawId.length > 0 && normalizeModelId(rawId) === rawId) benefitIds.push(mi.id)
          models.push(mi)
        }
      }
    }
  }

  // 2. snap-access /v1/model/builtin — 常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）
  //    Agent-Type: PromptCenter + X-Language: zh-cn（不参与签名）。
  //    替代旧 statistics/plugin（已不再返回 model_metrics）。
  const snapText = await fetchSignedGet(fetcher, SNAP_MODEL_BUILTIN_URL, ak, sk, st, {
    'Content-Type': 'application/json',
    'Agent-Type': 'PromptCenter',
    'X-Language': 'zh-cn',
  })
  const snapArr = snapText === undefined
    ? undefined
    : extractJsonArray(snapText, ['builtinModels'])
  if (outcome !== undefined) outcome.builtinOk = snapArr !== undefined
  if (snapArr !== undefined) {
    for (const item of snapArr) {
      if (typeof item === 'object' && item !== null) {
        const mi = parseModelInfo(item as Record<string, unknown>, seen, nowMs)
        if (mi) models.push(mi)
      }
    }
  }

  /**
   * 3. snap-access AgentCenter — **动态上下文窗口**（2026-10-29 接入）。
   *
   * ⚠️⚠️ **刻意不进完整性判据**（`isRemoteCatalogComplete` 仍只看
   * `gatewayOk && builtinOk`）：窗口缺失的后果只是「分母退化到静态表」，
   * 而静态表本就是现状；若把它算进完整性，AgentCenter 一抖动就会让
   * 整份**目录**被拒之门外（不能永久缓存）—— 因果完全不成比例。
   * 失败静默（fetchSignedGet 内已 catch），无日志面。
   *
   * 合并规则：
   * - 目录已有该 id → **补** `contextWindow`（目录端点不下发，不存在冲突，
   *   无需「远端优先」判据）；
   * - AgentCenter 有、目录没有的 id → **只作窗口源**（`windowOnly: true`），
   *   **不进目录**（2026-10-30 审计 P1-2 修：AgentCenter 不下发倍率 ⇒ 进目录
   *   就是裸名 ⇒ `priceFactorFromName` 恒 `Infinity` ⇒ 聚合里永远排最后；
   *   详见 `RemoteModel.windowOnly` 的注释）。
   */
  const agentCenterWindows = await fetchAgentCenterWindows(fetcher, ak, sk, st)
  if (agentCenterWindows.size > 0) {
    for (const model of models) {
      const w = agentCenterWindows.get(model.id)
      if (w === undefined) continue
      model.contextWindow = w.contextWindow
    }
    for (const [id, w] of agentCenterWindows) {
      if (seen.has(id)) continue
      // ⚠️ VL 过滤与目录层同口径（**大小写不敏感**）：`src/llm-adapter.ts` 的
      //    `catalogEntries` 用 `/-VL-/i` 与 `/-VL$/i`，而旧实现这里是
      //    **大小写敏感**（`includes('-VL-')`）⇒ 小写 `-vl` 的 id 会被这里收下、
      //    再被目录层滤掉 ⇒ 落进 `remoteModels` 与磁盘缓存却**永不可见**
      //    （2026-10-30 审计 P3-1）。
      if (/-VL-/i.test(id) || /-VL$/i.test(id)) continue
      // ⚠️ **窗口源，不是目录条目**（见 `RemoteModel.windowOnly` 的注释）。
      //    `name` 仍取 `model_alias`（供诊断/展示用），但它**不会**进目录
      //    ⇒ 不会触发「倍率缺失 ⇒ Infinity」。
      models.push({
        id,
        name: w.name ?? id,
        contextWindow: w.contextWindow,
        windowOnly: true,
      })
      seen.add(id)
    }
  } else {
    // ⚠️ **失败要留痕**（2026-10-30 审计 P3 D8）：静默 ⇒ 「窗口长期退化」与
    //    「上游把窗口改小了」同形且零日志。脱敏：不含任何凭据。
    console.warn(
      '[codearts] AgentCenter 动态窗口不可用，窗口分母将退化到静态兜底表（目录本身不受影响）',
    )
  }

  /**
   * 持久化 benefit 集合：chat 请求签名时据此决定是否带 `maas_type`。
   *
   * ⚠️⚠️ **判据是「gateway 形状可识别」，不是「解析出非空列表」**（2026-10-27 审计 P1 修）。
   *
   * 修前是 `if (benefitIds.length > 0)` —— 注释理由是「避免把空集合覆盖掉可用缓存」。
   * 那条理由**只对了一半**：`result.models: []` 是**合法**状态（上游把 benefit 模型
   * 全部下架 / 该账号无 benefit 通道时就是这样，本文件上面 `outcome.gatewayOk`
   * 的注释也这么写），而修前的写法让这个合法状态**无法落到磁盘** ⇒ 陈旧集合
   * **只增不减**、跨重启存活。
   *
   * ## 后果（对抗审计实测）
   *
   * 磁盘上留着旧版本写下的 `["glm-5.3-flash"]`、而该账号其实已无 benefit 包：
   * 每条请求「带头 → 4004.200 → 领取（**写**）→ 仍 4004 → 去头 → 成功」
   * ⇒ 实测 3 条请求 = **3 次领取 + 6 次 chat**，永久持续（跨重启）。
   * 这与本 PR 删掉静态表的理由（「静态表会过时」）是**同一个病**，只是搬到了磁盘。
   *
   * ⇒ 区分两件事：
   * - **gateway 请求失败 / 形状认不出** ⇒ 不覆盖（保留旧值，宁可陈旧也不清空）；
   * - **gateway 成功且形状可识别（含 `[]`）** ⇒ **覆盖**（`[]` 表示「确认无」）。
   *
   * ⚠️ 配套：`loadBenefitCache` 必须能把「文件里是 `[]`」与「文件不存在 / 解析失败」
   * 区分开（前者返回 `[]`＝确认无，后者返回 `undefined`＝未确认），否则本节
   * 写下的 `[]` 在下次启动时又会被当成「未确认」。
   */
  // ⚠️ 判据用**局部标志**而不是 `outcome?.gatewayOk`：`outcome` 是可选参数，
  //    调用方（含单测、以及本文件里的直接调用）可能根本不传 ⇒ 用它会**静默失效**
  //    （实测：不传 outcome 时陈旧值没被清掉，用例当场抓到）。
  if (gatewayArr !== undefined || benefitIds.length > 0) {
    setBenefitMemoryCache(benefitIds)
    saveBenefitCache(benefitIds)
  }

  return models
}

/**
 * 缓存目录：默认 `~/.cache/deveco`，可用 `DSH_CODEARTS_CACHE_DIR` 覆盖
 * （单测借此隔离，避免污染真实用户缓存）。
 */
function cacheDir(): string | undefined {
  const override = process.env.DSH_CODEARTS_CACHE_DIR
  if (override !== undefined && override.length > 0) return override
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) return undefined
  /**
   * ⚠️⚠️ **测试环境拒写真实用户目录**（2026-10-27 实测污染后补的防线）。
   *
   * 实测：跑完 `pnpm test` 后 `~/.cache/deveco/codearts_models.json` 与
   * `codearts_benefit_models.json` 的 mtime 都变成当天；把两个文件**删掉**再跑
   * `llm-adapter.spec.ts`，它们**被重新生成** ⇒ 有 spec 走了真读真写路径
   * （`tests/setup-isolation.ts` 已注入 `DSH_CODEARTS_CACHE_DIR`，但仍有
   * 一条腿绕过了它 —— 追查成本高，且这类污染的后果是**污染用户的下一轮真实运行**：
   * 模型列表被测试造的空目录顶掉、benefit 集合被错值顶掉 ⇒ 每轮带错头）。
   *
   * ⇒ 判据：`NODE_ENV === 'test'` **且**最终解析到真实 `~/.cache/deveco`
   *   ⇒ 返回 `undefined`（＝「没有缓存目录」）⇒ 读走「未确认」、写静默跳过。
   *   ⚠️ 显式设了其他目录（单测自己的临时目录）不受影响；生产（NODE_ENV 不是
   *   test）完全不受影响 —— 与 `refresh-journal` 的同类防线同型。
   */
  if (process.env.NODE_ENV === 'test') return undefined
  return `${home}/.cache/deveco`
}

/** 动态模型列表缓存路径：~/.cache/deveco/codearts_models.json。 */
function modelsCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_MODELS_CACHE_FILENAME}`
}

/** benefit 模型集合缓存路径：~/.cache/deveco/codearts_benefit_models.json。 */
function benefitCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_BENEFIT_CACHE_FILENAME}`
}

/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export function saveModelsCache(models: RemoteModel[]): void {
  const path = modelsCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(models), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export function loadModelsCache(): RemoteModel[] | undefined {
  const path = modelsCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const models: RemoteModel[] = JSON.parse(text)
    return Array.isArray(models) && models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export function availableCodeArtsModels(): RemoteModel[] | undefined {
  if (memoryCache !== undefined) return memoryCache
  const disk = loadModelsCache()
  if (disk !== undefined) {
    memoryCache = disk
    return disk
  }
  return undefined
}

/** 设置内存缓存（由 service 拉取成功后调用）。 */
export function setMemoryCache(models: RemoteModel[] | undefined): void {
  memoryCache = models
}

/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 * 文件不存在或写入失败时静默忽略 —— 判定只会退回「未确认」。
 *
 * 同步写入（与 {@link loadBenefitCache} 一致）：chat 请求签名前要读它，
 * 异步写入会让「刚拉取完就发消息」的窗口期内读到旧值/空值。
 */
export function saveBenefitCache(ids: readonly string[]): void {
  const path = benefitCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(ids), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/**
 * 加载缓存文件中的 benefit 模型 id 集合。
 *
 * ## 三种状态必须可分（2026-10-27 审计 P1 修）
 *
 * | 磁盘状态 | 返回 | 含义 | ⇒ 是否带 `maas_type` |
 * |---|---|---|---|
 * | 文件不存在 / 解析失败 | `undefined` | **未确认** | 不带（靠自愈补头） |
 * | 文件是 `[]` | `[]` | **确认无** benefit 模型 | 不带（且**不**再尝试领取） |
 * | 文件是 `["glm-5.3-flash"]` | 数组 | 确认有这些 | 命中才带 |
 *
 * ⚠️⚠️ 修前把「空数组」与「读不到」**都**返回 `undefined` ⇒
 * `saveBenefitCache([])` 写下的「确认无」在下次启动时又退化成「未确认」，
 * 于是 `models.ts` 那侧修好的「空集合可落盘」被这里**抵消**（配套改动，缺一不可）。
 */
export function loadBenefitCache(): string[] | undefined {
  const path = benefitCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const ids: unknown = JSON.parse(text)
    // ⚠️ 合法空数组 = 「确认无」（区别于文件缺失/解析失败的「未确认」）。
    if (!Array.isArray(ids)) return undefined
    if (ids.length === 0) return []
    return ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return undefined
  }
}

/** 设置 benefit 集合内存缓存（由远端拉取成功后调用；undefined 表示清除）。 */
export function setBenefitMemoryCache(ids: string[] | undefined): void {
  benefitMemoryCache = ids
}

/**
 * 该模型的 benefit（免费额度）身份**由远端集合确认**。
 *
 * ## 为什么只有一个判据、没有静态兜底表
 *
 * 早期用一张写死的兜底表（2026-09-23 对齐 deveco-code-rust）推断 benefit 身份，
 * 但那张表**不会随后端演进更新**，两次都成了缺陷根源：
 *
 * - 表过时 ⇒ 首次请求恒带 `maas_type: benefit`，而后端已把 `deepseek-v4.1-flash`
 *   改按常规 `0.18x` 模型下发 ⇒ 每次首条消息都报
 *   `InferHub.4004.200 benefit not found`（2026-10-25 修，见 `e611a61`）。
 * - 表与远端集合谁优先 ⇒ 同一语义两套判据；后端再改一次就又错一遍。
 *
 * 2026-10-26 本机复测（真实账号直连 `chat/completions`）：
 * `deepseek-v4.1-flash` 不带该头**出流正常**、带上即 `4004.200`；
 * `glm-5.3-flash` 不带该头 `002002009.404`、属**只按 benefit 通道注册**。
 * 两者形态相反，恰好证明「按名字/按历史表猜」不可行。
 *
 * ⇒ 权威来源只剩 `opengw gateway/config` 的 `result.models`
 * （见 {@link fetchCodeArtsRemoteModels}）；后端千变万化的情况由 `stream()` 的
 * **双向自愈**兜住：404 未注册 ⇒ 补头重试一次，4004.200 ⇒ 先领福利、再去头重试
 * 一次。因此**没有静态表也不会卡死新模型**，只是首次多一轮往返。
 */
export function isCodeArtsBenefitModelKnown(model: string): boolean {
  if (benefitMemoryCache === undefined) benefitMemoryCache = loadBenefitCache()
  return benefitMemoryCache !== undefined && benefitMemoryCache.includes(model)
}
