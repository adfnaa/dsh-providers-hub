import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { loadOrCreateApiKey, type ApiKeySource } from './auth.js'
import { gatewayHttpUrl, isLoopbackHost, resolveGatewayConfig, type OpenAiGatewayConfig } from './config.js'
import { markGatewayChannel } from './channel.js'
import { toGenerateOptions, OpenAiGatewayError, parseModelRoute, normalizeReasoningEffort, normalizeMaxTokens, type OpenAiChatRequest, type ReasoningEffortNotice } from './messages.js'
import type { AttachmentBridge, ImageLimits } from './images.js'
import { collectGatewayEffortViews, collectGatewayModelIds, collectGatewayModels, toGatewayModelIds, toOpenAiModels } from './models.js'
import { effortResolutions } from './effort-view.js'
import { CANONICAL_REASONING_EFFORTS } from '../reasoning-ladder.js'
import { findCaseInsensitiveSuggestion, looksLikeMissingModel } from './model-errors.js'
import {
  collectResponsesResult,
  responsesMaxOutputTokens,
  responsesReasoningEffort,
  toResponsesGenerateOptions,
  toResponsesSse,
  type OpenAiResponsesRequest,
} from './responses.js'
import { collectOpenAiCompletion, failureToOpenAiError, toOpenAiSse } from './stream.js'

export interface GatewayLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface LlmRuntimeLike {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface OpenAiGatewayOptions {
  ctx?: Context
  llm: LlmRuntimeLike
  /**
   * 附件服务桥接（`ctx.attachments.saveImage`）。
   *
   * 缺失时收到图片会明确回「未装载附件服务」而不是静默丢图 —— 静默丢弃会让用户
   * 以为模型看到了图，而答案其实是基于文本生成的。
   */
  attachments?: AttachmentBridge
  /** 图片限制；缺省用 `images.ts` 里附件服务的实测默认值。 */
  imageLimits?: ImageLimits
  /**
   * 请求体上限（字节）；缺省 {@link BODY_LIMIT}。
   *
   * 存在的唯一理由是**可测**：默认上限是 300 MiB，真发一个超限请求既慢又吃内存，
   * 而「超限时客户端拿到的是 413 而不是连接重置」（Issue IKKUBJ）这条回归用例
   * 必须有真实 HTTP 往返才立得住。它不是面向用户的配置项，插件调用方不传。
   */
  maxBodyBytes?: number
  home?: string
  env?: NodeJS.ProcessEnv
  logger?: GatewayLogger
  /**
   * 「允许局域网访问」设置页开关（默认 `false`）。
   *
   * `true` 且 env 未显式给 `DSH_OPENAI_GATEWAY_HOST` 时绑定 `0.0.0.0`（全部
   * 网卡）——语义与安全边界见 `config.ts` 的 `ResolveGatewayConfigOptions`。
   */
  allowLan?: boolean
}

export interface OpenAiGateway {
  start(): Promise<void>
  close(): Promise<void>
  address(): { host: string; port: number }
  /**
   * 密钥来源（含本体与文件路径）。
   *
   * 刻意**只经由 `createOpenAiGateway()` 拿**（runtime 已持有实例），而不是
   * 另开一条读密钥的通道：多一个入口就多一处「读到的和网关在用的不是同一个」
   * 的可能，而那种偏差会表现为「设置页复制的 key 一律 401」。
   */
  apiKey: ApiKeySource
}

/**
 * 请求体上限。
 *
 * ⚠️ **必须容得下自家图片声明所能产生的请求体**（Issue IKKUBJ）。原先的 16 MiB
 * 与 `DEFAULT_IMAGE_LIMITS` 自相矛盾：那里允许一条消息带 200 MiB 图片（**原始**
 * 字节），而 JSON 里图片以 base64 承载、膨胀 4/3 ⇒ 光图片就是 266.7 MiB。结果是
 * 「单张图片 20 MiB」这句声明在真实链路上**永不可达** —— 实测连 12 MiB 的图片
 * 都已经在读到 body 这一步就被拒，压根走不到图片体积校验。
 *
 * 300 MiB = 200 MiB 图片的 base64 形态（266.7 MiB）+ 约 35 MiB 余量给文本与
 * tools。取值上限由 `DEFAULT_IMAGE_LIMITS` 反推，故**改图片声明时必须回来核对**
 * —— `tests/unit/openai-gateway-server.spec.ts` 有一条纯算术用例锁住这个关系。
 */
export const BODY_LIMIT = 300 * 1024 * 1024

/**
 * `close()` 等待在途连接自行收尾的宽限窗口。
 *
 * ⚠️ 存在的理由（Issue #11 的根因）：`server.close()` 的回调**只在所有 socket
 * 都关掉之后**才触发，而 `controller.abort()` 只是让业务逻辑停止，**不会主动
 * 断连**。在途的 SSE 响应即使已经被 `end()`，对应的 socket 仍可能停在 keep-alive
 * 状态，要等 `keepAliveTimeout`（本网关设的是 120s）才被内核回收。
 *
 * 实测：翻「允许局域网访问」触发换绑时 `close()` 挂了 **121 秒**（= 120s + 1s），
 * 这期间网关已停、`running` 已是 `undefined`、且**一行日志都没有** —— 用户看到的
 * 就是「网关静默消失」，下游全部 connection refused。
 *
 * 取值：足够让刚被 abort 的流把已缓冲的帧刷给客户端（避免连接重置），又短到
 * 用户感知不到延迟。超时后由 `closeAllConnections()` 强制断开。
 */
export const CLOSE_GRACE_MS = 250

/**
 * 强制断开之后，等底层确认关闭的**上限**。
 *
 * ⚠️ 存在的理由（对抗审计发现的 P1）：`close()` 对外承诺「一定在有限时间内
 * 返回」，而「强制断开后等回调」那一步若没有上限，一旦底层不触发回调
 * （被 patch 的 server、异常 socket 状态、或 fallback 到 `closeIdleConnections`
 * 时它对在途 socket 无效），`close()` 就**永不返回**。
 *
 * 后果比原 bug 更糟：`close()` 的调用方是收敛队列 ⇒ 队列永久卡死 ⇒ **用户再也
 * 打不开网关，且没有自愈路径**（`disposeGatewayRuntime` 只挂在插件卸载上）。
 * 原 bug 至少 120s 后自愈。
 *
 * 取值 1000ms：强制断开是同步生效的，正常情况下回调在同一轮事件循环内就触发
 * （实测整个 close 是 266ms）；1 秒足够吸收调度抖动，又短到用户无感。
 */
export const CLOSE_DRAIN_MS = 1000

const defaultLogger: GatewayLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  response.end(body)
}

