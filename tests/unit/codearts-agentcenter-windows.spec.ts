import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCodeArtsRemoteModels, readAgentCenterWindow,
  SNAP_AGENT_CENTER_DETAIL_URL, SNAP_AGENT_CENTER_USERAGENTS_URL, SNAP_MODEL_BUILTIN_URL,
} from '../../src/models.js'
import { canonicalQueryOf, signRequestHuawei } from '../../src/sign.js'
import type { CodeArtsCredential } from '../../src/types.js'

function makeCredential(): CodeArtsCredential {
  return {
    access_key_id: 'AKTEST',
    secret_access_key: 'SKTEST',
    security_token: 'STTEST',
    expires_at: '2026-12-31T00:00:00Z',
    refresh_token: 'rt',
    code_verifier: 'cv',
    dpop_private_key_jwk: 'jwk',
  } as CodeArtsCredential
}

function makeFetcher(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (route === undefined) return new Response('', { status: 404 })
    return new Response(route.body, { status: route.status ?? 200 })
  }
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

/** 实测 2026-10-29 的 AgentCenter 响应形状（id 全部真实）。 */
const USERAGENTS_BODY = JSON.stringify({
  agents: [
    { id: 'agent-secondary', is_primary_agent: false },
    { id: 'agent-primary', is_primary_agent: true },
  ],
})

const DETAIL_BODY = JSON.stringify({
  gpts: {
    models: [
      { model_id: 'GLM-5.2', model_alias: 'GLM-5.2', model_parameters: { context_window: 202752, max_tokens: 65536, supports_images: false } },
      { model_id: 'deepseek-v4.1-flash-1017', model_alias: 'DeepSeek V4.1', model_parameters: { context_window: 1048576, max_tokens: 65536 } },
      { model_id: 'kimi-k3', model_alias: 'Kimi K3', model_parameters: { context_window: 1048576, max_tokens: 65536 } },
      { model_id: 'Qwen3-VL-235B', model_alias: 'VL', model_parameters: { context_window: 1048576 } },
      { model_id: 'no-window-model', model_alias: 'NoWindow', model_parameters: { max_tokens: 1024 } },
      { model_id: 'bad-window', model_alias: 'Bad', model_parameters: { context_window: '1048576' } },
    ],
  },
})

/** builtin 只给 GLM-5.2（kimi-k3 缺席 = 实测 builtin 漏发该模型的形态）。 */
const BUILTIN_BODY = JSON.stringify({
  count: 1,
  builtinModels: [{ model_id: 'GLM-5.2', model_name: 'GLM-5.2' }],
})

