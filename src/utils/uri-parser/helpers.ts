const URI_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//

export function normalizeUriAndGetScheme(input: string): {
  uri: string
  scheme: string
} {
  const trimmed = input.trim()
  const match = URI_SCHEME_RE.exec(trimmed)
  if (!match) {
    const schemeGuess = (trimmed.split('://')[0] ?? '').toLowerCase()
    return { uri: trimmed, scheme: schemeGuess }
  }

  const scheme = match[1].toLowerCase()
  return { uri: scheme + trimmed.slice(match[1].length), scheme }
}

export function stripUriScheme(
  uri: string,
  expectedSchemes: string | readonly string[],
  errorMessage: string,
): string {
  const match = URI_SCHEME_RE.exec(uri)
  if (!match) {
    throw new Error(errorMessage)
  }
  const scheme = match[1].toLowerCase()

  const expected =
    typeof expectedSchemes === 'string' ? [expectedSchemes] : expectedSchemes
  if (!expected.includes(scheme)) {
    throw new Error(errorMessage)
  }
  return uri.slice(match[0].length)
}

export function getIfNotBlank(
  value: string | undefined,
  dft?: string,
): string | undefined {
  return value && value.trim() !== '' ? value : dft
}

export function getIfPresent<T>(
  value: T | null | undefined,
  dft?: T,
): T | undefined {
  return value !== null && value !== undefined ? value : dft
}

export function isPresent(value: any): boolean {
  return value !== null && value !== undefined
}

export function trimStr(str: string | undefined): string | undefined {
  return str ? str.trim() : str
}

export function safeDecodeURIComponent(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function decodeAndTrim(value: string | undefined): string | undefined {
  const decoded = safeDecodeURIComponent(value)
  const trimmed = decoded?.trim()
  return trimmed ? trimmed : undefined
}

export function splitOnce(input: string, delimiter: string): [string, string?] {
  const idx = input.indexOf(delimiter)
  if (idx === -1) return [input]
  return [input.slice(0, idx), input.slice(idx + delimiter.length)]
}

export function parseQueryString(
  query: string | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  if (!query) return out
  for (const part of query.split('&')) {
    if (!part) continue
    const [keyRaw, valueRaw] = splitOnce(part, '=')
    const key = keyRaw.trim()
    if (!key) continue
    out[key] =
      valueRaw === undefined
        ? undefined
        : (safeDecodeURIComponent(valueRaw) ?? valueRaw)
  }
  return out
}

function normalizeQueryKey(key: string): string {
  return key.replace(/_/g, '-')
}

export function parseQueryStringNormalized(
  query: string | undefined,
): Record<string, string | undefined> {
  const raw = parseQueryString(query)
  const normalized: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(raw)) {
    normalized[normalizeQueryKey(key)] = value
  }
  return normalized
}

export function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  return /^(?:true|1)$/i.test(value)
}

export function parseBoolOrPresence(value: string | undefined): boolean {
  if (value === undefined) return true
  const trimmed = value.trim()
  if (trimmed === '') return true
  return /^(?:true|1)$/i.test(trimmed)
}

const INSECURE_QUERY_KEYS = [
  'skip-cert-verify',
  'allowInsecure',
  'allow-insecure',
  'insecure',
] as const

export function parseInsecureParam(
  params: Record<string, string | undefined>,
): boolean | undefined {
  for (const key of INSECURE_QUERY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return parseBoolOrPresence(params[key])
    }
  }
  return undefined
}

export function parseCommaList(
  value: string | undefined,
): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

