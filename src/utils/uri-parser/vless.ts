import {
  applyWsEarlyData,
  decodeAndTrim,
  decodeBase64OrOriginal,
  getIfNotBlank,
  parseBool,
  parseBoolOrPresence,
  parseCommaList,
  parseEchParam,
  parseInsecureParam,
  parseInteger,
  parseJsonObjectSafe,
  parseQueryStringNormalized,
  parseRequiredPort,
  parseUrlLike,
  parseVlessFlow,
  safeDecodeURIComponent,
  stripUriScheme,
  trimStr,
} from './helpers'

function toXhttpRangeString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object' && !Array.isArray(value)) {
    const range = value as { from?: unknown; to?: unknown }
    if (range.from !== undefined && range.to !== undefined) {
      return `${range.from}-${range.to}`
    }
    if (range.from !== undefined) return String(range.from)
    if (range.to !== undefined) return String(range.to)
    return undefined
  }
  const str = String(value).trim()
  return str === '' ? undefined : str
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && v !== null) {
      out[k] = String(v)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function toOptionalBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  return parseBool(String(value))
}

function parseReuseSettings(raw: unknown): XHttpReuseSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const src = raw as Record<string, unknown>
  const out: XHttpReuseSettings = {}

  const maxConcurrency = toXhttpRangeString(
    src.maxConcurrency ?? src['max-concurrency'],
  )
  const maxConnections = toXhttpRangeString(
    src.maxConnections ?? src['max-connections'],
  )
  const cMaxReuse = toXhttpRangeString(
    src.cMaxReuseTimes ?? src['c-max-reuse-times'],
  )
  const hMaxReq = toXhttpRangeString(
    src.hMaxRequestTimes ?? src['h-max-request-times'],
  )
  const hMaxSecs = toXhttpRangeString(
    src.hMaxReusableSecs ?? src['h-max-reusable-secs'],
  )
  const hKeepAlive = parseInteger(
    src.hKeepAlivePeriod !== undefined
      ? String(src.hKeepAlivePeriod)
      : src['h-keep-alive-period'] !== undefined
        ? String(src['h-keep-alive-period'])
        : undefined,
  )

  if (maxConcurrency !== undefined) out['max-concurrency'] = maxConcurrency
  if (maxConnections !== undefined) out['max-connections'] = maxConnections
  if (cMaxReuse !== undefined) out['c-max-reuse-times'] = cMaxReuse
  if (hMaxReq !== undefined) out['h-max-request-times'] = hMaxReq
  if (hMaxSecs !== undefined) out['h-max-reusable-secs'] = hMaxSecs
  if (hKeepAlive !== undefined) out['h-keep-alive-period'] = hKeepAlive

  return Object.keys(out).length > 0 ? out : undefined
}