const FULL_ROUTES: Record<string, { body: string }> = {
  [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: USERAGENTS_BODY },
  [`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=agent-primary`]: { body: DETAIL_BODY },
  [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
}

let cacheDirToRemove: string | undefined

beforeEach(() => {
  // AgentCenter 窗口只进 RemoteModel，不落 benefit 缓存；但 fetchCodeArtsRemoteModels
  // 会写 models/benefit 缓存（目录非空）—— 用临时目录隔离，别污染真实用户缓存。
  cacheDirToRemove = mkdtempSync(join(tmpdir(), 'codearts-agentcenter-'))
  process.env['DSH_CODEARTS_CACHE_DIR'] = cacheDirToRemove
})

afterEach(() => {
  delete process.env['DSH_CODEARTS_CACHE_DIR']
  if (cacheDirToRemove !== undefined) rmSync(cacheDirToRemove, { recursive: true, force: true })
  cacheDirToRemove = undefined
  vi.useRealTimers()
})

describe('canonicalQueryOf（signer 排序 query）', () => {
  it('sorts parameters by key (and by value on tie)', () => {
    expect(canonicalQueryOf('?offset=0&limit=100')).toBe('limit=100&offset=0')
    expect(canonicalQueryOf('?b=2&a=1')).toBe('a=1&b=2')
    expect(canonicalQueryOf('?a=2&a=1')).toBe('a=1&a=2')
  })

  it('handles empty, bare and roundtrip-safe values', () => {
    expect(canonicalQueryOf('')).toBe('')
    expect(canonicalQueryOf('?')).toBe('')
    expect(canonicalQueryOf('?onlykey')).toBe('onlykey=')
    expect(canonicalQueryOf('?k=a%20b')).toBe('k=a%20b')
    expect(canonicalQueryOf('a=1')).toBe('a=1')
  })

  it('signRequestHuawei signs the same canonical query regardless of wire order (2×2 evidence, faked clock)', async () => {
    // x-sdk-date 是秒级 ISO —— 假时钟钉死，两发才可比。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T04:00:00Z'))
    const a = await signRequestHuawei('AK', 'SK', 'ST', 'GET',
      'https://snap-access.cn-north-4.myhuaweicloud.com/v1/x?offset=0&limit=100', new Uint8Array())
    const b = await signRequestHuawei('AK', 'SK', 'ST', 'GET',
      'https://snap-access.cn-north-4.myhuaweicloud.com/v1/x?limit=100&offset=0', new Uint8Array())
    // 修前：raw query 进 canonical ⇒ 两种 wire 顺序签名不同（服务端按 sorted 重算
    // ⇒ offset,limit 顺序 401 verify ak sk signature fail，2026-10-29 四轮实测）。
    expect(a.get('Authorization')).toBe(b.get('Authorization'))
  })
})

describe('readAgentCenterWindow', () => {
  it('accepts positive integers only (no string coercion, no zero/negative)', () => {
    expect(readAgentCenterWindow({ model_parameters: { context_window: 202752, max_tokens: 65536 } }))
      .toEqual({ contextWindow: 202752, maxOutputTokens: 65536 })
    expect(readAgentCenterWindow({ model_parameters: { context_window: '1048576' } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: { context_window: 0 } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: { context_window: -1 } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: { context_window: 1.5 } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: null })).toEqual({})
    expect(readAgentCenterWindow({})).toEqual({})
  })
})

describe('AgentCenter 动态窗口合并', () => {
  it('enriches builtin models and adds unseen ids (kimi-k3), filtering VL and windowless entries', async () => {
    const { fetcher, calls } = makeFetcher(FULL_ROUTES)
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const glm = models.find((m) => m.id === 'GLM-5.2')
    expect(glm?.contextWindow).toBe(202752)
    expect(glm?.maxOutputTokens).toBe(65536)
    const kimi = models.find((m) => m.id === 'kimi-k3')
    expect(kimi?.contextWindow).toBe(1048576)
    expect(kimi?.name).toBe('Kimi K3')
    const ds = models.find((m) => m.id === 'deepseek-v4.1-flash-1017')
    expect(ds?.contextWindow).toBe(1048576)
    expect(models.find((m) => m.id === 'Qwen3-VL-235B')).toBeUndefined()
    expect(models.find((m) => m.id === 'no-window-model')).toBeUndefined()
    expect(models.find((m) => m.id === 'bad-window')).toBeUndefined()
    // primary agent 选择：detail 请求的是 is_primary_agent=true 的那条
    const detailCall = calls.find((c) => c.url.startsWith(SNAP_AGENT_CENTER_DETAIL_URL))
    expect(detailCall?.url).toBe(`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=agent-primary`)
  })

  it('signs agent-type / x-language (routing headers) into SignedHeaders', async () => {
    const { fetcher, calls } = makeFetcher(FULL_ROUTES)
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ua = calls.find((c) => c.url === SNAP_AGENT_CENTER_USERAGENTS_URL)
    expect(ua).toBeDefined()
    const auth = ua?.headers.get('Authorization') ?? ''
    // 修前：路由头只在签名**后**追加 ⇒ 不在 SignedHeaders 里（AgentCenter 按同口径
    // 从严 —— 去 x-language 真机 400 TM.00001001）。
    expect(auth).toContain('agent-type;host;x-language;')
    expect(ua?.headers.get('agent-type')).toBe('AgentCenter')
    expect(ua?.headers.get('x-language')).toBe('zh-cn')
  })

  it('AgentCenter failure degrades to no windows without blocking the catalog', async () => {
    // useragents 404 ⇒ 窗口表为空 ⇒ builtin 目录照常返回（无窗口字段）
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
    // detail 失败同理
    const { fetcher: f2 } = makeFetcher({
      [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: USERAGENTS_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models2 = await fetchCodeArtsRemoteModels(makeCredential(), f2)
    expect(models2).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
  })

  it('malformed useragents / detail bodies return an empty window map (no throw)', async () => {
    for (const body of ['not-json', JSON.stringify({ agents: 'x' }), JSON.stringify({ agents: [] }), '{}']) {
      const { fetcher } = makeFetcher({
        [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body },
        [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
      })
      const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
      expect(models.find((m) => m.id === 'GLM-5.2')).toBeDefined()
    }
    // agents 存在但 detail 坏
    const { fetcher } = makeFetcher({
      [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: USERAGENTS_BODY },
      [`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=agent-primary`]: { body: 'garbage' },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models.find((m) => m.id === 'GLM-5.2')).toBeDefined()
    expect(models.find((m) => m.id === 'kimi-k3')).toBeUndefined()
  })

  it('falls back to the first agent when no is_primary_agent flag exists', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: JSON.stringify({ agents: [{ id: 'first-agent' }] }) },
      [`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=first-agent`]: { body: DETAIL_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const detailCall = calls.find((c) => c.url.startsWith(SNAP_AGENT_CENTER_DETAIL_URL))
    expect(detailCall?.url).toBe(`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=first-agent`)
  })
})
