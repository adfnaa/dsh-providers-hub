import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenAiGateway, CLOSE_DRAIN_ACTIVE_MS } from '../../src/openai-gateway/server.js'

/**
 * Gitee issue IKQODR 的两个缺陷的回归锁。
 *
 * ## 缺陷 1（严重、100% 命中）：正常结束也补发失败帧
 *
 * `/v1/responses` 的流式出口在 `for await` 之后**无条件**补发 `response.failed`，
 * 而「自然收尾」时 `response.writableEnded` 同样是 `false`（还没调 `end()`）
 * ⇒ 每一次**成功**的请求都被追加一条失败事件，客户端把完整收到的一轮判为失败，
 * 且文案谎称「网关已关闭」而网关根本没关。同源：`/v1/chat/completions` 会发
 * **两个** `data: [DONE]`（`toOpenAiSse` 自己已发过一条）。
 *
 * ⚠️ 这个坑的教训：原注释写的是「被 abort 时补发」——读起来像条件已经存在，
 * 而代码里没有。**注释描述意图，不等于实现了意图。**
 *
 * ## 缺陷 2（中等）：换绑砍断在途 + 空窗期拒连
 *
 * 原先 `close()` 第一行就 `abort()`，而换绑是「先 `await close()`、再起新实例」
 * ⇒ ① 在途流被砍（实测 6 帧只收到 3 帧）；② 空窗期下游 `ECONNREFUSED`。
 * 修法：`detachListen()` 先交端口 → 新实例接管 → 旧实例**后台排水**
 * （`close({ drainActiveMs })`），并保留「用户主动关网关 = 立即中断」的语义。
 */

let home: string

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a !== null ? a.port : 0
      s.close(() => resolve(p))
    })
  })
}

/** 上游流：每 100ms 一帧，共 6 帧（约 600ms，远长于 250ms 宽限）。 */
function makeGateway(port: number) {
  return createOpenAiGateway({
    home,
    env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      listProviders: () => ['fake'],
      listModels: async () => [{ id: 'fake-model', name: 'fake' }],
      resolveModelInfo: async () => ({ id: 'fake-model' }),
      async *stream(options: { signal?: AbortSignal }) {
        for (let i = 1; i <= 6; i += 1) {
          if (options?.signal?.aborted === true) return
          yield { type: 'text-delta', text: `chunk${i} ` } as never
          await new Promise<void>((r) => setTimeout(r, 100))
        }
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    } as never,
  })
}

function openStream(port: number) {
  let received = ''
  const done = new Promise<void>((resolve) => {
    const req = request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', timeout: 30000,
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => { received += c })
      res.on('end', () => resolve())
      res.on('error', () => resolve())
      res.on('aborted', () => resolve())
    })
    req.on('error', () => resolve())
    req.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
  })
  return { done, get received() { return received } }
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ikqodr-fix2-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('IKQODR 缺陷2 修复验收', () => {
  it('★★ detachListen 后旧实例在途流仍能跑完（6/6 帧）', async () => {
    const port = await freePort()
    const g = makeGateway(port)
    await g.start()
    const probe = openStream(port)
    await new Promise((r) => setTimeout(r, 250))
    const before = (probe.received.match(/chunk\d/g) ?? []).length
    console.log('[修2] detach 前已收到 =', before)

    // 交端口（换绑的第一步）
    g.detachListen()
    // 排水：给足窗口
    await g.close({ drainActiveMs: CLOSE_DRAIN_ACTIVE_MS })
    await probe.done
    const total = (probe.received.match(/chunk\d/g) ?? []).length
    console.log('[修2] 排水后总共收到 =', total, '（满额 6）')
    // ⚠️ 修复前实测只有 3 帧
    expect(total).toBe(6)
  }, 40000)

  it('★★ detachListen 后同端口可立即被新实例接管（空窗期≈0）', async () => {
    const port = await freePort()
    const g1 = makeGateway(port)
    await g1.start()
    g1.detachListen()
    // ⚠️ 立刻在同端口起新实例（不等待、不 sleep）
    const g2 = makeGateway(port)
    await g2.start()
    const addr = g2.address()
    console.log('[修2] 新实例接管 =', JSON.stringify(addr))
    expect(addr.port).toBe(port)
    // 物理判据：真的能连上（不是只回了配置字符串）
    const code = await new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: 3000 }, (res) => {
        res.resume(); resolve(`HTTP ${res.statusCode}`)
      })
      req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message))
      req.end()
    })
    console.log('[修2] 新实例可达性 =', code)
    expect(code).toBe('HTTP 401')
    await g2.close({ drainActiveMs: 0 })
  }, 40000)

  it('★ 用户主动关网关（drainActiveMs: 0）仍必须**立即**中断在途流', async () => {
    const port = await freePort()
    const g = makeGateway(port)
    await g.start()
    const probe = openStream(port)
    await new Promise((r) => setTimeout(r, 250))
    const before = (probe.received.match(/chunk\d/g) ?? []).length
    const t0 = Date.now()
    await g.close({ drainActiveMs: 0 })
    const elapsed = Date.now() - t0
    await probe.done
    const total = (probe.received.match(/chunk\d/g) ?? []).length
    console.log('[修2] 主动关：before =', before, '| total =', total, '| close 耗时 =', elapsed)
    // 语义不变：用户说「现在停」就是现在停 —— 不得等 6 帧跑完
    expect(total).toBeLessThan(6)
    expect(elapsed).toBeLessThan(2000)
  }, 40000)
})

