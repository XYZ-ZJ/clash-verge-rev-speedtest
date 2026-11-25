import {
  decodeAndTrim,
  decodeBase64OrOriginal,
  getCipher,
  getIfNotBlank,
  getIfPresent,
  normalizeHost,
  parseBool,
  parseBoolOrPresence,
  parseCommaList,
  parseEchParam,
  parseInsecureParam,
  parseInteger,
  parseJsonObjectSafe,
  parseQueryStringNormalized,
  parseRequiredPort,
  splitOnce,
  stripUriScheme,
} from './helpers'

const KCPTUN_INT_KEYS = [
  'conn',
  'autoexpire',
  'scavengettl',
  'mtu',
  'ratelimit',
  'sndwnd',
  'rcvwnd',
  'datashard',
  'parityshard',
  'dscp',
  'nodelay',
  'interval',
  'resend',
  'nc',
  'sockbuf',
  'smuxver',
  'smuxbuf',
  'framesize',
  'streambuf',
  'keepalive',
] as const

const KCPTUN_BOOL_KEYS = ['nocomp', 'acknodelay'] as const

function parseHeadersOption(raw: unknown): Record<string, string> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') {
    const parsed = parseJsonObjectSafe(raw)
    if (!parsed) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== undefined && v !== null) out[k] = String(v)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined && v !== null) out[k] = String(v)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

function parsePluginBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  return parseBoolOrPresence(String(value))
}

