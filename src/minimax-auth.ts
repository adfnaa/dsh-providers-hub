/**
 * MiniMax Code 认证服务。
 *
 * 登录走 **OAuth 设备码 + PKCE**（见 `minimax-oauth.ts`），
 * 续期走 `refresh_token` grant。
 *
 * ⚠️ **`refreshAll` 只按 `refreshable` 过滤，不看 `enabled`**
 * （AGENTS.md「续期不得按 enabled 过滤」的真实缺陷教训）。
 */

import { Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'
import {
  MINIMAX,
  MINIMAX_MODELS_PATH,
  MINIMAX_REQUEST_TIMEOUT_MS,
  type MinimaxProduct,
} from './minimax-product.js'
import { fetchMinimaxUserIdentity } from './minimax-identity.js'
import { appendMinimaxJournal, type MinimaxJournalTrigger } from './minimax-refresh-journal.js'
import { resolveJetHubHome } from './jet-hub-store.js'
import {
  inheritMinimaxIdentity,
  fallbackToEntry,
  isMinimaxExpiringWithin,
  isMinimaxRefreshable,
  minimaxCredentialExpiresAtMs,
  describeMinimaxGeoRoute,
  minimaxFetch,
  minimaxHeaders,
  minimaxHeadersFor,
  normalizeMinimaxModel,
  type MinimaxCredential,
  type MinimaxModelEntry,
} from './minimax.js'
import {
  pollMinimaxDeviceToken,
  refreshMinimaxCredential,
  startMinimaxDeviceAuthorization,
  fetchMinimaxForcedLoginUrl,
  type MinimaxDeviceAuthorization,
} from './minimax-oauth.js'

/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里是 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts` 记录的坑）。
 *
 * ⚠️ `refreshableOf` 提供时共享实现会据此写池里的 `refreshable`。
 * MiniMax **确实有** refresh 端点，故提供它是**诚实**的
 *（与 Loomy 相反 —— 那边恒 false 故刻意不提供）。
 */
export const MINIMAX_EXPIRY_ACCESSORS: ExpiryAccessors<MinimaxCredential> = {
  expiresAtOf: (credential) => minimaxCredentialExpiresAtMs(credential),
  refreshableOf: (credential) => isMinimaxRefreshable(credential),
  identityOf: (credential) => credential.access_token,
}

/** refresh_token 已失效，需要重新登录。 */
export class MinimaxRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    // ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'`（真实缺陷，2026-09-29 修正）。
    //
    // `src/refresh.ts` 的终态判据是结构化比较：
    //   `if (error.name === 'RefreshTokenExpiredError') return true`
    //   `return /refresh[_ ]?token/i.test(error.message)`
    //
    // 早期这里写 `'MinimaxRefreshTokenExpiredError'` ⇒ 第一个分支**恒不命中**，
    // 只能靠第二个分支的**文案正则**兜底。而 `refresh()` 里
    // 「凭据未配置，请先登录」不含 `refresh_token` ⇒ 一旦走到那里，
    // `RefreshScheduler` 会把它当成**可重试**错误而**无限重试**。
    // 文案一改即静默退化，极难排查。
    //
    // 八个既有 provider 的同类类**一律**用 `'RefreshTokenExpiredError'`
    // （`cline-auth.ts`、`qoder-auth.ts`、`lobsterai-auth.ts`、
    // `loomy-auth.ts`、`raccoon-auth.ts`、`trae-auth.ts`、
    // `buddy-oauth.ts`、`oauth.ts`）—— 本 provider 不应破例。
    // 之所以能跨模块这样判，是因为判据是**字符串**而非 `instanceof`
    //（各模块的同名类是不同 identity，`instanceof` 会穿透）。
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export function parseMinimaxCredential(value: string): MinimaxCredential | undefined {
  try {
    const parsed = JSON.parse(value) as MinimaxCredential
    return typeof parsed === 'object' && parsed !== null
      && typeof parsed.access_token === 'string' && parsed.access_token.length > 0
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

// ===== 2026-10-24 本地试验版：续期机制重构的常量 =====
//
// 设计依据（三方源码交叉审计的结论）：
// - **官方** `MiniMax-AI/minimax-code` 的 `oauth-core` 是**纯按需刷新**
//   （`getAccessToken({minValidityMs:30_000})`），没有任何定时轮换器；
// - 本插件旧形态是 30min tick + 1h lead + TTL≈1h ⇒ **每个 tick 都对每个
//   可续期账号发起轮换（~48 次/天/账号）**，且批量顺序执行使全部账号的
//   过期时刻焊死在同一秒窗内 —— 一次系统性失败（断网/上游抖动/关机跨窗）
//   必然**全池同时阵亡**，正是「一失效就是一大片」的结构性根因。
//
// ⇒ 新形态：定时器只**对账**（reconcile-only），轮换交给
//   ① 本类 60s 专属巡检（{@link startRenewPatrol}，margin 5min + 按账号散列
//   的 0-10min 抖动 ⇒ 各账号续期时刻天然错开）；
//   ② 请求路径兜底（adapter 预判 + 401 强刷，走 `refreshAccountCredential`）。
//   轮换纪律照抄官方/dsh-minimax-connect：单飞、CAS 落盘、失败重试一次、
//   旧代际 RT 回退抢救、全量 journal。

/** 巡检提前量：距过期不足 5 分钟才发续期请求（dsh-minimax-connect 生产验证值）。 */
const MINIMAX_RENEW_MARGIN_MS = 5 * 60_000
/** 按账号散列的额外提前量跨度（0-10min）：把各账号的续期时刻散开，错峰。 */
const MINIMAX_RENEW_JITTER_SPAN_MS = 10 * 60_000
/** 巡检间隔（60s）：比 margin 细一档，保证窗口不会被整段跳过。 */
const MINIMAX_RENEW_PATROL_INTERVAL_MS = 60_000
/** 非终态失败（网络抖动）后的同 RT 重试间隔。 */
const MINIMAX_RENEW_RETRY_DELAY_MS = 1_500
/** 历史代际 refresh_token 保留条数（新→旧，**不含当前值**）。 */
const MINIMAX_PREVIOUS_REFRESH_TOKENS = 3

/**
 * 按账号 id 算一个**确定性**的续期抖动（0 ≤ x < span）。
 *
 * ⚠️ 必须确定性（不能每次随机）：同一条账号的续期时刻要在**周期之间稳定**，
 * 否则「错峰」退化为「洗牌」。djb2 足够 —— 这里不需要密码学强度。
 */
function renewJitterMs(accountId: string, spanMs: number): number {
  let hash = 5381
  for (let i = 0; i < accountId.length; i++) {
    hash = ((hash << 5) + hash + accountId.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % spanMs
}

/** 判一条错误是不是「refresh_token 已死」的终态（与既有 refreshCredentialFor 同判据）。 */
function isTerminalRefreshError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /invalid_grant|expired|revoked/i.test(message)
}

/** 认证服务选项。 */
export interface MinimaxAuthOptions {
  /** 产品配置；默认 {@link MINIMAX}。 */
  product?: MinimaxProduct
  /** 服务名覆盖（默认由产品 id 派生为 `minimaxAuth`）。 */
  serviceName?: string
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 按**账号 id** 取该账号的出口（MiniMax 国际站代理支持）。
   *
   * ## 为什么要有它
   *
   * `agent.minimax.io` 按**出口 IP 国别**分流，大陆来源恒被 307 到中国站 ⇒
   * 报出与「凭据失效」**逐字同形**的 401（issue IKMEVG）。既有的
   * `X-Forwarded-For` 只是**声明**一个海外 IP，真正换出口要靠代理。
   *
   * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)`（生产代理）>
   * 全局 `fetch`。与 `GeminiAuth` 的同名字段**逐字同构**（同一份判据，只换
   * 产品语义）。
   *
   * ⚠️ 只在**国际站实例**上注入（中国站直连才是最优，出海反而更慢且可能被
   * 引到国际站）。未注入时本字段 `undefined` ⇒ `fetcherFor()` 恒走既有路径，
   * **行为逐字节不变**。
   */
  fetchFor?: (accountId: string) => typeof fetch
  /** 注入的 sleep（测试用）。 */
  sleep?: (ms: number) => Promise<void>
  /**
   * 续期/身份 journal 的落盘根目录（`$DSH_HOME`；2026-10-24 本地试验版）。
   *
   * ⚠️ **必须由接线层显式传入**（`index.ts` 传 `resolveJetHubHome(ctx)`）：
   * 不传（单测 / 旧接线）⇒ **绝不写盘** —— 否则单测会把日志写进用户真实的
   * `~/.dsh/jet-hub/`。见 `minimax-refresh-journal.ts` 的模块头。
   */
  journalHome?: string
}

/** 登录流程句柄。 */
export interface StartedMinimaxLoginFlow {
  /** 用户点开的授权链接（**含 user_code**）。 */
  loginUrl: string
  /**
   * 「保证走一遍登录」的链接（**可能为 undefined**）。
   *
   * ## 为什么登录链接需要两个版本（2026-10-24，用户报障「一打开就自带旧 session」）
   *
   * `loginUrl` 里的 `user_code` **不含身份**，身份全在浏览器 cookie ⇒ 用已有
   * 会话的浏览器打开就直接复用旧账号（上游不认任何 `prompt=*` 强制参数，实测）。
   * 本字段是上游「切换账号」按钮的等价物：`/unified-login?login_redirect=<授权页>`，
   * 由 {@link fetchMinimaxForcedLoginUrl} 用**无 cookie** 的服务端请求换来，
   * 登录完自动回到授权页放行**新**账号。
   *
   * ⚠️ 它**不依赖**无痕窗口能力 ⇒ 在「手机/远端浏览器经隧道访问、宿主没有你的
   * 浏览器」这种部署里，这是**唯一**生效的路径。
   * ⚠️ 可选字段：拿不到时调用方退回 {@link loginUrl}（行为与从前逐字节相同）。
   */
  forcedLoginUrl?: string
  /** 授权完成后的凭据。 */
  result: Promise<MinimaxCredential>
  /** 放弃本次登录。 */
  close: () => void
}

/** MiniMax Code 认证服务。 */
export class MinimaxAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: MinimaxProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  private lastRefreshError: string | undefined
  /**
   * 每 ref **单飞**闸门：巡检 / 请求路径 / 401 强刷可能同时想续同一个账号，
   * 并发轮换同一 RT = 双方都在用一把正在被作废的钥匙（轮换式令牌的
   * 致命竞态）。同 ref 的并发调用都等同一份 Promise。
   * ⚠️ 值类型放宽为 `unknown`：`refreshAccountCredential`（lead-aware 流程）
   * 与 `renewEntry`（margin 流程）的返回形状不同，汇合方各自解读。
   */
  private readonly renewInFlight = new Map<string, Promise<unknown>>()
  /** 60s 专属巡检定时器（{@link startRenewPatrol}；重复调用幂等）。 */
  private patrolTimer: ReturnType<typeof setInterval> | undefined
  /** 巡检防重入：一轮没跑完时跳过本轮（refreshAllCredentials 级别的教训）。 */
  private patrolBusy = false
  /** journal 落盘根目录（`journalHome` 选项；undefined = 不写，见模块注释）。 */
  private readonly journalHome: string | undefined

  constructor(ctx: Context, private readonly options: MinimaxAuthOptions = {}) {
    const product = options.product ?? MINIMAX
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
    this.journalHome = options.journalHome
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /**
   * 取**某个账号**该走的 fetcher（MiniMax 国际站代理支持）。
   *
   * ⚠️⚠️ **必须按账号现取，不能在构造/循环外固化**：本类在一轮流程里可能换号
   * （目录取号走 `getAvailableAccount`、续期按 ref 逐个走），出口必须跟着换 ——
   * 固化一份会让「换了号却仍走旧账号的出口」，症状是「配了代理还是被分流」
   * 且**零报错**，属最难查的一类静默失效。
   *
   * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)`（生产代理）>
   * 全局 `fetch`。未注入 `fetchFor`（中国站实例 / 旧接线）⇒ 恒走既有路径，
   * **行为逐字节不变**。
   *
   * ⚠️ 空账号 id（`''`）= 直连：`fetchFor` 的解析器按「空 id = 没配代理」处理
   * （见 `minimax-proxy.ts`）—— 拿不到账号时不该去查一个空 id。
   */
  private fetcherFor(accountId: string): typeof fetch {
    if (this.options.fetchImpl !== undefined) return this.options.fetchImpl
    if (this.options.fetchFor !== undefined) return this.options.fetchFor(accountId)
    return fetch
  }

  /** 申请设备码（供 RPC 提前拿到 loginUrl）。 */
  async fetchDeviceAuthorization(accountId?: string): Promise<MinimaxDeviceAuthorization> {
    return startMinimaxDeviceAuthorization(this.fetcherFor(accountId ?? ''), this.product)
  }

  /**
   * 两步式登录：**立即**返回 `loginUrl`，后台轮询。
   *
   * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
   * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
   *
   * @param options.accountId 本次登录**将要落在哪个账号条目上**（可选）。
   *
   * ## ⚠️⚠️ 为什么登录也必须知道账号 id（换 token 的那一步要出海）
   *
   * 设备码申请与轮询换 token 都发生在**凭据落盘之前**，此时凭据还在内存里、
   * 账号池里也**只有那条占位条目**认得这个账号 ⇒ 代理只能按 `accountId`
   * 从池里读（`minimaxIntlProxy`）。不带 ⇒ 国际站在大陆网络下**登录恒失败**，
   * 而用户**没法给一个还不存在的账号配代理**（面板的「代理」按钮按
   * `accountId` 打开）⇒ **死锁**（与 Gemini 的 IKLTZ2 审计 P2-1 同型）。
   *
   * 触发路径很常见：refresh_token 失效时面板明示的既定动作就是「删号重登」，
   * 而重登造的是**全新 id** ⇒ 旧号上的代理配置必然丢失。
   *
   * ⚠️ 不传时是空串 = 直连，与既有行为**逐字节一致**（`fetcherFor('')`）。
   */
  async startLogin(options: { accountId?: string } = {}): Promise<StartedMinimaxLoginFlow> {
    const auth = await this.fetchDeviceAuthorization(options.accountId)
    let aborted = false
    const controller = new AbortController()
    const result = pollMinimaxDeviceToken(auth, {
      fetcher: this.fetcherFor(options.accountId ?? ''),
      ...this.options.sleep === undefined ? {} : { sleep: this.options.sleep },
      signal: controller.signal,
      product: this.product,
    })
    // 与 `cline-auth.ts` 同理：结果可能早于调用方 `await` 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    //
    // ⚠️ 本例**必然**会走到这里：`close()` → `controller.abort()` →
    // `pollMinimaxDeviceToken` 里的 `options.signal?.throwIfAborted()`
    // 会 reject（用户关掉登录弹窗就是这条路径）。缺这一句时，
    // 若调用方在 `await result` 之前就放弃，Node 会报 `unhandledRejection`。
    result.catch(() => {})
    /**
     * ⚠️⚠️ 2026-10-24：**额外**去换一条「保证需要登录」的链接。
     *
     * 用户报障：「登录链接一打开就自带旧 session 登录态」。`loginUrl` 的
     * `user_code` 不含身份、身份全在浏览器 cookie；上游不认 `prompt=*`，
     * 但它的「切换账号」按钮走 `/oauth2/device/authorize`（无 cookie ⇒
     * `401 login_required` + `login_url`）⇒ 服务端已替我们拼好「登录完回到授权页」。
     *
     * ⚠️ 它**不消耗任何凭据**（纯 GET、无 `Authorization`），可安全地在每次
     * 「新建账号」时调用 —— 本仓库有过「诊断请求烧掉 refresh_token」的事故。
     * ⚠️ 该函数**永不抛错**（失败退回本地兜底；再失败返回 undefined）。
     */
    const forcedLoginUrl = await fetchMinimaxForcedLoginUrl(auth, this.fetchImpl, this.product)
    return {
      loginUrl: auth.verificationUriComplete,
      ...forcedLoginUrl === undefined ? {} : { forcedLoginUrl },
      result,
      close: () => {
        aborted = true
        controller.abort()
      },
    }
  }

  /**
   * 落盘凭据（登录成功后调用）。
   *
   * ⚠️ 返回 `accountId` 供调用方构造展示名。
   *
   * ## ⚠️⚠️ 2026-10-23（Gitee IKP8UA）：这里**补查一次账号身份**
   *
   * MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点），
   * 登录响应体也**不含任何身份字段** ⇒ 原昵称判据（`decodeJwtSub`）恒 undefined
   * ⇒ 账号卡片恒显示插件内部 id（`minimax-6395cf64`），多账号无法分辨。
   *
   * ⇒ 落盘前查一次 `GET /v1/api/user/info`（见 `minimax-identity.ts`），
   *   把读到的 `name` 写进**凭据**（供自愈路径读）并**返回**给调用方写进账号池。
   *
   * ## 为什么收口在这里，而不是 RPC 分支
   *
   * 登录路径与**启动自愈**（`repairAccountNicknames`）都要身份 —— 若只写在 RPC
   * 那一段，自愈就得再写一份（「同一语义两套判据」）。收口在凭据落盘处，
   * 两条路径共用一份实现。
   *
   * ## 三条纪律
   *
   * 1. **查不到不影响登录**：身份是展示信息，失败一律 `undefined`
   *    （与 qoder 的 `fetchQoderUserNickname` 同原则）；
   * 2. **显式传入的 `nickname` 优先**（调用方可能有更权威的来源）；
   * 3. **国际站必须带池里的 XFF**：`agent.minimax.io` 对大陆出口恒 307 到
   *    `agent.minimaxi.com`，跨 origin 跟随会剥掉 `Authorization` ⇒ 401
   *    （真机实测：无 XFF 时国际站身份**永远**拿不到）。
   *
   * @param options.accountId 落盘到**哪个账号条目**（可选，供代理取出口）。
   *   ⚠️ 它是唯一能让「换 token 之后的身份查询」走对出口的来源 —— 此刻凭据
   *   刚落盘、按凭据反查账号 id 那条路还没建立（与 `startLogin` 同因）。
   */
  async persistLogin(
    credential: MinimaxCredential,
    options: { refName: string; nickname?: string; accountId?: string },
  ): Promise<{ accountId?: string; nickname?: string; userId?: string }> {
    // ⚠️ 与 `fetchModels` 同一份 XFF 取法（`typeof` 判一下：单测/旧接线可能传
    //    只实现部分方法的池替身，直接 `.minimaxXff()` 会抛 TypeError）。
    const pool = this.ctx.accountPool
    const xff = typeof pool?.minimaxXff === 'function' ? pool.minimaxXff() : undefined
    // ⚠️ 查不到（含抛错、401、非 JSON、空 name）一律 `undefined`，不阻塞登录。
    const identity = options.nickname === undefined
      ? await fetchMinimaxUserIdentity(
          credential,
          this.fetcherFor(options.accountId ?? ''),
          this.product,
          xff,
        )
      : undefined
    const nickname = options.nickname ?? identity?.name

    const payload: MinimaxCredential = {
      ...credential,
      ...nickname === undefined ? {} : { nickname },
      // ⚠️ 稳定身份必须落进凭据 —— 它是「同账号去重」的**唯一**判据
      //    （`account.create` 的 minimax 分支按它查 `findAccountIdByIdentityField`）。
      //    `identity.userId` 一直拿得到（`GET /v1/api/user/info` 的 `userID`），
      //    但此前**只用来拼昵称、随后被丢弃** ⇒ 去重无从下手。
      ...identity?.userId === undefined ? {} : { user_id: identity.userId },
    }
    await this.ctx.credentials.set(credentialRef(options.refName), JSON.stringify(payload))
    this.lastRefreshError = undefined
    return {
      ...credential.account_id === undefined ? {} : { accountId: credential.account_id },
      ...nickname === undefined ? {} : { nickname },
      ...identity?.userId === undefined ? {} : { userId: identity.userId },
    }
  }

  /** 解析默认单凭据。 */
  private async resolveDefaultCredential(): Promise<MinimaxCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseMinimaxCredential(resolved.value)
  }

  /**
   * 续期**默认单凭据**。
   *
   * ⚠️⚠️ **这是第 5 条续期路径，且必须同样继承身份**（2026-10-25 合并审计）：
   * PR !147 声称「收口在**唯一**出口 `refreshCredentialFor`」，但本方法在生产上
   * **可达**（`src/index.ts` 的 `getAvailableAccount()` 返回空时就走这里 ——
   * 而「返回空」正是去重把两张卡都停用后的形态），且它此前直接
   * `set(refreshMinimaxCredential(...))` ⇒ `nickname` / `user_id` **双双消失**
   * （实测：续期后落盘只剩令牌五件套）。后果是 IKP8UA（昵称退回内部 id）+
   * 去重失去唯一判据，**每 30 分钟一轮**，必然复现。
   *
   * ⇒ 与 `refreshCredentialFor` 共用同一个纯函数 `inheritMinimaxIdentity`。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) {
      throw new MinimaxRefreshTokenExpiredError('凭据未配置，请先登录')
    }
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      const refreshed = await refreshMinimaxCredential(
        credential.refresh_token as string,
        this.fetchImpl,
        this.product,
      )
      // ⚠️ 与 `refreshCredentialFor` **同一份**继承判据（同义判据分两处必然漂移）。
      const next = inheritMinimaxIdentity(refreshed, credential)
      await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
      this.lastRefreshError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRefreshError = message
      throw error
    }
  }

  /**
   * 续期**指定 ref**（RPC `account.refresh` / adapter 401 强刷 / 积分自愈）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
   * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
   * 也把池值对账（见 `refreshAll` 的注释）。
   *
   * ⚠️⚠️ **2026-10-24 本地试验版：并入单飞闸门**（`renewInFlight`，与
   * `renewEntry`/巡检共用同一把锁）。这不是洁癖 —— 旧形态下 401 路径与巡检
   * **并发**对同一 ref 各发一份 grant，轮换式 RT 下**输家拿到 invalid_grant**；
   * 若输家是巡检，会把账号**误标成需重登**（而赢家明明存下了一份好凭据）。
   * 汇合语义：巡检的 grant 在天上时，这里**等它落地**再走自己的 lead-aware
   * 流程（顺序双 grant 无害，并发双 grant 才致命）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    if (pool === undefined) {
      // 无池：退化为「直接续期 + 落盘到同一个 ref」（单凭据路径，保持既有行为）
      const resolved = await this.ctx.credentials.resolve(ref)
      if (!resolved) throw new Error('凭据未配置')
      const credential = parseMinimaxCredential(resolved.value)
      if (!credential) throw new Error('凭据解析失败')
      if (!isMinimaxRefreshable(credential)) {
        throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
      }
      const next = await this.refreshCredentialFor(credential, accountId)
      await this.ctx.credentials.set(ref, JSON.stringify(next))
      return
    }
    const existing = this.renewInFlight.get(refName)
    if (existing !== undefined) await existing.catch(() => undefined)
    const task = (async () => {
      const resolved = await this.ctx.credentials.resolve(ref)
      if (!resolved) throw new Error('凭据未配置')
      const credential = parseMinimaxCredential(resolved.value)
      if (!credential) throw new Error('凭据解析失败')
      if (!isMinimaxRefreshable(credential)) {
        throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
      }
      await refreshAccountWithReconcile({
        pool,
        provider: this.product.id,
        tag: `[${this.product.id}]`,
        accountId: accountId ?? '',
        credential,
        accessors: MINIMAX_EXPIRY_ACCESSORS,
        refresh: (c) => this.refreshCredentialFor(c, accountId),
        save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
        warn: (message) => this.ctx.logger?.warn?.(message),
        info: (message) => this.ctx.logger?.info?.(message),
      })
    })().finally(() => { this.renewInFlight.delete(refName) })
    this.renewInFlight.set(refName, task)
    await task
  }

  /**
   * 批量处理：**2026-10-24 本地试验版改为只对账（reconcile-only），不发 grant**。
   *
   * ## 为什么砍掉这里的轮换（三方源码审计结论）
   *
   * 旧形态：全局 30min tick 走到这里 + `REFRESH_LEAD_MS`=1h + access TTL≈1h
   * ⇒ **每个 tick、每个可续期账号都命中刷新窗口**（~48 次轮换/天/账号），
   * 且循环顺序执行使全部账号的过期时刻焊死在同一秒窗 —— 一次系统性失败
   * 就是全池同时报废（用户实测「一失效就是一大片」）。
   *
   * 新分工：
   * - **轮换**交给 ① 60s 专属巡检（{@link startRenewPatrol}，5min margin +
   *   账号散列抖动）与 ② 请求路径兜底（adapter 预判 + 401 强刷）——
   *   官方 `oauth-core` 本就是按需制，定时批量轮换是本插件自加的；
   * - **本方法只做对账**：把凭据里的真实 `expiresAt` 镜像回池（UI 读池值），
   *   保持「凭据被别处更新过而索引没跟上」的自愈能力
   *   （`src/expiry-sync.ts` 模块头记录的缺陷反面）。
   *
   * ⚠️ 纪律保持：**只按 `refreshable` 过滤，不看 `enabled`**；凭据缺失/
   * 损坏仍标 `refreshable:false`；单账号失败不拖住其余。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      // ⚠️ 判据只看 refreshable，不看 enabled
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseMinimaxCredential(resolved.value)
        if (!credential || !isMinimaxRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await syncAccountExpiry({
          pool,
          provider: this.product.id,
          credential,
          accessors: MINIMAX_EXPIRY_ACCESSORS,
          accountId: entry.id,
          current: entry,
          tag: `[${this.product.id}]`,
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        // 只对账不会产生终态错误；这里兜的是池/凭据读取层面的意外，
        // 照旧留日志（静默失败会让「凭据一直刷不动」无痕）。
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 账号 ${entry.id} 有效期对账失败：`
            + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * 续期给定凭据（供 `refreshAccountWithReconcile` 的 `refresh` 回调）。
   *
   * ⚠️ **不落盘** —— 落盘由共享实现的 `save` 回调负责。
   *
   * 2026-10-24 起走 {@link grantWithSalvage}：非终态失败同 RT 重试一次、
   * 终态失败先回退历史代际 RT —— 语义对单凭据路径同样成立。
   *
   * @param accountId 该凭据属于哪个账号（可选，供代理取出口）。
   *   ⚠️ 与推理路径同因：国际站的续期端点也在 `agent.minimax.io` 上，
   *   大陆出口直连会 307 ⇒ 续期恒失败而 UI 只显示「已过期」。
   */
  async refreshCredentialFor(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<MinimaxCredential> {
    return this.grantWithSalvage(credential, accountId)
  }

  /**
   * **单次 grant**（含终态分类 + 历史代际维护）。
   *
   * - 服务端判 RT 已死（`invalid_grant|expired|revoked`）⇒ 包成终态错误抛出；
   * - 成功 ⇒ 组装新凭据：**旧 RT 压入历史栈**（新→旧、去重、截 3 条），
   *   再交给 `inheritMinimaxIdentity` **继承全部非令牌字段**（`nickname` / `user_id` /
   *   `previous_refresh_tokens`）—— 续期响应只带令牌五件套，手工透传每加一个字段就漏一个。
   */
  private async grantOnce(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<MinimaxCredential> {
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    let refreshed: MinimaxCredential
    try {
      refreshed = await refreshMinimaxCredential(
        credential.refresh_token as string,
        this.fetcherFor(accountId ?? ''),
        this.product,
      )
    } catch (error) {
      if (isTerminalRefreshError(error)) {
        throw new MinimaxRefreshTokenExpiredError('refresh_token 已失效，请重新登录')
      }
      throw error
    }
    // 旧 RT 压栈（**新→旧**、去重、最多 `MINIMAX_PREVIOUS_REFRESH_TOKENS` 条）——
    // 供 `grantWithSalvage` 在终态失败时逐把回退（断链抢救）。
    // ⚠️ 这是**非令牌字段**：随下面 `inheritMinimaxIdentity` 的
    // `{ ...previous, ...refreshed }` 自然落盘，**不要**在这里手工透传。
    const previous = [credential.refresh_token as string, ...(credential.previous_refresh_tokens ?? [])]
    const deduped: string[] = []
    for (const token of previous) {
      if (typeof token === 'string' && token.length > 0 && !deduped.includes(token)) {
        deduped.push(token)
        if (deduped.length >= MINIMAX_PREVIOUS_REFRESH_TOKENS) break
      }
    }
    if (deduped.length > 0) refreshed = { ...refreshed, previous_refresh_tokens: deduped }

    /**
     * ⚠️⚠️ 续期**必须继承**身份字段（2026-10-24）。
     *
     * `parseMinimaxTokenGrant` 只构造令牌五件套（`access_token` / `refresh_token` /
     * `token_type` / `expires_at` / `scope`），**不认识** `nickname` / `user_id`；
     * 而续期结果会被整体覆盖落盘 ⇒ 每续期一次丢一次：`nickname` 丢了账号卡片退回
     * 内部 id（IKP8UA 复发），`user_id` 丢了**同账号去重失去唯一判据**。
     * 60s 巡检、请求前预判、401 强刷、SELF_HEAL 都会续期 ⇒ 这个丢失**必然发生**。
     *
     * ⚠️ 收口在**唯一**的续期出口（本方法）：本文件有 4 条续期路径，在各调用点
     *    分别补必然漏一处。
     */
    return inheritMinimaxIdentity(refreshed, credential)
  }

  /**
   * grant + **两层抢救**（2026-10-24 本地试验版）。
   *
   * ## 抢救顺序（顺序不可颠倒）
   *
   * 1. **非终态失败**（网络断/超时/5xx）⇒ 隔 1.5s **同 RT 重试一次**：
   *    覆盖「服务端还没处理就断了」的情形；重试若转终态，说明服务端已经
   *    轮换过（响应丢失）⇒ 落入第 2 层。
   * 2. **终态失败** ⇒ 依次回退 **历史代际 RT**（`previous_refresh_tokens`，
   *    新→旧最多 3 把）：上游若只作废被用的那条而非整族，就能救回 ——
   *    全失败才抛终态（调用方标记需重登）。**实验特性**：上游语义未证实，
   *    全失败只是多花几次注定失败的请求，无新增风险；每次抢救结果都进 journal。
   */
  private async grantWithSalvage(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<MinimaxCredential> {
    try {
      return await this.grantOnce(credential, accountId)
    } catch (error) {
      if (error instanceof MinimaxRefreshTokenExpiredError) {
        // 第 2 层：历史代际回退（当前值除外 —— 刚刚就是它死的）。
        const history = (credential.previous_refresh_tokens ?? [])
          .filter((rt) => rt !== credential.refresh_token)
        for (const token of history) {
          try {
            return await this.grantOnce({ ...credential, refresh_token: token }, accountId)
          } catch {
            // 这把也死了 → 试下一把（journal 由调用方记最终结局）。
          }
        }
        throw error
      }
      // 第 1 层：非终态（网络抖动）→ 同 RT 重试一次。
      await (this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(
        MINIMAX_RENEW_RETRY_DELAY_MS,
      )
      return this.grantOnce(credential, accountId)
    }
  }

  /**
   * **按账号条目续期**（2026-10-24 本地试验版的核心入口）。
   *
   * ## 与 `refreshAccountCredential` 的分工
   *
   * | 入口 | 用途 | margin |
   * |---|---|---|
   * | 本方法 | 60s 巡检 / 请求路径兜底 | 5min + 账号抖动（`force` 时无窗口） |
   * | `refreshAccountCredential` | RPC `account.refresh` / adapter `refresh()` | 既有 1h lead（用户点了就是要刷） |
   *
   * ## 三条纪律（缺一都是事故）
   *
   * 1. **单飞**（`renewInFlight`）：巡检 / 兜底 / 强刷并发想续同一个账号时，
   *    只允许一份 grant 在天上 —— 并发轮换同一 RT 是轮换式令牌的致命竞态；
   * 2. **CAS 落盘**：grant 前后**重读凭据**，`access_token` 变了说明期间
   *    有别人写过（登录 / RPC 续期）⇒ **丢弃本次结果**（别人写的是更新的
   *    会话，覆盖回去等于把新钥匙换成旧的）；
   * 3. **全量 journal**：每次 grant 记 `{trigger, result, error, latencyMs,
   *    newExpiresAt}` —— 试验期验收全靠它。
   */
  async renewEntry(
    pool: AccountPool,
    entry: { id: string; credentialRef: string; refreshable?: boolean; expiresAt?: number },
    opts: { marginMs?: number; force?: boolean; trigger?: MinimaxJournalTrigger } = {},
  ): Promise<{ renewed: boolean; credential?: MinimaxCredential; superseded?: boolean }> {
    const existing = this.renewInFlight.get(entry.credentialRef)
    if (existing !== undefined) {
      // 汇合：别的入口（refreshAccountCredential 的 lead-aware 流程）正在续
      // 同一个 ref ⇒ 等它落地，重读凭据交回去（对账/镜像由那次飞行完成）。
      await existing.catch(() => undefined)
      const reRead = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      const credential = reRead === undefined ? undefined : parseMinimaxCredential(reRead.value)
      return { renewed: false, ...(credential === undefined ? {} : { credential }) }
    }
    const task = this.renewEntryInner(pool, entry, opts)
      .finally(() => { this.renewInFlight.delete(entry.credentialRef) })
    this.renewInFlight.set(entry.credentialRef, task)
    return task
  }

  private async renewEntryInner(
    pool: AccountPool,
    entry: { id: string; credentialRef: string; refreshable?: boolean; expiresAt?: number },
    opts: { marginMs?: number; force?: boolean; trigger?: MinimaxJournalTrigger },
  ): Promise<{ renewed: boolean; credential?: MinimaxCredential; superseded?: boolean }> {
    const ref = credentialRef(entry.credentialRef)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) {
      await pool.updateAccount(entry.id, { refreshable: false }).catch(() => {})
      return { renewed: false }
    }
    const credential = parseMinimaxCredential(resolved.value)
    if (credential === undefined || !isMinimaxRefreshable(credential)) {
      await pool.updateAccount(entry.id, { refreshable: false }).catch(() => {})
      return { renewed: false }
    }
    const trigger = opts.trigger ?? 'patrol'
    const margin = opts.force === true ? Number.POSITIVE_INFINITY : (opts.marginMs ?? MINIMAX_RENEW_MARGIN_MS)
    const expiresAt = minimaxCredentialExpiresAtMs(credential)
    // ⚠️ 读不到过期时间视为「该续」（fail-open，与 shouldRefreshNow 同口径）。
    if (!opts.force && expiresAt !== undefined && Number.isFinite(expiresAt)
      && expiresAt - Date.now() > margin) {
      return { renewed: false, credential }
    }
    const started = Date.now()
    try {
      const next = await this.grantWithSalvage(credential, entry.id)
      // CAS：grant 期间凭据若被别人写过（登录 / RPC 续期），丢弃本次结果 ——
      // 别人写的是更新的会话，覆盖回去等于把新钥匙换成旧的。
      const reRead = await this.ctx.credentials.resolve(ref)
      const reReadCredential = reRead === undefined ? undefined : parseMinimaxCredential(reRead.value)
      if (reReadCredential !== undefined && reReadCredential.access_token !== credential.access_token) {
        appendMinimaxJournal(this.journalHome, {
          ts: Date.now(),
          provider: this.product.id,
          accountId: entry.id,
          kind: 'superseded',
          trigger,
          result: 'skipped',
        })
        return { renewed: false, credential: reReadCredential, superseded: true }
      }
      await this.ctx.credentials.set(ref, JSON.stringify(next))
      await syncAccountExpiry({
        pool,
        provider: this.product.id,
        credential: next,
        accessors: MINIMAX_EXPIRY_ACCESSORS,
        accountId: entry.id,
        current: entry,
        tag: `[${this.product.id}]`,
        warn: (message) => this.ctx.logger?.warn?.(message),
      })
      this.lastRefreshError = undefined
      appendMinimaxJournal(this.journalHome, {
        ts: Date.now(),
        provider: this.product.id,
        accountId: entry.id,
        kind: 'grant',
        trigger,
        result: 'ok',
        latencyMs: Date.now() - started,
        newExpiresAt: minimaxCredentialExpiresAtMs(next),
      })
      return { renewed: true, credential: next }
    } catch (error) {
      appendMinimaxJournal(this.journalHome, {
        ts: Date.now(),
        provider: this.product.id,
        accountId: entry.id,
        kind: 'grant',
        trigger,
        result: 'error',
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
      })
      if (error instanceof MinimaxRefreshTokenExpiredError) {
        await pool.updateAccount(entry.id, { refreshable: false }).catch(() => {})
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
        )
      }
      throw error
    }
  }

  /**
   * **60s 专属续期巡检**（2026-10-24 本地试验版；重复调用幂等）。
   *
   * ## 为什么不塞进全局 30min 调度器
   *
   * 30min 粒度配 5min margin 会出现「上一轮看着还够、下一轮 token 已死」的
   * 空窗；而全局调度器是十三个 provider 共用的，为 MiniMax 一家改粒度会
   * 波及全部。故 MiniMax 自带 60s 定时器，margin 内（5min + 账号抖动）才发
   * grant —— 轮换次数从 ~48 次/天/账号降到 ~24-32 次，且**各账号时刻互不相同**。
   *
   * ⚠️ **立即先跑一轮**（与 `MultiAccountRefreshScheduler.start` 同理由）：
   * 宿主重启后不该等满 60s 才开始补。
   */
  startRenewPatrol(pool: AccountPool): void {
    if (this.patrolTimer !== undefined) return
    const tick = async (): Promise<void> => {
      if (this.patrolBusy) return
      this.patrolBusy = true
      try {
        const accounts = await pool.listAccounts(this.product.id)
        for (const entry of accounts) {
          // ⚠️ 只按 refreshable 过滤，不看 enabled（AGENTS.md 既有铁律）。
          if (!entry.refreshable) continue
          try {
            await this.renewEntry(pool, entry, {
              marginMs: MINIMAX_RENEW_MARGIN_MS + renewJitterMs(entry.id, MINIMAX_RENEW_JITTER_SPAN_MS),
              trigger: 'patrol',
            })
          } catch (error) {
            // 终态已在 renewEntry 内记账 + 标池；这里只吞掉继续，
            // 单账号失败不得拖住其余（与 refreshAll 同纪律）。
            if (!(error instanceof MinimaxRefreshTokenExpiredError)) {
              this.ctx.logger?.warn?.(
                `[${this.product.id}] 账号 ${entry.id} 巡检续期失败：`
                  + `${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 续期巡检一轮失败（下一轮重试）：`
            + `${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        this.patrolBusy = false
      }
    }
    void tick()
    this.patrolTimer = setInterval(() => { void tick() }, MINIMAX_RENEW_PATROL_INTERVAL_MS)
    // ⚠️ 不持进程：宿主退出时定时器不该是「退不下去」的原因。
    this.patrolTimer.unref?.()
  }

  /**
   * 拉取远端模型目录（给定凭据）。
   *
   * ⚠️ **测试专用入口**（无需账号池）：`fetchModels` 是它的薄包装。
   *
   * @param accountId 用**哪个账号**的出口（可选，供代理取）。
   */
  async fetchModelsWith(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<readonly MinimaxModelEntry[]> {
    const raw = await this.fetchRawModels(credential, accountId)
    return raw ?? this.product.fallbackModels.map(fallbackToEntry)
  }

  /**
   * 拉取**裸**远端目录：拿到就是拿到，拿不到一律 `undefined`（**不**回退兜底表）。
   *
   * 这是全插件唯一一处真正解析远端模型目录的地方；两个公开入口的差别只在
   * 「拿不到时回吐什么」：
   * - {@link fetchModelsWith} / {@link fetchModels} ⇒ **展示侧**语义，回退兜底表；
   * - {@link fetchRemoteModelsOnly} ⇒ **接线侧**语义，回 `[]`。
   *
   * ⚠ 把这个区分做在**这里**（而不是让接线自己去比对结果与兜底表）是刻意的：
   * 兜底表内容可以被改写，若远端下发的恰好与兜底表相同，「比较内容」的判据会把
   * 一次成功的拉取误判为失败。只有「解析函数返回了几个条目」这个**内部事实**
   * 能可靠区分两者。
   *
   * @param accountId 用**哪个账号**的出口（可选，供代理取）。
   *   ⚠️ 目录端点也在 `agent.minimax.io` 上：大陆出口直连恒 307 ⇒ 整个
   *   provider 会从模型选择器里**消失**（issue IKMEVG 的另一症状面）。
   */
  private async fetchRawModels(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<readonly MinimaxModelEntry[] | undefined> {
    try {
      const url = new URL(`${this.product.apiHost}${MINIMAX_MODELS_PATH}`)
      url.searchParams.set('region', this.product.region)
      url.searchParams.set('buildEnv', this.product.buildEnv)
      /**
       * ⚠️ **带传输级重试 + 保凭据跟随重定向**（两个真实缺陷的修法）。
       *
       * 传输级重试（2026-10-15）：「模型连接测试失败，显示 `fetch failed`」。
       * 本机实测环境里的 HTTPS 检查代理约 **50%** 概率打断到本家的请求
       *（`fetch failed ← SELF_SIGNED_CERT_IN_CHAIN`）⇒ 一次偶发中断就整轮失败。
       *
       * 保凭据跟随 3xx（2026-10-17，issue IKMEVG）：`agent.minimax.io` 恒 307 到
       * `agent.minimaxi.com`，而 fetch 跨 origin 跟随会**剥掉 `Authorization`**
       * ⇒ 第二跳无凭据 ⇒ 目录也拿不到（连带让 provider 在模型选择器里消失）。
       *
       * ⚠️ 两者合并在 `minimaxFetch` 一处，与推理 / 签到积分路径**共用同一份**
       *（`src/minimax.ts`）—— 本文件不另写判据（同义判据分两处必然漂移）。
       * `buildInit` 每跳重建头，保证跟随后的请求仍带凭据。
       *
       * ⚠️ 国际站另需附用户设置的 `X-Forwarded-For`（绕开 Akamai 按出口 IP
       * 的地理分流）。没有它，大陆出口的用户连目录都拿不到 ⇒ provider 在模型
       * 选择器里整个消失（这是本 issue 的另一个症状面）。
       */
      // ⚠️ 用 `typeof` 判一下：单测/旧接线可能传只实现部分方法的池替身，
      //    直接 `.minimaxXff()` 会在那种替身上抛 `TypeError`（`?.` 挡不住）。
      const pool = this.ctx.accountPool
      const xff = typeof pool?.minimaxXff === 'function' ? pool.minimaxXff() : undefined
      let geoRouted = false
      const response = await minimaxFetch(
        url.toString(),
        () => ({
          headers: minimaxHeadersFor(credential, xff, this.product.id),
          signal: AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS),
        }),
        {
          fetcher: this.fetcherFor(accountId ?? ''),
          onGeoRoute: () => { geoRouted = true },
        },
      )
      if (!response.ok) {
        // ⚠️ 地理路由必须留**可操作**的日志：否则用户只看到「模型列表变空」，
        //    而真因（出口 IP 被判定为中国大陆）完全不可见。
        if (geoRouted) {
          this.ctx.logger?.warn?.(`[${this.product.id}] ${describeMinimaxGeoRoute()}`)
        }
        return undefined
      }
      const body: unknown = await response.json().catch(() => undefined)
      const entries = parseMinimaxModelsPayload(body)
      // ⚠️ 远端成功但解析出 0 条时也回退兜底表（避免空列表让整个 provider 消失）
      if (entries.length === 0) {
        // ⚠️ **必须留日志**：否则无法区分「远端坏了」与「远端返回 0 条」，
        // 两者都静默给出兜底表，排查时只知道「模型列表不对」却找不到原因。
        // 目录是展示信息，故仍不抛错（不该让整个 provider 报错）。
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 远端模型目录解析出 0 条，已回退兜底表`,
        )
        return undefined
      }
      return entries
    } catch (error) {
      // ⚠️ 远端失败静默回退，但**必须留日志**（同上：否则无从排查）。
      this.ctx.logger?.warn?.(
        `[${this.product.id}] 远端模型目录获取失败，已回退兜底表：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /** 拉取远端模型目录（账号池版本）。 */
  async fetchModels(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]> {
    const picked = await this.resolveModelsCredential(pool)
    if (picked === undefined) return this.product.fallbackModels.map(fallbackToEntry)
    return this.fetchModelsWith(picked.credential, picked.accountId)
  }

  /**
   * 目录拉取用哪份凭据：账号池优先，其次插件自存的默认凭据。
   *
   * ⚠️ **同时返回账号 id**（代理支持）：目录端点也在 `agent.minimax.io` 上，
   * 国际站必须走该账号的出口才拿得到。单凭据回退时 id 是空串（= 直连），
   * 与既有行为一致。
   */
  private async resolveModelsCredential(
    pool?: AccountPool,
  ): Promise<{ credential: MinimaxCredential; accountId: string } | undefined> {
    if (pool !== undefined) {
      // ⚠ `getAvailableAccount` 返回 **`{ entry, credential }`**（两层），
      // **不是**「账号条目本身」—— 照抄既有 provider 的写法：
      // `const available = await pool.getAvailableAccount<MinimaxCredential>(id, ''); available?.credential`
      const available = await pool.getAvailableAccount<MinimaxCredential>(this.product.id, '')
      if (available) {
        return { credential: available.credential, accountId: available.entry.id }
      }
    }
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return undefined
    return { credential, accountId: '' }
  }
  /**
   * 只取**真远端**目录；未登录 / 上游失败 / 解析出 0 条 ⇒ `[]`。
   *
   * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
   *
   * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
   * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
   * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
   * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
   * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
   *
   * 日志语义与 {@link fetchModelsWith} 一致（失败 / 解析 0 条都留 warn），
   * 只是**不**把兜底表当结果返回。
   */
  async fetchRemoteModelsOnly(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]> {
    const picked = await this.resolveModelsCredential(pool)
    if (picked === undefined) return []
    return (await this.fetchRawModels(picked.credential, picked.accountId)) ?? []
  }

  /**
   * ★★ **启动自愈：补齐存量账号的显示名**（Gitee issue IKP8UA 修法 ③）。
   *
   * ## 为什么必须有这条
   *
   * 只改登录路径**不会自愈存量账号** —— 用户已有的账号（本机实测 7 条）
   * 昵称早已是插件内部 id 且已落盘。不给这条腿，用户要**删号重登**才看得到真名。
   *
   * ## 形态照 `gemini-auth.ts` 的同名方法（那是本仓库最规范的一份）
   *
   * | 纪律 | 理由 |
   * |---|---|
   * | 逐账号 `try/catch` | 单账号失败不得拖住其余（本方法是启动期循环，一个挂住会连累后面全部） |
   * | **只在确实变化时**写池 | `updateAccount` 是整体 replace，每次启动都写 = 平白落盘 |
   * | 失败**不告警**（只用 debug） | 老账号 token 可能早已过期，拿不到是常态，不该刷 warn |
   * | 查不到就**保持原样** | 绝不退回用池 id 重算昵称（那是本 issue 的缺陷本身） |
   *
   * ⚠️ **国际站必须带池里的 XFF**：否则恒 307 → 401（真机实测），
   *    自愈对国际站账号将**永远**失败且看起来「和国内站一样在跑」。
   *
   * @returns 被修复的账号 id（供接线层记日志/计数）。
   */
  async repairAccountNicknames(pool: AccountPool): Promise<string[]> {
    const repaired: string[] = []
    let entries: Awaited<ReturnType<AccountPool['listAccounts']>>
    try {
      entries = await pool.listAccounts(this.product.id)
    } catch {
      // ⚠️ 读不到池绝不当成「没有账号」—— 但这是启动期的尽力而为，
      //    下一次启动还会重试，故这里只静默返回（不删任何东西）。
      return repaired
    }

    // ⚠️ 与 `fetchModels` / `persistLogin` **同一份** XFF 取法。
    const xffPool = this.ctx.accountPool
    const xff = typeof xffPool?.minimaxXff === 'function' ? xffPool.minimaxXff() : undefined

    for (const entry of entries) {
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) continue
        const credential = parseMinimaxCredential(resolved.value)
        if (credential === undefined) continue

        // 查一次身份（只读 GET；失败返回 undefined，不抛错）。
        // ⚠️ **走 `fetcherFor(entry.id)`**：国际站的用户信息端点也在
        //    `agent.minimax.io` 上，大陆出口直连会 307 ⇒ 401（真机实测）
        //    ⇒ 自愈对国际站账号恒失败且看起来「和国内站一样在跑」。
        const identity = await fetchMinimaxUserIdentity(
          credential,
          this.fetcherFor(entry.id),
          this.product,
          xff,
        )
        if (identity === undefined) {
          // 拿不到就保持原样（绝不退回用池 id 重算昵称 —— 那正是本 issue 的缺陷）。
          this.ctx.logger?.debug?.(
            `[${this.product.id}] 账号 ${entry.id} 补拉账号身份失败（昵称保持原样）`,
          )
          continue
        }

        // ⚠️ 只在**确实变化**时写：`updateAccount` 是整体 replace。
        if (identity.name !== entry.nickname) {
          await pool.updateAccount(entry.id, { nickname: identity.name })
          repaired.push(entry.id)
        }
        /**
         * 顺带把身份写进凭据（`persistLogin` 的读取侧约定见该方法注释）。
         *
         * ⚠️⚠️ **必须连 `user_id` 一起补写**（2026-10-25 合并审计打穿）：
         * 改前这里只写 `nickname`，而 `identity.userId` **就在手上**却被丢掉 ⇒
         * 存量凭据（PR 之前登录的）永远没有 `user_id` ⇒ `account.create` 的
         * 同账号去重**永不命中**（`findAccountIdByIdentityField` 对缺失字段是
         * **跳过**，不是「不匹配」）⇒ 一个号仍可无限建卡、各持一份 token。
         *
         * 这条自愈是**唯一**能给存量账号补身份的地方：`persistLogin` 只写新账号，
         * `inheritMinimaxIdentity` 只能继承「已有的」，救不了「从来没有的」。
         * 本机三份 `MINIMAX_ACCOUNT_*` 凭据实测**零份**带 `user_id` ⇒ 不是边角情况。
         */
        const needsNicknameBackfill = (credential as { nickname?: string }).nickname !== identity.name
        const needsUserIdBackfill = identity.userId !== undefined
          && (credential as { user_id?: string }).user_id !== identity.userId
        if (needsNicknameBackfill || needsUserIdBackfill) {
          await this.ctx.credentials.set(
            ref,
            JSON.stringify({
              ...credential,
              nickname: identity.name,
              ...identity.userId === undefined ? {} : { user_id: identity.userId },
            }),
          )
        }
      } catch (error) {
        // 单账号失败不得中断其余（与 gemini 同纪律）。
        this.ctx.logger?.debug?.(
          `[${this.product.id}] 修复账号 ${entry.id} 的显示名失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return repaired
  }
}

/**
 * 解析远端目录响应。
 *
 * 校验（照 asar `parseSnapshot`）：`providers[]` 含 `providerId === 'minimax'`、
 * `config.models` 是非空对象；逐条经 {@link normalizeMinimaxModel} 归一。
 */
export function parseMinimaxModelsPayload(payload: unknown): readonly MinimaxModelEntry[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const providers = (payload as Record<string, unknown>).providers
  if (!Array.isArray(providers)) return []
  const minimax = providers.find(
    (p): p is Record<string, unknown> =>
      typeof p === 'object' && p !== null && (p as Record<string, unknown>).providerId === 'minimax',
  )
  if (minimax === undefined) return []
  const config = minimax.config
  if (typeof config !== 'object' || config === null) return []
  const models = (config as Record<string, unknown>).models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return []

  const out: MinimaxModelEntry[] = []
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    // ⚠️ 把对象的 **key** 注入为 `id`（长名），条目自带的 `name` 是短名。
    // 两者都要保留 —— 合并会丢失官方展示名。
    const withId = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...raw as Record<string, unknown>, id }
      : { id }
    const entry = normalizeMinimaxModel(withId)
    if (entry !== undefined) out.push(entry)
  }
  // ⚠️ 按远端 model_order 排序（若提供），否则保持对象插入序
  const order = (config as Record<string, unknown>).model_order
  if (Array.isArray(order)) {
    const index = new Map<string, number>()
    order.forEach((id, i) => { if (typeof id === 'string') index.set(id, i) })
    out.sort((a, b) => (index.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  return out
}