export function parseJsonObjectSafe(
  value: string | undefined,
): Record<string, any> | undefined {
  const trimmed = value?.trim()
  if (!trimmed || !trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

export function parseEchParam(
  echValue: string | undefined,
  queryServerName?: string,
): EchOptions | undefined {
  const trimmed = echValue?.trim()
  const serverName = getIfNotBlank(queryServerName)
  if (!trimmed) {
    return serverName
      ? { enable: true, 'query-server-name': serverName }
      : undefined
  }
  if (/^(?:false|0)$/i.test(trimmed)) return undefined
  if (/^(?:true|1)$/i.test(trimmed)) {
    const opts: EchOptions = { enable: true }
    if (serverName) opts['query-server-name'] = serverName
    return opts
  }
  // Xray ECH format may encode "<sni>+https://<doh-server>" instead of base64 config
  const xrayDohMatch = /^([^+]+)\+(https?:\/\/.+)$/i.exec(trimmed)
  if (xrayDohMatch) {
    const opts: EchOptions = {
      enable: true,
      'query-server-name': serverName ?? xrayDohMatch[1].trim(),
    }
    return opts
  }
  const opts: EchOptions = {
    enable: true,
    config: trimmed,
  }
  if (serverName) opts['query-server-name'] = serverName
  return opts
}

export function parseVlessFlow(value: string | undefined): string | undefined {
  const flow = getIfNotBlank(value)
  if (!flow) return undefined
  if (/^none$/i.test(flow)) return undefined
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(flow)) return undefined
  return flow
}

export function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

function parsePortStrict(
  value: string | number | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined
  const raw = String(value).trim()
  if (!/^\d+$/.test(raw)) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined
  }
  return parsed
}

export function parseRequiredPort(
  value: string | number | null | undefined,
  errorMessage: string,
): number {
  const parsed = parsePortStrict(value)
  if (parsed === undefined) {
    throw new Error(errorMessage)
  }
  return parsed
}

export function parsePortOrDefault(
  port: string | undefined,
  dft: number,
): number {
  return parseInteger(port) ?? dft
}

const IP_VERSIONS = [
  'dual',
  'ipv4',
  'ipv6',
  'ipv4-prefer',
  'ipv6-prefer',
] as const

export function parseIpVersion(
  value: string | undefined,
): (typeof IP_VERSIONS)[number] {
  return value && IP_VERSIONS.includes(value as (typeof IP_VERSIONS)[number])
    ? (value as (typeof IP_VERSIONS)[number])
    : 'dual'
}

export type UrlLikeParts = {
  auth?: string
  host: string
  port?: string
  query?: string
  fragment?: string
}

export function normalizeHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function splitAuthorityAndPath(input: string): {
  auth?: string
  host: string
  port?: string
  query?: string
  fragment?: string
} {
  const [beforeHash, fragment] = splitOnce(input, '#')
  const [authorityAndPath, query] = splitOnce(beforeHash, '?')
  const atIdx = authorityAndPath.lastIndexOf('@')
  const auth = atIdx === -1 ? undefined : authorityAndPath.slice(0, atIdx)
  const hostSection =
    atIdx === -1 ? authorityAndPath : authorityAndPath.slice(atIdx + 1)
  const [hostPort] = splitOnce(hostSection, '/')

  let host = hostPort
  let port: string | undefined

  if (hostPort.startsWith('[')) {
    const closeIdx = hostPort.indexOf(']')
    if (closeIdx === -1) {
      throw new Error('Invalid host: unclosed IPv6 bracket')
    }
    host = hostPort.slice(1, closeIdx)
    const remainder = hostPort.slice(closeIdx + 1)
    if (remainder.startsWith(':')) {
      const candidate = remainder.slice(1)
      if (candidate) port = candidate
    } else if (remainder.length > 0) {
      throw new Error('Invalid authority suffix after IPv6 host')
    }
  } else {
    const firstColon = hostPort.indexOf(':')
    const lastColon = hostPort.lastIndexOf(':')
    if (firstColon !== -1 && firstColon === lastColon) {
      host = hostPort.slice(0, lastColon)
      const candidate = hostPort.slice(lastColon + 1)
      if (candidate) port = candidate
    }
  }

  return {
    auth,
    host: normalizeHost(host),
    port,
    query,
    fragment,
  }
}