/**
 * ★★ 换绑失败**必须重试**（自查发现的新失败模式）。
 *
 * 换绑的第一步 `detachListen()` 已经把**旧实例的端口交出去了**。此时若新实例
 * `start()` 失败（端口被外部进程抢、或内核尚未回收），网关就**完全没有监听**，
 * 而旧实例还在后台排水、不会自动恢复 —— **这比修复前更糟**（修复前旧实例至少
 * 还在监听）。
 *
 * 实测复现：`g1.detachListen()` → 外部占端口 → `g2.start()` 抛 `EADDRINUSE`
 * ⇒ 端口此刻 `EADDRINUSE`（既不是 g1 也不是 g2 在服务）。
 *
 * 修法：换绑路径（`replaced !== undefined`）首次 start 失败后**换新实例重试一次**
 * —— `detachListen()` 是同步释放端口的，第一次失败往往就是内核回收的极短窗口。
 */
describe('IKQODR：换绑失败必须重试（不留「无监听」状态）', () => {
  it('★★ 换绑时首次 start 失败 ⇒ 重试后必须仍在监听', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    let starts = 0
    let failNext = false
    runtime.registerGatewayFactory((() => ({
      async start() {
        starts += 1
        if (failNext) { failNext = false; throw new Error('listen EADDRINUSE (模拟)') }
      },
      detachListen() {},
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)

    // 换绑 + 让首次 start 失败一次
    failNext = true
    const before = starts
    runtime.setGatewayDesiredAllowLan(true)
    await runtime.applyGatewayDesiredState()

    expect(runtime.isGatewayRunning()).toBe(true)
    // 首次失败 + 重试成功 ⇒ 至少 2 次
    expect(starts - before).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it('★ 首次启动失败（非换绑）不得重试（没有旧实例要救）', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    // ⚠️ 必须从「干净状态」开始：前一个用例可能留下 running 实例，那样本轮会走
    // **换绑**分支（有旧实例要救）⇒ 重试是**正确**行为，本用例就变成测错对象。
    // 实测踩过：前一个用例的假实例 `address()` 恒返回回环地址，而期望态是
    // wildcard ⇒ 永远失配 ⇒ 每次收敛都走换绑分支 ⇒ starts 变 2（假红）。
    await runtime.disposeGatewayRuntime()
    let starts = 0
    runtime.registerGatewayFactory((() => ({
      async start() { starts += 1; throw new Error('boom') },
      detachListen() {},
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(false)
    // ⚠️ 非换绑路径不该重试 —— 否则「端口被永久占用」会变成每次收敛都白发两发
    expect(starts).toBe(1)
  }, 20_000)
})