export function URI_SS(line: string): IProxyShadowsocksConfig {
  const afterScheme = stripUriScheme(line, 'ss', 'Invalid ss uri')
  if (!afterScheme) {
    throw new Error('Invalid ss uri')
  }

  const [withoutHash, hashRaw] = splitOnce(afterScheme, '#')
  const nameFromHash = decodeAndTrim(hashRaw)

  const [mainRaw, queryRaw] = splitOnce(withoutHash, '?')
  const queryParams = parseQueryStringNormalized(queryRaw)

  const main = mainRaw.includes('@') ? mainRaw : decodeBase64OrOriginal(mainRaw)
  const atIdx = main.lastIndexOf('@')
  if (atIdx === -1) {
    throw new Error("Invalid ss uri: missing '@'")
  }

  const userInfoStr = decodeBase64OrOriginal(main.slice(0, atIdx))
  const serverAndPortWithPath = main.slice(atIdx + 1)
  const serverAndPort = serverAndPortWithPath.split('/')[0]

  const portIdx = serverAndPort.lastIndexOf(':')
  if (portIdx === -1) {
    throw new Error('Invalid ss uri: missing port')
  }
  const server = normalizeHost(serverAndPort.slice(0, portIdx))
  const portRaw = serverAndPort.slice(portIdx + 1)
  const port = parseRequiredPort(portRaw, 'Invalid ss uri: invalid port')

  const userInfo = userInfoStr.match(/(^.*?):(.*$)/)

  const proxy: IProxyShadowsocksConfig = {
    name: nameFromHash ?? `SS ${server}:${port}`,
    type: 'ss',
    server,
    port,
    cipher: getCipher(userInfo?.[1]),
    password: userInfo?.[2],
  }

  // plugin from `plugin=...`
  const pluginParam = queryParams.plugin
  if (pluginParam) {
    const pluginParts = pluginParam.split(';')
    const pluginName = pluginParts[0]?.trim()
    const pluginOptions: Record<string, any> = { plugin: pluginName }
    for (const raw of pluginParts.slice(1)) {
      if (!raw) continue
      const [key, val] = splitOnce(raw, '=')
      const normalizedKey = key.trim()
      if (!normalizedKey) continue
      pluginOptions[normalizedKey] =
        val === undefined || val === '' ? true : val
    }

    switch (pluginName) {
      case 'obfs-local':
      case 'simple-obfs':
        proxy.plugin = 'obfs'
        proxy['plugin-opts'] = {
          mode: getIfNotBlank(pluginOptions.obfs ?? pluginOptions.mode),
          host: getIfNotBlank(
            pluginOptions['obfs-host'] ?? pluginOptions.host,
          ),
        }
        break
      case 'v2ray-plugin': {
        proxy.plugin = 'v2ray-plugin'
        const opts: NonNullable<IProxyShadowsocksConfig['plugin-opts']> = {
          mode: getIfNotBlank(pluginOptions.mode) ?? 'websocket',
          host: getIfNotBlank(pluginOptions['obfs-host'] ?? pluginOptions.host),
          path: getIfNotBlank(pluginOptions.path),
          tls: getIfPresent(pluginOptions.tls),
        }
        const skipCert = parsePluginBool(
          pluginOptions['skip-cert-verify'] ??
            pluginOptions.allowInsecure ??
            pluginOptions.insecure,
        )
        if (skipCert !== undefined) opts['skip-cert-verify'] = skipCert
        const fp = getIfNotBlank(pluginOptions.fingerprint ?? pluginOptions.hpkp)
        if (fp) opts.fingerprint = fp
        const mux = parsePluginBool(pluginOptions.mux)
        if (mux !== undefined) opts.mux = mux
        const httpUpgrade = parsePluginBool(
          pluginOptions['v2ray-http-upgrade'] ?? pluginOptions.httpupgrade,
        )
        if (httpUpgrade !== undefined) {
          opts['v2ray-http-upgrade'] = httpUpgrade
          opts['v2ray-http-upgrade-fast-open'] =
            parsePluginBool(pluginOptions['v2ray-http-upgrade-fast-open']) ??
            httpUpgrade
        }
        const headers = parseHeadersOption(pluginOptions.headers)
        if (headers) opts.headers = headers
        const ech = parseEchParam(pluginOptions.ech)
        if (ech) opts['ech-opts'] = ech
        proxy['plugin-opts'] = opts
        break
      }
      case 'shadow-tls': {
        proxy.plugin = 'shadow-tls'
        const opts: NonNullable<IProxyShadowsocksConfig['plugin-opts']> = {}
        const ver = parseInteger(
          pluginOptions.version !== undefined
            ? String(pluginOptions.version)
            : undefined,
        )
        if (ver !== undefined) opts.version = ver
        const password = getIfNotBlank(pluginOptions.password)
        if (password) opts.password = password
        const host = getIfNotBlank(pluginOptions.host ?? pluginOptions.sni)
        if (host) opts.host = host
        const fp = getIfNotBlank(pluginOptions.fingerprint)
        if (fp) opts.fingerprint = fp
        const skipCert = parsePluginBool(
          pluginOptions['skip-cert-verify'] ??
            pluginOptions.allowInsecure ??
            pluginOptions.insecure,
        )
        if (skipCert !== undefined) opts['skip-cert-verify'] = skipCert
        const alpn = parseCommaList(pluginOptions.alpn)
        if (alpn) opts.alpn = alpn
        proxy['plugin-opts'] = opts
        break
      }
      case 'restls': {
        proxy.plugin = 'restls'
        const opts: NonNullable<IProxyShadowsocksConfig['plugin-opts']> = {}
        const password = getIfNotBlank(pluginOptions.password)
        if (password) opts.password = password
        const host = getIfNotBlank(pluginOptions.host ?? pluginOptions.sni)
        if (host) opts.host = host
        const versionHint = getIfNotBlank(
          pluginOptions['version-hint'] ?? pluginOptions.versionHint,
        )
        if (versionHint) opts['version-hint'] = versionHint
        const restlsScript = getIfNotBlank(
          pluginOptions['restls-script'] ?? pluginOptions.restlsScript,
        )
        if (restlsScript) opts['restls-script'] = restlsScript
        proxy['plugin-opts'] = opts
        break
      }
      case 'gost-plugin': {
        proxy.plugin = 'gost-plugin'
        const opts: NonNullable<IProxyShadowsocksConfig['plugin-opts']> = {
          mode: getIfNotBlank(pluginOptions.mode) ?? 'websocket',
        }
        const host = getIfNotBlank(pluginOptions.host)
        if (host) opts.host = host
        const path = getIfNotBlank(pluginOptions.path)
        if (path) opts.path = path
        if (pluginOptions.tls !== undefined) {
          opts.tls = getIfPresent(pluginOptions.tls)
        }
        const fp = getIfNotBlank(pluginOptions.fingerprint)
        if (fp) opts.fingerprint = fp
        const skipCert = parsePluginBool(
          pluginOptions['skip-cert-verify'] ??
            pluginOptions.allowInsecure ??
            pluginOptions.insecure,
        )
        if (skipCert !== undefined) opts['skip-cert-verify'] = skipCert
        const mux = parsePluginBool(pluginOptions.mux)
        if (mux !== undefined) opts.mux = mux
        const headers = parseHeadersOption(pluginOptions.headers)
        if (headers) opts.headers = headers
        proxy['plugin-opts'] = opts
        break
      }
      case 'kcptun': {
        proxy.plugin = 'kcptun'
        const opts: NonNullable<IProxyShadowsocksConfig['plugin-opts']> = {}
        const key = getIfNotBlank(pluginOptions.key)
        if (key) opts.key = key
        const crypt = getIfNotBlank(pluginOptions.crypt)
        if (crypt) opts.crypt = crypt
        const mode = getIfNotBlank(pluginOptions.mode)
        if (mode) opts.mode = mode
        for (const k of KCPTUN_INT_KEYS) {
          const val = parseInteger(
            pluginOptions[k] !== undefined
              ? String(pluginOptions[k])
              : undefined,
          )
          if (val !== undefined) opts[k] = val
        }
        for (const k of KCPTUN_BOOL_KEYS) {
          const val = parsePluginBool(pluginOptions[k])
          if (val !== undefined) opts[k] = val
        }
        proxy['plugin-opts'] = opts
        break
      }
      case 'jls': {
        proxy.plugin = 'jls'
        const opts: NonNullable<IProxyShadowsocksConfig['plugin-opts']> = {}
        const host = getIfNotBlank(pluginOptions.host)
        if (host) opts.host = host
        const username = getIfNotBlank(pluginOptions.username)
        if (username) opts.username = username
        const password = getIfNotBlank(pluginOptions.password)
        if (password) opts.password = password
        const alpn = parseCommaList(pluginOptions.alpn)
        if (alpn) opts.alpn = alpn
        proxy['plugin-opts'] = opts
        break
      }
      default:
        console.warn(`[URI_SS] Unsupported plugin option: ${pluginName}`)
        break
    }
  }

  // plugin from `v2ray-plugin=...` (base64 JSON)
  const v2rayPluginParam = queryParams['v2ray-plugin']
  if (!proxy.plugin && v2rayPluginParam) {
    proxy.plugin = 'v2ray-plugin'
    try {
      proxy['plugin-opts'] = JSON.parse(
        decodeBase64OrOriginal(v2rayPluginParam),
      )
    } catch (e) {
      console.warn('[URI_SS] v2ray-plugin JSON.parse failed:', e)
      proxy['plugin-opts'] = {}
    }
  }

  const uotRaw = queryParams.uot ?? queryParams['udp-over-tcp']
  if (uotRaw !== undefined) {
    const uotVer = parseInteger(uotRaw)
    if (uotVer === 1 || uotVer === 2) {
      proxy['udp-over-tcp'] = true
      proxy['udp-over-tcp-version'] = uotVer
    } else if (parseBoolOrPresence(uotRaw)) {
      proxy['udp-over-tcp'] = true
    }
  }
  const explicitUotVersion = parseInteger(
    queryParams['udp-over-tcp-version'] ?? queryParams['uot-version'],
  )
  if (explicitUotVersion === 1 || explicitUotVersion === 2) {
    proxy['udp-over-tcp'] = true
    proxy['udp-over-tcp-version'] = explicitUotVersion
  }

  const clientFp = getIfNotBlank(
    queryParams['client-fingerprint'] ?? queryParams.fp,
  )
  if (clientFp) {
    proxy['client-fingerprint'] = clientFp as ClientFingerprint
  }

  if (Object.prototype.hasOwnProperty.call(queryParams, 'udp')) {
    proxy.udp = parseBoolOrPresence(queryParams.udp)
  }
  if (
    Object.prototype.hasOwnProperty.call(queryParams, 'tfo') &&
    parseBoolOrPresence(queryParams.tfo)
  ) {
    proxy.tfo = true
  }

  // Apply top-level insecure override if plugin-opts uses TLS
  const insecure = parseInsecureParam(queryParams)
  if (
    insecure !== undefined &&
    proxy['plugin-opts'] &&
    (proxy.plugin === 'v2ray-plugin' ||
      proxy.plugin === 'shadow-tls' ||
      proxy.plugin === 'gost-plugin')
  ) {
    proxy['plugin-opts']['skip-cert-verify'] =
      proxy['plugin-opts']['skip-cert-verify'] ??
      (parseBool(String(insecure)) ?? insecure)
  }

  return proxy
}
