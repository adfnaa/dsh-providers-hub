/**
 * 续期失败的**结构化分类**（全仓唯一实现处）。
 *
 * ## 为什么需要它（2026-10-27 两轮审计的共同结论）
 *
 * 本仓库原先有两份**同义判据**（`autoclaw-auth.ts` 的 `refreshCredential` 与
 * `minimax-auth.ts` 的 `isTerminalRefreshError`），都是：
 *
 * ```ts
 * // ❌ 修前（两家逐字同形）
 * if (/invalid_grant|expired|revoked/i.test(message)) throw new TerminalError(...)
 * ```
 *
 * 三处实测打穿（都是**把健康账号标死**，而本仓库的 `refreshable:false` 是
 * **单向门**：`refreshAll` 与巡检都会 `continue` 跳过它 ⇒ 永不自愈）：
 *
 * | 上游报文（真实形态） | 旧判据 | 后果 |
 * |---|---|---|
 * | `HTTP 503 {"error":"token expired"}` | **终态** | 网关抖动一次 = 账号需重登 |
 * | `HTTP 429 {"error":"rate limited, key expired soon"}` | **终态** | 限流一次 = 账号需重登 |
 * | `fetch failed` ⇒ `cause: certificate has expired` | **终态** | 证书/代理抖动 = 账号需重登 |
 *
 * ⚠️ 第三条最隐蔽：本仓库自己的笔记记着「环境 HTTPS 检查代理约 50% 概率打断到
 * 本家的请求」（`docs/agent-notes/providers-loomy-raccoon-minimax.md` 的
 * `minimaxFetchWithRetry` 一节），而 `certificate has expired` 里恰含 `expired`。
 *
 * ## 判据（顺序不可颠倒）
 *
 * 1. **先排传输层**：连不上 / 证书 / 超时 / 主动取消 ⇒ 一律**非终态**（凭据没坏，
 *    网络恢复就该自动复活）。`certificate has expired` 必须在这一步被吃掉，
 *    否则第 2 步的 `expired` 词会把它判成终态 —— 这正是红队实测的击穿点。
 * 2. **再看 HTTP 状态码**：`5xx` / `429` / `408` / `401`（客户端认证问题）⇒
 *    非终态。上游对**整个网关**回 5xx 时，若每个号都被标死，一个请求就能
 *    报废整池。
 * 3. **最后只认结构化 `invalid_grant`**：OAuth 2.0 里「refresh_token 无效」的
 *    **唯一**标准码是 `invalid_grant`（RFC 6749 §5.2）。刻意**不认**
 *    `expired` / `revoked` 这两个宽词，也不从 message 里捞 —— 它们在上游的
 *    5xx 报文、限流文案、证书错误里都会出现。
 *
 * ## 方向性取舍（宁可漏判，不可误判）
 *
 * 漏判（该标死的没标死）的代价 = 每 30 分钟白撞一次上游，用户看到「积分行报错」；
 * 误判（不该标死的标死）的代价 = **账号报废、必须重新登录**，且不可自愈。
 * 两者不对称 ⇒ 一律偏向「不标死」。
 */

/** 结构化续期失败：把 HTTP 状态码与上游 OAuth 错误码带出来，供分类用。 */
export class RefreshFailureError extends Error {
  constructor(
    message: string,
    readonly details: {
      /** HTTP 状态码；**传输层失败时为 `undefined`**（没拿到响应）。 */
      status?: number
      /** 上游响应体里的 OAuth `error` 字段（如 `invalid_grant`）。 */
      oauthError?: string
      /** 明确标记为传输层失败（连不上 / 证书 / 超时）。 */
      transport?: boolean
    } = {},
  ) {
    super(message)
    this.name = 'RefreshFailureError'
  }
}

/**
 * 传输层失败的**错误码**（沿 `cause` 链读）。
 *
 * ⚠️ 读 `code` 而不是 `message`：SSR 侧的 `fetch failed` 是 undici 把**所有**
 * 传输失败压成的同一句话，真因只在 `cause` 上（与 `src/refresh.ts` 的
 * `isUnreachableNetworkError` 同一条教训）。
 */
const TRANSPORT_CODES = /UND_ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/i

/**
 * 传输层失败的**文案特征**。
 *
 * ⚠️ 必须包含 `certificate` / `expired` 的组合形态：`certificate has expired`
 * 是红队实测的击穿点（明文含 `expired`，但含义是证书过期，与 refresh_token
 * 毫无关系）。这里**先**命中它，第 2、3 步就看不到这个词了。
 */
