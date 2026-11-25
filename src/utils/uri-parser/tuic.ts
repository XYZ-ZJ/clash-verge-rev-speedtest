import {
  decodeAndTrim,
  getIfNotBlank,
  parseBoolOrPresence,
  parseCommaList,
  parseEchParam,
  parseInsecureParam,
  parseInteger,
  parsePortOrDefault,
  parseQueryStringNormalized,
  parseUrlLike,
  safeDecodeURIComponent,
  splitOnce,
  stripUriScheme,
} from './helpers'

export function URI_TUIC(line: string): IProxyTuicConfig {
  const afterScheme = stripUriScheme(line, 'tuic', 'Invalid tuic uri')
  if (!afterScheme) {
    throw new Error('Invalid tuic uri')
  }
  const {
    auth,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, {
    requireAuth: true,
    errorMessage: 'Invalid tuic uri',
  })

  const portNum = parsePortOrDefault(port, 443)
  const decodedName = decodeAndTrim(nameRaw)
  const name = decodedName ?? `TUIC ${server}:${portNum}`

  const proxy: IProxyTuicConfig = {
    type: 'tuic',
    name,
    server,
    port: portNum,
  }

  const [authLeft, authRight] = splitOnce(auth, ':')
  if (authRight === undefined) {
    // TUIC v4 uses `tuic://token@host:port` without a colon-separated uuid:password.
    proxy.token = safeDecodeURIComponent(authLeft) ?? authLeft
  } else {
    proxy.uuid = safeDecodeURIComponent(authLeft) ?? authLeft
    proxy.password = safeDecodeURIComponent(authRight) ?? authRight
  }

  const params = parseQueryStringNormalized(addons)
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'token':
        if (value) proxy.token = value
        break
      case 'ip':
        if (value) proxy.ip = value
        break
      case 'heartbeat-interval':
        proxy['heartbeat-interval'] = parseInteger(value)
        break
      case 'alpn':
        proxy.alpn = parseCommaList(value)
        break
      case 'disable-sni':
        proxy['disable-sni'] = parseBoolOrPresence(value)
        break
      case 'reduce-rtt':
        proxy['reduce-rtt'] = parseBoolOrPresence(value)
        break
      case 'request-timeout':
        proxy['request-timeout'] = parseInteger(value)
        break
      case 'udp-relay-mode':
        if (value) proxy['udp-relay-mode'] = value
        break
      case 'congestion-controller':
        if (value) proxy['congestion-controller'] = value
        break
      case 'max-udp-relay-packet-size':
        proxy['max-udp-relay-packet-size'] = parseInteger(value)
        break
      case 'fast-open':
        proxy['fast-open'] = parseBoolOrPresence(value)
        break
      case 'max-open-streams':
        proxy['max-open-streams'] = parseInteger(value)
        break
      case 'sni':
        if (value) proxy.sni = value
        break
      case 'fingerprint':
      case 'pinSHA256':
      case 'hpkp':
        if (value) proxy.fingerprint = value
        break
      case 'ca':
        if (value) proxy.ca = value
        break
      case 'ca-str':
        if (value) proxy['ca-str'] = value
        break
      case 'udp-over-stream':
        proxy['udp-over-stream'] = parseBoolOrPresence(value)
        break
      case 'udp-over-stream-version':
        proxy['udp-over-stream-version'] = parseInteger(value)
        break
      default:
        break
    }
  }

  const insecure = parseInsecureParam(params)
  if (insecure !== undefined) {
    proxy['skip-cert-verify'] = insecure
  }

  const echOpts = parseEchParam(
    getIfNotBlank(params.ech ?? params['ech-config']),
    params['ech-query-server-name'] ?? params.echQueryServerName,
  )
  if (echOpts) {
    proxy['ech-opts'] = echOpts
  }

  return proxy
}