function applyXhttpCommonFields(
  target: XHttpOptions | XHttpDownloadSettings,
  src: Record<string, unknown>,
  fallbackParams?: Record<string, string | undefined>,
  isDownloadSettings = false,
): void {
  const pathVal = getIfNotBlank(
    typeof src.path === 'string' ? src.path : fallbackParams?.path,
  )
  const hostVal = getIfNotBlank(
    typeof src.host === 'string'
      ? src.host
      : (fallbackParams?.host ?? fallbackParams?.obfsParam),
  )
  if (hostVal) target.host = hostVal
  if (pathVal) target.path = pathVal

  if (!isDownloadSettings) {
    const modeVal = getIfNotBlank(
      typeof src.mode === 'string' ? src.mode : fallbackParams?.mode,
    )
    if (modeVal) (target as XHttpOptions).mode = modeVal
  }

  const headersObj =
    toStringRecord(src.headers) ??
    toStringRecord(parseJsonObjectSafe(fallbackParams?.headers))
  if (headersObj) target.headers = headersObj

  const noGrpc = toOptionalBool(
    src.noGRPCHeader ??
      src['no-grpc-header'] ??
      fallbackParams?.noGRPCHeader ??
      fallbackParams?.['no-grpc-header'],
  )
  if (noGrpc !== undefined) target['no-grpc-header'] = noGrpc

  const noSse = toOptionalBool(
    src.noSSEHeader ??
      src['no-sse-header'] ??
      fallbackParams?.noSSEHeader ??
      fallbackParams?.['no-sse-header'],
  )
  if (noSse !== undefined) target['no-sse-header'] = noSse

  const rangeMap: Array<[string[], keyof XHttpOptions]> = [
    [['xPaddingBytes', 'x-padding-bytes'], 'x-padding-bytes'],
    [['xPaddingKey', 'x-padding-key'], 'x-padding-key'],
    [['xPaddingHeader', 'x-padding-header'], 'x-padding-header'],
    [['xPaddingPlacement', 'x-padding-placement'], 'x-padding-placement'],
    [['xPaddingMethod', 'x-padding-method'], 'x-padding-method'],
    [['uplinkHTTPMethod', 'uplink-http-method'], 'uplink-http-method'],
    [['sessionPlacement', 'session-placement'], 'session-placement'],
    [['sessionKey', 'session-key'], 'session-key'],
    [['seqPlacement', 'seq-placement'], 'seq-placement'],
    [['seqKey', 'seq-key'], 'seq-key'],
    [['uplinkDataPlacement', 'uplink-data-placement'], 'uplink-data-placement'],
    [['uplinkDataKey', 'uplink-data-key'], 'uplink-data-key'],
    [['uplinkChunkSize', 'uplink-chunk-size'], 'uplink-chunk-size'],
    [
      ['scMaxEachPostBytes', 'sc-max-each-post-bytes'],
      'sc-max-each-post-bytes',
    ],
    [
      ['scMinPostsIntervalMs', 'sc-min-posts-interval-ms'],
      'sc-min-posts-interval-ms',
    ],
    [['scMaxBufferedPosts', 'sc-max-buffered-posts'], 'sc-max-buffered-posts'],
    [
      ['scStreamUpServerSecs', 'sc-stream-up-server-secs'],
      'sc-stream-up-server-secs',
    ],
  ]

  for (const [keys, targetKey] of rangeMap) {
    if (
      isDownloadSettings &&
      (targetKey === 'sc-max-buffered-posts' ||
        targetKey === 'sc-stream-up-server-secs')
    ) {
      continue
    }
    const raw =
      keys.map((k) => src[k]).find((v) => v !== undefined) ??
      keys.map((k) => fallbackParams?.[k]).find((v) => v !== undefined)
    const strVal = toXhttpRangeString(raw)
    if (strVal !== undefined) {
      ;(target as Record<string, unknown>)[targetKey] = strVal
    }
  }

  if (!isDownloadSettings) {
    const sessionTable = toXhttpRangeString(
      src.sessionTable ??
        src['session-table'] ??
        fallbackParams?.sessionTable ??
        fallbackParams?.['session-table'],
    )
    if (sessionTable) (target as XHttpOptions)['session-table'] = sessionTable
    const sessionLength = toXhttpRangeString(
      src.sessionLength ??
        src['session-length'] ??
        fallbackParams?.sessionLength ??
        fallbackParams?.['session-length'],
    )
    if (sessionLength) {
      ;(target as XHttpOptions)['session-length'] = sessionLength
    }
  }

  const paddingObfs = toOptionalBool(
    src.xPaddingObfsMode ??
      src['x-padding-obfs-mode'] ??
      fallbackParams?.xPaddingObfsMode ??
      fallbackParams?.['x-padding-obfs-mode'],
  )
  if (paddingObfs !== undefined) target['x-padding-obfs-mode'] = paddingObfs

  const rawReuse =
    src.xmux ??
    src['reuse-settings'] ??
    parseJsonObjectSafe(
      fallbackParams?.xmux ?? fallbackParams?.['reuse-settings'],
    )
  const reuse = parseReuseSettings(rawReuse)
  if (reuse) target['reuse-settings'] = reuse
}