function readJson(request: IncomingMessage, signal: AbortSignal, limit: number): Promise<OpenAiChatRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    const abort = () => reject(new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted'))
    signal.addEventListener('abort', abort, { once: true })
    request.on('data', (chunk: Buffer | string) => {
      // ⚠️ 判超限后**排空但不累积，且绝不销毁 socket**（Issue IKKUBJ）。
      //
      // 这里原先在 reject 之后销毁请求：socket 当场死掉，而这条 413 要等
      // `withRequest` 的 catch 才写出，于是**永远发不出去** —— 客户端只看到连接
      // 重置（RST）。后果远不止「一次请求失败」：Codex 这类每轮回传全量历史的
      // 客户端，历史一旦越过上限就再也回不去，而它的自动压缩只看 token 不看字节，
      // 于是永不触发，会话永久不可用。把「请求过大」伪装成「网络故障」会让排查
      // 方向彻底跑偏（该 issue 报告的实际排查耗时以小时计）。
      //
      // `'data'` 监听器本身就使流处于 flowing 模式 ⇒ 超限后剩下的数据会被读走并
      // 丢弃，客户端不会因背压卡在写入里（这正是那条 413 能送达的前提）。
      if (tooLarge) return
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.length
      if (size > limit) {
        tooLarge = true
        reject(new OpenAiGatewayError(
          `request body is too large: limit is ${limit} bytes`,
          413,
          'invalid_request_error',
          'request_too_large',
        ))
        return
      }
      chunks.push(data)
    })
    request.on('error', reject)
    request.on('end', () => {
      signal.removeEventListener('abort', abort)
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
        resolve(value as OpenAiChatRequest)
      } catch {
        reject(new OpenAiGatewayError('request body must be valid JSON'))
      }
    })
  })
}

function authorized(request: IncomingMessage, key: string): boolean {
  const value = request.headers.authorization
  return typeof value === 'string' && value === `Bearer ${key}`
}