const TRANSPORT_MESSAGES = new RegExp([
  'fetch failed',
  'socket hang up',
  'network',
  'certificate',
  'self[- ]signed',
  'unable to verify',
  'getaddrinfo',
  'timed? ?out',
  'timeout',
  'aborted?',
  'AbortError',
  'proxy',
  'EPIPE',
].join('|'), 'i')

/**
 * 是否为**传输层**失败（没拿到可用响应）。
 *
 * 判据顺序：`details.transport` 显式标记 → 沿 `cause` 链读错误码 → 读文案。
 */
export function isRefreshTransportFailure(error: unknown): boolean {
  if (error instanceof RefreshFailureError && error.details.transport === true) return true
  // 沿 cause 链读结构化错误码（深度上限防病态自引用链，与 refresh.ts 同款）。
  let current: unknown = error
  for (let i = 0; i < 8 && current !== null && current !== undefined; i += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && TRANSPORT_CODES.test(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  const message = error instanceof Error ? error.message : String(error)
  return TRANSPORT_MESSAGES.test(message)
}

/**
 * 是否为**终态**（refresh_token 已死，只能重新登录）。
 *
 * ⚠️ 三步顺序**不可颠倒**（见模块头）。任何一步「不确定」都返回 `false`。
 */
export function isTerminalRefreshFailure(
  error: unknown,
  terminalOAuthErrors: readonly string[] = DEFAULT_TERMINAL_OAUTH_ERRORS,
): boolean {
  // ① 传输层永远不是终态（含 `certificate has expired`）。
  if (isRefreshTransportFailure(error)) return false

  const details = error instanceof RefreshFailureError ? error.details : undefined
  const status = details?.status

  // ② HTTP 状态码：5xx / 429 / 408 / 401 一律非终态。
  //    网关抖动、限流、超时、客户端认证问题都不说明**这把** refresh_token 死了。
  if (status !== undefined && (status >= 500 || status === 429 || status === 408 || status === 401)) {
    return false
  }

  // ③ 结构化 OAuth `error`：只在该家声明的词表内、且状态码是「确定性拒绝」
  //    （`400` 标准形态，或 `200` 的业务码信封）时判终态。
  const oauthError = details?.oauthError
  if (oauthError !== undefined && status !== undefined && (status === 400 || status === 200)) {
    return matchesAny(oauthError, terminalOAuthErrors)
  }

  // ④ 无结构化信息（旧调用方 / 第三方错误）：只认**精确**词表内的词。
  //    ⚠️ 刻意不含 `expired` / `revoked`：它们在 5xx 报文、限流文案、证书错误里
  //    都会出现，是本模块存在的原因。
  const message = error instanceof Error ? error.message : String(error)
  // 文案里带 5xx / 429 的一律不判死（有些实现把状态码写进 message）。
  if (/\b5\d\d\b/.test(message) || /\b429\b/.test(message)) return false
  return matchesAny(message, terminalOAuthErrors)
}

/** RFC 6749 §5.2 的「refresh_token 无效」唯一标准码。 */
const DEFAULT_TERMINAL_OAUTH_ERRORS: readonly string[] = ['invalid_grant']

/** 精确词匹配（大小写无关、要求词边界，避免 `invalid_grant_x` 之类误命中）。 */
function matchesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(text)
  })
}

/**
 * 从上游响应构造**结构化**续期失败。
 *
 * 两家 OAuth 端点（MiniMax `/oauth2/token`、AutoClaw `/userapi/v1/refresh`）
 * 都用它，避免各写一份「状态码 + error 字段」的提取。
 *
 * @param label 日志前缀（如 `'MiniMax 续期失败'`），进 message 以保住原有可读性。
 * @param status HTTP 状态码。
 * @param body   已解析的响应体（可能不是对象）。
 * @param oauthErrorKey 上游放 OAuth `error` 的键名（AutoClaw 的业务码信封用 `msg`）。
 */
export function refreshFailureFromResponse(
  label: string,
  status: number,
  body: unknown,
  oauthErrorKey: 'error' | 'msg' = 'error',
): RefreshFailureError {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
  const rawError = record[oauthErrorKey]
  const oauthError = typeof rawError === 'string' && rawError.trim().length > 0
    ? rawError.trim()
    : undefined
  const rawMessage = record.error_description ?? record.message
  const described = typeof rawMessage === 'string' && rawMessage.trim().length > 0
    ? rawMessage.trim()
    : undefined
  const message = `${label}：HTTP ${status}`
    + `${oauthError === undefined ? '' : ` ${oauthError}`}`
    + `${described === undefined ? '' : `（${described}）`}`
  return new RefreshFailureError(message, {
    status,
    ...oauthError === undefined ? {} : { oauthError },
  })
}