function buildXhttpDownloadSettings(
  raw: unknown,
): XHttpDownloadSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const ds = raw as Record<string, unknown>
  const out: XHttpDownloadSettings = {}

  const server = getIfNotBlank(
    typeof ds.server === 'string'
      ? ds.server
      : typeof ds.address === 'string'
        ? ds.address
        : undefined,
  )
  if (server) out.server = server

  const port = parseInteger(ds.port !== undefined ? String(ds.port) : undefined)
  if (port !== undefined && port >= 1 && port <= 65535) {
    out.port = port
  }

  const security = typeof ds.security === 'string' ? ds.security : undefined
  const tlsFlag = toOptionalBool(ds.tls)
  if (tlsFlag !== undefined) {
    out.tls = tlsFlag
  } else if (security === 'tls' || security === 'reality') {
    out.tls = true
  }

  const tlsSettings =
    (ds.tlsSettings && typeof ds.tlsSettings === 'object'
      ? (ds.tlsSettings as Record<string, unknown>)
      : undefined) ?? {}
  const realitySettings =
    (ds.realitySettings && typeof ds.realitySettings === 'object'
      ? (ds.realitySettings as Record<string, unknown>)
      : undefined) ?? {}

  const servername = getIfNotBlank(
    (ds.servername ??
      ds.sni ??
      tlsSettings.serverName ??
      realitySettings.serverName) as string | undefined,
  )
  if (servername) out.servername = servername

  const rawAlpn = ds.alpn ?? tlsSettings.alpn
  if (Array.isArray(rawAlpn)) {
    const alpnList = rawAlpn.map((a) => String(a).trim()).filter(Boolean)
    if (alpnList.length > 0) out.alpn = alpnList
  } else if (typeof rawAlpn === 'string') {
    const alpnList = parseCommaList(rawAlpn)
    if (alpnList) out.alpn = alpnList
  }

  const skipCert = toOptionalBool(
    ds['skip-cert-verify'] ?? ds.allowInsecure ?? tlsSettings.allowInsecure,
  )
  if (skipCert !== undefined) out['skip-cert-verify'] = skipCert

  const clientFp = getIfNotBlank(
    (ds['client-fingerprint'] ??
      ds.fp ??
      tlsSettings.fingerprint ??
      realitySettings.fingerprint) as string | undefined,
  )
  if (clientFp) out['client-fingerprint'] = clientFp as ClientFingerprint

  const certFp = getIfNotBlank(
    (ds.fingerprint ??
      (Array.isArray(tlsSettings.pinnedPeerCertificateChainSha256)
        ? tlsSettings.pinnedPeerCertificateChainSha256[0]
        : undefined)) as string | undefined,
  )
  if (certFp) out.fingerprint = certFp

  if (ds['ech-opts'] && typeof ds['ech-opts'] === 'object') {
    out['ech-opts'] = ds['ech-opts'] as EchOptions
  } else if (typeof tlsSettings.echConfigList === 'string') {
    const ech = parseEchParam(tlsSettings.echConfigList)
    if (ech) out['ech-opts'] = ech
  }

  const rawReality =
    ds['reality-opts'] && typeof ds['reality-opts'] === 'object'
      ? (ds['reality-opts'] as Record<string, unknown>)
      : realitySettings
  const pubKey = getIfNotBlank(
    (rawReality['public-key'] ?? rawReality.publicKey) as string | undefined,
  )
  const shortId = getIfNotBlank(
    (rawReality['short-id'] ?? rawReality.shortId) as string | undefined,
  )
  const mlkem = toOptionalBool(
    rawReality['support-x25519mlkem768'] ?? rawReality.supportX25519mlkem768,
  )
  if (pubKey || shortId || mlkem !== undefined) {
    out['reality-opts'] = {
      ...(pubKey ? { 'public-key': pubKey } : {}),
      ...(shortId ? { 'short-id': shortId } : {}),
      ...(mlkem !== undefined ? { 'support-x25519mlkem768': mlkem } : {}),
    }
  }

  const nestedXhttp =
    ds.xhttpSettings && typeof ds.xhttpSettings === 'object'
      ? { ...ds, ...(ds.xhttpSettings as Record<string, unknown>) }
      : ds
  applyXhttpCommonFields(out, nestedXhttp, undefined, true)

  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * VLess URL Decode.
 */