function getHome(options: OpenAiGatewayOptions): string {
  return options.home ?? options.env?.DSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function createOpenAiGateway(options: OpenAiGatewayOptions): OpenAiGateway {
  const env = options.env ?? process.env
  const config: OpenAiGatewayConfig = resolveGatewayConfig(env, { allowLan: options.allowLan === true })
  // 密钥在**创建时**解析（而不是 start 时）：设置页要能在网关未运行时也能
  // 读到它，用户才能配置外部客户端。
  const apiKey = loadOrCreateApiKey(getHome(options), env)
  const key = apiKey.value
  const bodyLimit = options.maxBodyBytes ?? BODY_LIMIT
  const logger = options.logger ?? defaultLogger
  let server: Server | undefined
  /**
   * 正在启动中（已 `listen()` 但还没收到 `listening`）的实例。
   *
   * ⚠️ 存在的理由（对抗审计 P1）：`close()` 只看 `server` 槽位，而槽位现在只在
   * listen **成功后**才赋值（否则 `close()` 会把一个尚未监听的 server 关掉，
   * 导致 `start()` 等的 `listening` 永不到来 ⇒ 永久挂起）。因此 `close()` 必须
   * 另有途径找到「正在启动中」的那一个并请求它放弃，否则「启动中关掉」会变成
   * 「start 永挂」。
   */
  let pendingStart: { cancel: () => void } | undefined
  let boundPort = config.port
  const active = new Set<AbortController>()

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  const handleModels = async (response: ServerResponse): Promise<void> => {
    // 逐个 catch 的容错在 collectGatewayModels 里（设置页的 RPC 复用同一份，
    // 两处各写一遍必然漂移）。
    const groups = await collectGatewayModels(options.llm, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider} 模型目录读取失败，已从 /v1/models 跳过：${describe(error)}`)
    })
    // 档位视图是**附加信息**：某个模型解析不出来就只是它没有该字段，
    // 绝不能让整份目录跟着失败（同理，见 collectGatewayEffortViews 的注释）。
    const effortViews = await collectGatewayEffortViews(options.llm, groups, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider}：${describe(error)}`)
    })
    jsonResponse(response, 200, { object: 'list', data: toOpenAiModels(groups, effortViews) })
  }

  /**
   * `GET /v1/reasoning-efforts`：**思考档位对照表**（本网关特有的只读端点）。
   *
   * ## 为什么需要它（真实缺陷）
   *
   * 各 provider 的档位 id 是上游 wire 值（`light` / `extra_high` / `xhigh` / `on`），
   * 而走 OpenAI 协议的客户端只有固定 8 档词汇。客户端**无法表达**那些私有 id，
   * 用户只能照 DSH 界面上显示的名字（Max / Extra / Extra High）猜着填，
   * 猜错就是 400。翻译层让「猜错也不会失败」，本端点让「不必猜」：
   * 每个模型的 `openai_efforts` 就是可以直接抄进客户端的那一组，
   * `resolutions` 则把 8 个规范名逐一的结局说清（原样 / 就近 / 无法表达 / 不下发）。
   *
   * ⚠️ `/v1/models` 里也带同一份视图（`reasoning` 字段）。两处**必须同源**：
   * 这里给人和脚本查，那里给会自动扫目录的工具查；各算一遍必然漂移。
   */
  const handleReasoningEfforts = async (response: ServerResponse): Promise<void> => {
    const groups = await collectGatewayModels(options.llm, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider} 模型目录读取失败，已从 /v1/reasoning-efforts 跳过：${describe(error)}`)
    })
    const effortViews = await collectGatewayEffortViews(options.llm, groups, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider}：${describe(error)}`)
    })
    jsonResponse(response, 200, {
      object: 'list',
      // 客户端能说出口的全部档位名（由弱到强）。CC Switch 的档位多选器就是这 8 个。
      canonical: [...CANONICAL_REASONING_EFFORTS],
      data: toGatewayModelIds(groups, effortViews).map((model) => {
        const reasoning = model.reasoning
        const declared = reasoning?.efforts.map((effort) => effort.id) ?? []
        return {
          id: model.id,
          efforts: reasoning?.efforts ?? [],
          ...reasoning?.default === undefined ? {} : { default: reasoning.default },
          // 可以直接抄进 OpenAI 客户端的规范名；`efforts` 为空时它也为空
          // （该模型不声明档位 → 网关不下发任何档位，按模型默认走）。
          openai_efforts: reasoning?.openai_efforts ?? [],
          resolutions: effortResolutions(declared),
        }
      }),
    })
  }

  /**
   * 解析模型元信息。失败按「模型不可解析」回 404，而不是笼统的 502 ——
   * OpenAI 客户端据此区分「换个模型名重试」与「上游故障」，前者不该被当作可重试错误。
   */
  const resolveModelInfo = async (
    route: { provider: string; model: string },
    signal: AbortSignal,
  ): Promise<unknown> => {
    try {
      return await options.llm.resolveModelInfo(route.provider, route.model, signal)
    } catch (error) {
      // 取消导致的抛错不是「模型不存在」，不能被改写成 404。
      if (signal.aborted) throw new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted')
      throw new OpenAiGatewayError(
        `model ${route.provider}/${route.model} could not be resolved: ${describe(error)}`,
        404,
        'invalid_request_error',
        'model_not_found',
      )
    }
  }

  /**
   * 失败时给出「你是不是想用 X」的建议。
   *
   * ⚠️ **目录只在出错时才去查**（正常请求零额外开销），且用的是与
   * `/v1/models` 完全相同的采集器 —— 建议里给出的 ID 必须真能被网关接受，
   * 两处各查一遍必然漂移，而漂移的症状是「按提示改了还是不行」。
   */
  const makeSuggestion = (requestedId: string) => async (message: string): Promise<string | undefined> => {
    if (!looksLikeMissingModel(message)) return undefined
    const catalog = await loadModelIdsHint()
    const found = findCaseInsensitiveSuggestion(requestedId, catalog)
    return found === undefined ? undefined : `你是不是想用 ${found}`
  }

  /**
   * 纠错建议用的模型 ID 清单。
   *
   * 惰性 + 只取一次：出错是少数情况，正常路径连这个数组都不会构造。
   * 取失败（某个 provider 未登录）时退化为空清单 —— 拿不到建议只是少一句
   * 提示，绝不能因此把真正的错误盖掉。
   */
  let hintLoaded = false
  let modelIdsHint: readonly string[] = []
  const loadModelIdsHint = async (): Promise<readonly string[]> => {
    if (!hintLoaded) {
      hintLoaded = true
      try {
        modelIdsHint = (await collectGatewayModelIds(options.llm)).map((model) => model.id)
      } catch {
        modelIdsHint = []
      }
    }
    return modelIdsHint
  }

  /**
   * 两个端点共用的「请求生命周期」外壳：绑定取消、统一错误翻译。
   *
   * ⚠️ **必须共用**：`/v1/chat/completions` 与 `/v1/responses` 的错误出口若各写
   * 一遍，迟早出现「同一个错误在一个 URL 上回 404、在另一个上回 502」——
   * 而 502 会被客户端当可重试故障白耗额度，这正是当初引入 404 翻译要修的问题。
   */
  const withRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    const controller = new AbortController()
    active.add(controller)
    const abort = () => controller.abort()
    const onClose = () => {
      if (!response.writableEnded) controller.abort()
    }
    request.once('aborted', abort)
    response.once('close', onClose)
    try {
      await run(controller.signal)
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const converted = failureToOpenAiError(error)
        jsonResponse(response, converted.status, converted.body)
      }
    } finally {
      request.removeListener('aborted', abort)
      response.removeListener('close', onClose)
      active.delete(controller)
    }
  }

  /** SSE 响应头（两个端点的流式出口一致）。 */
  const writeSseHead = (response: ServerResponse): void => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })
  }

  /**
   * 档位被「翻译」或「丢弃」时记一条日志。
   *
   * ⚠️ 两种情况必须分开记，且**级别不同**：
   *
   * - `translated`（客户端给的是通用名、模型用的是私有 id，已就近下发）用 `info`：
   *   加了翻译层之后这是**正常路径**（CC Switch 给 TRAE 的 `low` 每一轮都会被翻译），
   *   用 warn 会把日志刷满，反而掩盖真正的异常；
   * - `unexpressible`（模型根本没有这一族的档位，本次不下发）用 `warn`：
   *   用户的设置确实没生效，这是需要被看见的事。
   *
   * 两件事都不回给客户端（OpenAI 协议里没有承载它的位置），故日志 + 对照表端点
   * （`GET /v1/reasoning-efforts`）是它们唯一的出口。
   */
  const logEffortNotice = (route: { provider: string; model: string }, notice: ReasoningEffortNotice): void => {
    const target = `${route.provider}/${route.model}`
    if (notice.outcome === 'translated') {
      logger.info(
        `[openai-gateway] ${target}：思考档位 ${notice.requested} 不是该模型声明的 id，`
        + `已按强度就近下发 ${notice.applied}`,
      )
      return
    }
    logger.warn(
      `[openai-gateway] ${target}：思考档位 ${notice.requested} 无法表达`
      + '（该模型没有这一族的档位），本次不下发该参数、按模型默认走',
    )
  }

  const handleChat = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await withRequest(request, response, async (signal) => {
      const body = await readJson(request, signal, bodyLimit)
      const route = parseModelRoute(body.model)
      const modelInfo = await resolveModelInfo(route, signal)
      const reasoningEffort = normalizeReasoningEffort(
        body.reasoning_effort, modelInfo, route.provider, route.model, (notice) => logEffortNotice(route, notice),
      )
      const requestedMaxTokens = body.max_completion_tokens ?? body.max_tokens
      const maxTokens = typeof requestedMaxTokens === 'number'
        ? normalizeMaxTokens(requestedMaxTokens, route.provider, route.model)
        : undefined
      const generate = await toGenerateOptions(body, signal, reasoningEffort, maxTokens, {
        bridge: options.attachments,
        limits: options.imageLimits,
      })
      const stream = options.llm.stream(markGatewayChannel(generate))
      const fullId = `${route.provider}/${route.model}`
      if (body.stream === true) {
        writeSseHead(response)
        for await (const event of toOpenAiSse(stream, undefined, fullId, makeSuggestion(fullId))) {
          if (signal.aborted || response.destroyed) break
          response.write(event)
        }
        // ⚠️ 被 abort（网关换绑/关闭）时补发终止帧（对抗审计发现）。
        //
        // 原先 `break` 之后直接 `end()` ⇒ 客户端收到**没有 `data: [DONE]` 的
        // 半截 SSE**。实测（审计 RST）：客户端事件是 `["status:200","end"]`
        // 但 `body` 里**没有 `[DONE]`** ⇒ 严格按 OpenAI 协议解析的客户端会
        // 把这次「正常收尾」当成**异常截断**（它等的正是 `[DONE]`）。
        //
        // 只在「还没被 destroyed」时补：socket 已经没了就没必要写（写也白写）。
        // ⚠️ 这里**不是**在掩盖错误：abort 是调用方主动发起的（换绑/关闭），
        // 补 `[DONE]` 等于告诉客户端「这轮到此为止」，是协议要求的最小收尾。
        if (!response.destroyed && !response.writableEnded) {
          try { response.write('data: [DONE]\n\n') } catch { /* socket 已断，忽略 */ }
        }
        if (!response.writableEnded) response.end()
      } else {
        const result = await collectOpenAiCompletion(stream, undefined, fullId, makeSuggestion(fullId))
        jsonResponse(response, 200, result)
      }
    })
  }

  /**
   * `POST /v1/responses`（OpenAI Responses API）。
   *
   * 与 `handleChat` 的差别**只在协议外壳**：模型路由、思考档位归一化、输出预算
   * 钳制（`normalizeMaxTokens`）、纠错建议、取消与错误翻译全部同源 —— 换了个
   * URL 就换了套行为是最难排查的一类缺陷。
   */
  const handleResponses = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    await withRequest(request, response, async (signal) => {
      const body = await readJson(request, signal, bodyLimit) as OpenAiResponsesRequest
      const route = parseModelRoute(body.model)
      const modelInfo = await resolveModelInfo(route, signal)
      const reasoningEffort = normalizeReasoningEffort(
        responsesReasoningEffort(body), modelInfo, route.provider, route.model,
        (notice) => logEffortNotice(route, notice),
      )
      const requestedMaxTokens = responsesMaxOutputTokens(body)
      const maxTokens = requestedMaxTokens === undefined
        ? undefined
        : normalizeMaxTokens(requestedMaxTokens, route.provider, route.model)
      const generate = await toResponsesGenerateOptions(body, signal, reasoningEffort, maxTokens, {
        bridge: options.attachments,
        limits: options.imageLimits,
      }, (dropped) => {
        // ⚠️ 丢弃是**有意**的降级（拒绝会让 Codex 这类客户端的整轮对话直接失败，
        // 见 responses.ts 文件头「工具」一节），但绝不能连日志都没有 ——
        // 否则「模型看不到某个工具」这件事在事后无从解释。
        logger.warn(
          `[openai-gateway] /v1/responses：工具类型 ${dropped.type}`
          + `${dropped.name === undefined ? '' : `（${dropped.name}）`}`
          + ' 无法用 DSH 的 ToolSchema 表达，已从本次请求丢弃',
        )
      })
      const stream = options.llm.stream(markGatewayChannel(generate))
      const fullId = `${route.provider}/${route.model}`
      // 响应 id 由网关生成：本网关**无状态**，这个 id 只用于客户端关联，
      // 不能拿它回来查（`GET /v1/responses/{id}` 一律 404）。
      const responseId = `resp_${randomUUID().replaceAll('-', '')}`
      if (body.stream === true) {
        writeSseHead(response)
        for await (const event of toResponsesSse(stream, responseId, fullId, body, makeSuggestion(fullId))) {
          if (signal.aborted || response.destroyed) break
          response.write(event)
        }
        // ⚠️ 被 abort 时补发终止事件（对抗审计发现，与 `/v1/chat/completions`
        // 的 `[DONE]` 同族但**协议不同**）：Responses 的流以 `response.completed`
        // 或 `response.failed` 结束（见 `responses.ts` 的注释），官方 SDK 依此判定
        // 结束。原先 `break` 后直接 `end()` ⇒ 客户端收到**没有任何终止事件的
        // 半截流**，会被当成异常截断。
        //
        // ⚠️ 用 `response.failed` 而不是 `completed`：本轮确实被中途取消了，
        // 谎报 `completed` 会让客户端把半截输出当完整结果持久化。
        if (!response.destroyed && !response.writableEnded) {
          try {
            response.write(`event: response.failed\ndata: ${JSON.stringify({
              type: 'response.failed',
              response: {
                id: responseId,
                object: 'response',
                status: 'failed',
                error: { code: 'server_error', message: '网关已关闭，本轮被中止' },
              },
            })}\n\n`)
          } catch { /* socket 已断，忽略 */ }
        }
        if (!response.writableEnded) response.end()
      } else {
        const result = await collectResponsesResult(stream, responseId, fullId, body, makeSuggestion(fullId))
        jsonResponse(response, 200, result)
      }
    })
  }

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      response.end()
      return
    }
    if (!authorized(request, key)) {
      jsonResponse(response, 401, { error: { message: 'Missing or invalid API key', type: 'authentication_error', code: 'invalid_api_key' } })
      return
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/v1/models' && request.method === 'GET') {
      void handleModels(response).catch(error => jsonResponse(response, 502, { error: { message: String(error), type: 'server_error', code: 'model_list_failed' } }))
      return
    }
    // 本网关特有的只读端点：思考档位对照表（见 handleReasoningEfforts 的理由）。
    // ⚠️ 路径不放在 `/v1/models/…` 之下：客户端会把那些路径当模型 ID 解析。
    if (path === '/v1/reasoning-efforts' && request.method === 'GET') {
      void handleReasoningEfforts(response).catch(error => jsonResponse(response, 502, { error: { message: String(error), type: 'server_error', code: 'model_list_failed' } }))
      return
    }
    if ((path === '/v1/chat/completions' || path === '/v1/responses') && request.method === 'POST') {
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        jsonResponse(response, 415, { error: { message: 'Content-Type must be application/json', type: 'invalid_request_error', code: 'invalid_content_type' } })
        return
      }
      void (path === '/v1/responses' ? handleResponses(request, response) : handleChat(request, response))
      return
    }
    jsonResponse(response, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } })
  }

  return {
    async start(): Promise<void> {
      if (server !== undefined) return
      const current = createServer(requestHandler)
      // ⚠️ **必须显式设置**（Issue IKKUBJ）：不设就落到 Node 默认的 5 秒，而那个
      // 默认值对「人读着回复、隔几分钟再问一句」的用法完全不够 —— 服务端已发 FIN，
      // 客户端再复用这条连接就是 Connection reset（实测响应头会写明
      // `Keep-Alive: timeout=5`，是外部可观测的证据，用例据此断言）。
      current.keepAliveTimeout = 120000
      // 必须 **>** keepAliveTimeout：它管「连接上收到完整请求头」的时限，
      // 若更短，长连接会在 keep-alive 窗口内被提前掐断，症状与上一条相同。
      current.headersTimeout = 130000
      // ⚠️⚠️ `server` 槽位必须**在 listen 成功之后**才赋值（对抗审计发现的 P1）。
      //
      // 原实现在 `listen()` **之前**就 `server = current`，于是存在这个竞态：
      // `start()` 挂起等 `listening` 事件期间，若 `close()` 抢先执行，它会把这个
      // **尚未监听的** server 当作当前实例：置 `server = undefined`，然后调
      // `current.close(...)` ⇒ 该回调收到 `Error: Server is not running.`（实测）
      // ⇒ `close()` 正常返回，但 `start()` 等的 `listening` **永远不会触发**
      // （server 从未 listen 成功）⇒ **`start()` 的 Promise 永久挂起**。
      //
      // 实测证据（对抗审计 A9）：`close() = closed` 而 `start() = PENDING > 2000ms`。
      // 后果：收敛队列被那个永挂的 `start()` 卡住 ⇒ 用户再也打不开网关。
      //
      // 修法：① 槽位只在 listen 成功后赋值；② 用 `pendingStart` 让 `close()` 能
      // 找到「正在启动中」的实例并请求它放弃（否则 `close()` 看不见它）。
      server = undefined
      let cancelled = false
      pendingStart = {
        cancel: () => {
          cancelled = true
          // 从未 listen 成功 ⇒ close 回调会回 `Server is not running.`，刻意忽略。
          current.close(() => {})
          resolvePending?.()
        },
      }
      let resolvePending: (() => void) | undefined
      await new Promise<void>((resolve, reject) => {
        resolvePending = resolve
        const onError = (error: Error) => {
          current.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          current.off('error', onError)
          if (cancelled) {
            // 启动途中被关闭：把刚拿到的监听立刻关掉，避免泄漏一个无人持有的
            // socket，然后按「已取消」结束（不是错误 —— 是调用方主动关的）。
            current.close(() => {})
            resolve()
            return
          }
          const address = current.address()
          boundPort = typeof address === 'object' && address !== null ? address.port : config.port
          // 只在真正监听成功后占槽位（见上面的竞态说明）。
          server = current
          resolve()
        }
        current.once('error', onError)
        current.once('listening', onListening)
        current.listen(config.port, config.host)
      }).catch((error) => {
        logger.error(`[openai-gateway] 启动失败 ${config.host}:${config.port}：${error instanceof Error ? error.message : String(error)}`)
        throw error
      }).finally(() => {
        pendingStart = undefined
      })
      logger.info(`[openai-gateway] 已监听 ${gatewayHttpUrl(config.host, boundPort, '/v1')}`)
      // ⚠️ 绑非回环地址时必须留痕（IKL7UN 的 UI/日志文案守则：暴露面变了要明说）。
      // 这是服务端侧的唯一提示点 —— 设置页有同款警告（gatewayFootnote 的非回环分支）。
      if (!isLoopbackHost(config.host)) {
        logger.warn(
          `[openai-gateway] 网关绑定在 ${config.host}（非回环）：同一网络的其它设备都能连到该端口，`
          + '隔离只靠 API Key——不要把它配置进任何浏览器端工具或扩展。',
        )
      }
    },
    /**
     * 关闭监听并**确保一定在有限时间内返回**。
     *
     * ## 为什么不能直接 `await new Promise(r => server.close(r))`（Issue #11）
     *
     * `server.close()` 的回调只在**所有** socket 关闭后触发。`abort()` 只停业务
     * 逻辑、不断连；在途 SSE 的 socket 会停在 keep-alive 状态等
     * `keepAliveTimeout`（本网关 120s）。实测换绑时 `close()` 挂 **121 秒**，
     * 期间 `running` 已置 `undefined`、网关不监听、**零日志** ⇒ 用户看到「网关
     * 静默消失」，下游全 connection refused（看起来像 API-key 错误）。
     *
     * ## 三段式：abort → 宽限 → 强制断开
     *
     * 1. `abort()`：通知业务逻辑停止，让它在宽限窗口内把已产生的帧刷出去
     *    （直接断连会让客户端拿到连接重置，而不是一个干净的流结束）；
     * 2. 等 {@link CLOSE_GRACE_MS}：给正常收尾留时间，**绝大多数情况在这里就完事**；
     * 3. 仍在等 ⇒ `closeAllConnections()` 强制断开。
     *
     * ⚠️ 这里**刻意不用** `closeIdleConnections()`：实测它对「正在承载在途响应」
     * 的 socket 无效（那些 socket 不算 idle），只有 `closeAllConnections()` 能解除
     * —— 两种方法在 Issue #11 的复现里分别是「永不返回」与「1ms 返回」。
     *
     * ⚠️ `closeAllConnections` 需要 Node ≥ 18.2；本包 `engines` 是
     * `^22.19.0 || >=24.0.0`，且仍做特性检测以兼容被裁剪的运行环境。
     */
    async close(): Promise<void> {
      for (const controller of active) controller.abort()
      // ⚠️ 先请求「正在启动中」的实例放弃（见 pendingStart 的理由）：否则那个
      // `start()` 会永远等一个不会到来的 `listening` 事件。
      if (pendingStart !== undefined) {
        pendingStart.cancel()
        pendingStart = undefined
      }
      if (server === undefined) return
      const current = server
      server = undefined
      // 三态结果：'closed' 正常收尾；'forced' 宽限超时后强制断开；
      // 'failed' close() 本身抛错（例如 server 从未成功 listen）。
      let outcome: 'closed' | 'forced' | 'failed' = 'closed'
      const closed = new Promise<void>((resolve, reject) => {
        // ⚠️ `close()` 在「server 未在监听」时会回一个 Error 给回调（而不是抛）。
        // 按契约 `close()` 不向调用方抛错 —— 调用方是 runtime 的收敛链，抛出去会
        // 让「关闭」这一步失败，进而把后续的重建也跳过（见 runtime 的注释）。
        current.close((error?: Error) => (error === undefined ? resolve() : reject(error)))
      })
      // 先挂上 catch，避免宽限竞速期间产生 unhandledRejection。
      const settled = closed.then(() => 'ok' as const, () => 'err' as const)
      const raced = await Promise.race([
        settled,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), CLOSE_GRACE_MS).unref?.()),
      ])
      if (raced === 'timeout') {
        outcome = 'forced'
        // ⚠️ 强制断开后**仍要等 close 的回调**：否则下一次 `listen()` 可能与尚未
        // 释放的端口撞车（EADDRINUSE），把一个可恢复的换绑变成永久失效。
        // 强制断开本身是同步生效的，这里只是等内核确认，耗时可忽略。
        if (typeof current.closeAllConnections === 'function') current.closeAllConnections()
        else if (typeof current.closeIdleConnections === 'function') current.closeIdleConnections()
        // ⚠️⚠️ 这个等待**必须有上限**（审计发现，P1）：`close()` 的对外承诺是
        // 「一定在有限时间内返回」，而上一版这里是裸 `await settled` —— 一旦底层
        // 回调不触发（被 patch 的 server、异常 socket 状态、或 fallback 分支下
        // `closeIdleConnections` 对在途 socket 无效），`close()` 就**永不返回**。
        // 而 `close()` 的调用方是收敛队列：队列会因此永久卡死 ⇒ **用户再也打不开
        // 网关，且无任何自愈路径**（`disposeGatewayRuntime` 只挂在插件卸载上，
        // 生产路径里没人调）。那比原 bug 更糟 —— 原 bug 至少 120s 后会自愈。
        // 宁可留下一个已强制断开的僵尸 server 槽位（下面已置 undefined，
        // 下次 listen 会新建），也不能让调用方永久悬挂。
        const drain = await Promise.race([
          settled,
          new Promise<'drain-timeout'>((resolve) => setTimeout(() => resolve('drain-timeout'), CLOSE_DRAIN_MS).unref?.()),
        ])
        if (drain === 'drain-timeout') {
          // 留痕：这说明内核/底层没有在强制断开后确认关闭，属于需要排查的异常。
          logger.warn(
            `[openai-gateway] 强制断开后底层仍未在 ${CLOSE_DRAIN_MS}ms 内确认关闭，已放弃等待（下次启动会新建监听）`,
          )
        }
      } else if (raced === 'err') {
        outcome = 'failed'
      }
      if (outcome === 'forced') {
        // 这条日志是**诊断的出口**：不记的话，用户在 Issue #11 里看到的就是
        // 「网关没了但什么都没说」。warn 而非 info —— 说明有请求被强制中断。
        logger.warn(
          `[openai-gateway] 关闭时仍有在途连接未在 ${CLOSE_GRACE_MS}ms 内收尾，已强制断开`,
        )
      } else if (outcome === 'failed') {
        // ⚠️ 实测可达：对**从未成功 listen** 的 server 调 close()，回调会收到
        // `Error: Server is not running.`。这不影响后续重建（实例已从 server 槽位
        // 摘除），但必须留痕 —— 静默吞掉会让「为什么上一轮没起来」无从排查。
        logger.warn('[openai-gateway] 关闭时底层 server 报错（通常意味着它从未成功监听），已忽略')
      }
      logger.info('[openai-gateway] 已关闭')
    },
    address(): { host: string; port: number } {
      return { host: config.host, port: boundPort }
    },
    apiKey,
  }
}