export function parseUrlLike(
  input: string,
  options: { requireAuth: true; errorMessage: string },
): UrlLikeParts & { auth: string }
export function parseUrlLike(
  input: string,
  options: { requireAuth?: false; errorMessage: string },
): UrlLikeParts
export function parseUrlLike(
  input: string,
  options: { requireAuth?: boolean; errorMessage: string },
): UrlLikeParts {
  let parsed: ReturnType<typeof splitAuthorityAndPath>
  try {
    parsed = splitAuthorityAndPath(input)
  } catch {
    throw new Error(options.errorMessage)
  }

  const auth = getIfNotBlank(parsed.auth)
  if (options.requireAuth && !auth) {
    throw new Error(options.errorMessage)
  }

  const result: UrlLikeParts = {
    auth,
    host: parsed.host,
    port: parsed.port,
    query: parsed.query,
    fragment: parsed.fragment,
  }
  return options.requireAuth
    ? ({ ...result, auth } as UrlLikeParts & { auth: string })
    : result
}

export function isIPv4(address: string): boolean {
  // Check if the address is IPv4
  const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
  return ipv4Regex.test(address)
}

export function isIPv6(address: string): boolean {
  // Check if the address is IPv6 - simplified regex to avoid backreference issues
  const ipv6Regex =
    /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::$|^::1$|^([0-9a-fA-F]{1,4}:)*::([0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}$/
  return ipv6Regex.test(address)
}

export function decodeBase64ToBytes(str: string): Uint8Array {
  const normalized = str
    .replace(/[\r\n\s]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')

  const padLen = normalized.length % 4
  if (padLen === 1) {
    throw new Error('Invalid base64 length')
  }
  const padded = padLen === 0 ? normalized : normalized + '='.repeat(4 - padLen)

  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodeBase64Utf8(str: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    decodeBase64ToBytes(str),
  )
}

export function decodeBase64OrOriginal(str: string): string {
  try {
    const decoded = decodeBase64Utf8(str)
    // Heuristic: only accept "text-like" results to avoid accidentally decoding
    // non-base64 strings that happen to be decodable.
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i)
      if (code === 9 || code === 10 || code === 13) continue
      if (code < 32 || code === 127) {
        return str
      }
    }
    return decoded
  } catch {
    return str
  }
}

export function applyWsEarlyData(
  wsOpts: WsOptions,
  rawPath: string | undefined,
  headerName?: string,
): void {
  if (!rawPath) return
  const [cleanPath, rawQuery] = splitOnce(rawPath, '?')
  if (rawQuery) {
    const pathQuery = parseQueryString(rawQuery)
    const ed = parseInteger(pathQuery.ed)
    if (ed !== undefined && ed > 0) {
      wsOpts['max-early-data'] = ed
      wsOpts['early-data-header-name'] =
        getIfNotBlank(headerName ?? pathQuery.eh) ?? 'Sec-WebSocket-Protocol'
      const remaining = Object.entries(pathQuery).filter(([k]) => k !== 'ed')
      if (remaining.length === 0) {
        wsOpts.path = cleanPath || '/'
        return
      }
    }
  }
  wsOpts.path = rawPath
}

const CIPHER_ALIASES: Record<string, CipherType> = {
  'chacha20-poly1305': 'chacha20-ietf-poly1305',
}

const KNOWN_CIPHERS = new Set<CipherType>([
  'none',
  'auto',
  'dummy',
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'lea-128-gcm',
  'lea-192-gcm',
  'lea-256-gcm',
  'aes-128-gcm-siv',
  'aes-256-gcm-siv',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'chacha20',
  'chacha20-ietf',
  'chacha20-ietf-poly1305',
  '2022-blake3-chacha20-poly1305',
  'rabbit128-poly1305',
  'xchacha20-ietf-poly1305',
  'xchacha20',
  'aegis-128l',
  'aegis-256',
  'aez-384',
  'deoxys-ii-256-128',
  'rc4-md5',
])

export function getCipher(value: unknown): CipherType {
  if (value === undefined) return 'none'
  if (typeof value !== 'string') return 'auto'
  const aliased = CIPHER_ALIASES[value] ?? value
  return KNOWN_CIPHERS.has(aliased as CipherType)
    ? (aliased as CipherType)
    : 'auto'
}

export function firstString(value: any): string | undefined {
  if (value === null || value === undefined) return undefined
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    const first = value[0]
    return first === null || first === undefined ? undefined : String(first)
  }
  return String(value)
}