export function URI_VLESS(line: string): IProxyVlessConfig {
  const afterScheme = stripUriScheme(line, 'vless', 'Invalid vless uri')
  if (!afterScheme) {
    throw new Error('Invalid vless uri')
  }

  let rest = afterScheme
  let isShadowrocket = false

  const parseVlessRest = (
    input: string,
  ): {
    uuidRaw: string
    server: string
    port: number
    addons?: string
    nameRaw?: string
  } => {
    const parsed = parseUrlLike(input, {
      requireAuth: true,
      errorMessage: 'Invalid vless uri',
    })
    if (!parsed.port) {
      throw new Error('Invalid vless uri: missing port')
    }
    const port = parseRequiredPort(
      parsed.port,
      'Invalid vless uri: invalid port',
    )
    return {
      uuidRaw: parsed.auth,
      server: parsed.host,
      port,
      addons: parsed.query,
      nameRaw: parsed.fragment,
    }
  }

  let parsed: ReturnType<typeof parseVlessRest>
  try {
    parsed = parseVlessRest(rest)
  } catch {
    const shadowMatch = /^(.*?)(\?.*?$)/.exec(rest)
    if (!shadowMatch) {
      throw new Error('Invalid vless uri')
    }
    const [, base64Part, other] = shadowMatch
    rest = `${decodeBase64OrOriginal(base64Part)}${other}`
    parsed = parseVlessRest(rest)
    isShadowrocket = true
  }

  const { uuidRaw, server, port, addons = '', nameRaw } = parsed

  let uuid = uuidRaw
  if (isShadowrocket) {
    uuid = uuid.replace(/^.*?:/g, '')
  }
  uuid = safeDecodeURIComponent(uuid) ?? uuid

  const params = parseQueryStringNormalized(addons)
  const name =
    decodeAndTrim(nameRaw) ??
    trimStr(params.remarks) ??
    trimStr(params.remark) ??
    `VLESS ${server}:${port}`

  const proxy: IProxyVlessConfig = {
    type: 'vless',
    name,
    server,
    port,
    uuid,
  }

  proxy.encryption = params.encryption === 'none' ? '' : params.encryption

  proxy.tls = (params.security && params.security !== 'none') || undefined
  if (isShadowrocket && parseBool(params.tls) === true) {
    proxy.tls = true
    params.security = params.security ?? 'reality'
  }

  proxy.servername = params.sni || params.peer
  proxy.flow = parseVlessFlow(params.flow)

  if (Object.prototype.hasOwnProperty.call(params, 'udp')) {
    proxy.udp = parseBoolOrPresence(params.udp)
  }
  if (Object.prototype.hasOwnProperty.call(params, 'xudp')) {
    proxy.xudp = parseBoolOrPresence(params.xudp)
  }
  const packetAddr = params['packet-addr'] ?? params.packetAddr
  if (packetAddr !== undefined) {
    proxy['packet-addr'] = parseBoolOrPresence(packetAddr)
  }
  const packetEncoding = getIfNotBlank(
    params['packet-encoding'] ?? params.packetEncoding,
  )
  if (packetEncoding) {
    proxy['packet-encoding'] = packetEncoding
  }

  const clientFp = getIfNotBlank(params.fp ?? params['client-fingerprint'])
  if (clientFp) {
    proxy['client-fingerprint'] = clientFp as ClientFingerprint
  }
  const certFp = getIfNotBlank(
    params.fingerprint ?? params.hpkp ?? params.pinSHA256,
  )
  if (certFp) {
    proxy.fingerprint = certFp
  }
  proxy.alpn = parseCommaList(params.alpn)

  const insecure = parseInsecureParam(params)
  if (insecure !== undefined) {
    proxy['skip-cert-verify'] = insecure
  }

  const echOpts = parseEchParam(
    params.ech ?? params['ech-config'],
    params['ech-query-server-name'] ?? params.echQueryServerName,
  )
  if (echOpts) {
    proxy['ech-opts'] = echOpts
  }

  if (params.security === 'reality' || (!params.security && params.pbk)) {
    const opts: IProxyVlessConfig['reality-opts'] = {}
    if (params.pbk) {
      opts['public-key'] = params.pbk
    }
    if (params.sid) {
      opts['short-id'] = params.sid
    }
    const mlkem = parseBool(
      params['support-x25519mlkem768'] ?? params.supportX25519mlkem768,
    )
    if (mlkem !== undefined) {
      opts['support-x25519mlkem768'] = mlkem
    }
    if (params.pqv || params.mldsa65) {
      console.warn(
        '[URI_VLESS] Ignoring unsupported REALITY verification parameter (pqv/mldsa65) for Mihomo compatibility',
      )
    }
    if (Object.keys(opts).length > 0) {
      proxy['reality-opts'] = opts
    }
  }

  let httpupgrade =
    parseBool(params['v2ray-http-upgrade'] ?? params.httpupgrade) ?? false
  let network: NetworkType

  if (params.headerType === 'http') {
    network = 'http'
  } else {
    let type = params.type
    if (type === 'websocket') type = 'ws'
    if (isShadowrocket && type === 'sw') type = 'ws'
    if (type === 'splithttp') type = 'xhttp'
    if (type === 'httpupgrade') {
      network = 'ws'
      httpupgrade = true
    } else if (
      type &&
      ['tcp', 'ws', 'http', 'grpc', 'h2', 'xhttp'].includes(type)
    ) {
      network = type as NetworkType
    } else {
      network = 'tcp'
    }
  }

  proxy.network = network

  if (proxy.network && !['tcp', 'none'].includes(proxy.network)) {
    const host = params.host ?? params.obfsParam
    const path = params.path

    switch (proxy.network) {
      case 'grpc':
        {
          const serviceName = getIfNotBlank(path ?? params.serviceName)
          if (serviceName) {
            proxy['grpc-opts'] = { 'grpc-service-name': serviceName }
          }
        }
        break
      case 'h2': {
        const h2Opts: H2Options = {}
        const hostList = parseCommaList(getIfNotBlank(host))
        const pathVal = getIfNotBlank(path)
        if (hostList) {
          h2Opts.host = hostList.length === 1 ? hostList[0] : hostList
        }
        if (pathVal) h2Opts.path = pathVal
        if (Object.keys(h2Opts).length > 0) {
          proxy['h2-opts'] = h2Opts
        }
        break
      }
      case 'http': {
        const httpOpts: HttpOptions = {}
        const hostVal = getIfNotBlank(host)
        const pathVal = getIfNotBlank(path)
        if (pathVal) httpOpts.path = [pathVal]
        if (hostVal) httpOpts.headers = { Host: [hostVal] }
        if (Object.keys(httpOpts).length > 0) {
          proxy['http-opts'] = httpOpts
        }
        break
      }
      case 'ws': {
        const wsOpts: WsOptions = {}
        if (host) {
          if (params.obfsParam) {
            const parsedHeaders = parseJsonObjectSafe(host)
            if (parsedHeaders) {
              wsOpts.headers = toStringRecord(parsedHeaders)
            } else {
              wsOpts.headers = { Host: host }
            }
          } else {
            wsOpts.headers = { Host: host }
          }
        }
        applyWsEarlyData(wsOpts, path, params.eh)
        if (httpupgrade) {
          wsOpts['v2ray-http-upgrade'] = true
          wsOpts['v2ray-http-upgrade-fast-open'] = true
        }
        if (Object.keys(wsOpts).length > 0) {
          proxy['ws-opts'] = wsOpts
        }
        break
      }
      case 'xhttp': {
        const xhttpOpts: XHttpOptions = {}
        const extraObj = parseJsonObjectSafe(params.extra) ?? {}
        applyXhttpCommonFields(xhttpOpts, extraObj, params, false)

        const downloadSettings = buildXhttpDownloadSettings(
          extraObj.downloadSettings ??
            extraObj['download-settings'] ??
            parseJsonObjectSafe(
              params.downloadSettings ?? params['download-settings'],
            ),
        )
        if (downloadSettings) {
          xhttpOpts['download-settings'] = downloadSettings
        }

        if (Object.keys(xhttpOpts).length > 0) {
          proxy['xhttp-opts'] = xhttpOpts
        }
        break
      }
      default:
        break
    }
  }

  if (proxy.tls && !proxy.servername) {
    if (proxy.network === 'ws') {
      proxy.servername = proxy['ws-opts']?.headers?.Host
    } else if (proxy.network === 'http') {
      proxy.servername = proxy['http-opts']?.headers?.Host?.[0]
    } else if (proxy.network === 'h2') {
      const h2Host = proxy['h2-opts']?.host
      proxy.servername = Array.isArray(h2Host) ? h2Host[0] : h2Host
    } else if (proxy.network === 'xhttp') {
      proxy.servername = proxy['xhttp-opts']?.host
    }
  }

  return proxy
}
