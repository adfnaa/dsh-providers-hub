/** 华为云 SDK-HMAC-SHA256 请求签名 extraHeaders */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', key.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Map<string, string>,
  payloadHash: string,
): string {
  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`)
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n')
}

/**
 * 解码失败（畸形 `%` 序列，如 `?a=100%`）时**原样返回**——签名函数绝不抛
 * （抛了会把一条本来能发的请求变成异常路径；值非标准转义时服务端对
 * canonical 的口径也无从对齐，保守按原文参与排序）。
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 把 wire query 规范成 **key 排序** 的 canonical query（SDK-HMAC-SHA256 要求）。
 *
 * ## 为什么必须排序（2026-10-29 真机 2×2 实测定案）
 *
 * AgentCenter `/v1/agent-center/agents/useragents?offset=0&limit=100` 上，
 * **唯一**失败的组合是「wire URL 按 offset,limit 顺序 + 签名也按该顺序」⇒
 * `401 verify ak sk signature fail`；改成签名内排序后 200，且 wire URL 的
 * 顺序无关（服务端按**自己收到的参数排序后**重算 canonical）。四轮重复 4/4
 * 确定性。这符合华为云官方文档「CanonicalQuery 是按 key 字典序排列」的口径。
 *
 * ## 为什么现在才改 / 波及面（全部核对过）
 *
 * 本 signer 此前把 `url.search` **原样**拼进 canonical —— 对无 query 的请求
 * （chat / builtin / gateway/config / benefit claim）是无操作；对排序恰好等于
 * 字典序的请求也是无操作（`queue/status?model=X&task_id=Y`：m < t）；
 * `credit/usage?type=msg&id=…` 的 401 与排序无关（raw/sorted 双模式真机都
 * 401，是缺 IDE 专属遥测头）。⇒ 统一排序对既有调用方**零行为变化**，
 * 只有 AgentCenter 这类「wire 顺序 ≠ 字典序」的多参数 GET 需要它。
 *
 * ⚠️ 只重排**签名里**的 query，wire URL 保持原样（调用方仍按原 URL 发请求）。
 * 值的再编码用 `encodeURIComponent`：现网全部 query 值都在
 * `[A-Za-z0-9_.-]` 安全集内（uuid、模型 id、`msg`、`DESKTOP`、数字），
 * 三种编码口径（原样/encodeURI/encodeURIComponent）在此集合上逐字节相同。
 */
export function canonicalQueryOf(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  if (raw.length === 0) return ''
  const pairs: Array<[string, string]> = []
  for (const part of raw.split('&')) {
    if (part.length === 0) continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const value = eq === -1 ? '' : part.slice(eq + 1)
    pairs.push([safeDecode(key), safeDecode(value)])
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

/** 签名一个华为请求；返回需合并到请求中的头映射。 */
export async function signRequestHuawei(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  // canonical query 必须 key 排序（见 canonicalQueryOf 的 2×2 实测定案）；
  // wire URL 原样发送，只改签名侧。
  const query = canonicalQueryOf(url.search)
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payloadHash = await sha256Hex(body)

  const headers = new Map<string, string>()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', securityToken)
  // 额外的签名头（如 glm-5.3-flash 的 maas_type: benefit）：与 Rust 参考实现
  // sign_request_huawei 的 extra_headers 一致，参与 canonical 计算并包含在
  // SignedHeaders 中，需原样随请求发送，否则服务端验签失败。
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  }
  // GET 请求（排队状态轮询）不携带请求体，因此无 content-type。
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()

  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash)
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest))
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign))
  headers.set('Authorization', `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`)
  return headers
}
