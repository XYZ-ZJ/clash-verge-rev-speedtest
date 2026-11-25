import {
  decodeAndTrim,
  getIfNotBlank,
  parseBoolOrPresence,
  parseQueryStringNormalized,
  parseRequiredPort,
  parseUrlLike,
  safeDecodeURIComponent,
  splitOnce,
  stripUriScheme,
} from './helpers'

function normalizeMultiplexing(
  raw: string | undefined,
): MieruMultiplexing | undefined {
  const val = getIfNotBlank(raw)?.toUpperCase()
  if (!val) return undefined
  const prefixed = val.startsWith('MULTIPLEXING_') ? val : `MULTIPLEXING_${val}`
  if (
    prefixed === 'MULTIPLEXING_DEFAULT' ||
    prefixed === 'MULTIPLEXING_OFF' ||
    prefixed === 'MULTIPLEXING_LOW' ||
    prefixed === 'MULTIPLEXING_MIDDLE' ||
    prefixed === 'MULTIPLEXING_HIGH'
  ) {
    return prefixed
  }
  return undefined
}

function normalizeHandshakeMode(raw: string | undefined): string | undefined {
  const val = getIfNotBlank(raw)?.toUpperCase()
  if (!val) return undefined
  return val.startsWith('HANDSHAKE_') ? val : `HANDSHAKE_${val}`
}

export function URI_Mieru(line: string): IProxyMieruConfig {
  const afterScheme = stripUriScheme(
    line,
    ['mierus', 'mieru'],
    'Invalid mieru uri',
  )
  if (!afterScheme) {
    throw new Error('Invalid mieru uri')
  }

  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, {
    requireAuth: true,
    errorMessage: 'Invalid mieru uri',
  })

  if (!server) {
    throw new Error('Invalid mieru uri: missing server')
  }

  const params = parseQueryStringNormalized(addons)
  const portValue = getIfNotBlank(port ?? params.port ?? params['port-range'])
  if (!portValue) {
    throw new Error('Invalid mieru uri: missing port')
  }

  const isRange = portValue.includes('-')
  const decodedAuth = safeDecodeURIComponent(authRaw) ?? authRaw
  const [username, password] = splitOnce(decodedAuth, ':')
  if (!username || password === undefined) {
    throw new Error('Invalid mieru uri: missing credentials')
  }

  const displayPort = isRange
    ? portValue
    : String(parseRequiredPort(portValue, 'Invalid mieru uri: invalid port'))
  const name = decodeAndTrim(nameRaw) ?? `Mieru ${server}:${displayPort}`

  const proxy: IProxyMieruConfig = {
    type: 'mieru',
    name,
    server,
    username,
    password,
  }

  if (isRange) {
    proxy['port-range'] = portValue
  } else {
    proxy.port = parseRequiredPort(portValue, 'Invalid mieru uri: invalid port')
  }

  const transportRaw = getIfNotBlank(
    params.protocol ?? params.transport,
  )?.toUpperCase()
  if (transportRaw === 'UDP') {
    proxy.transport = 'UDP'
    proxy.udp = true
  } else if (transportRaw === 'TCP') {
    proxy.transport = 'TCP'
  }

  if (Object.prototype.hasOwnProperty.call(params, 'udp')) {
    proxy.udp = parseBoolOrPresence(params.udp)
  }

  const multiplexing = normalizeMultiplexing(params.multiplexing ?? params.mux)
  if (multiplexing) {
    proxy.multiplexing = multiplexing
  }

  const handshakeMode = normalizeHandshakeMode(params['handshake-mode'])
  if (handshakeMode) {
    proxy['handshake-mode'] = handshakeMode
  }

  const trafficPattern = getIfNotBlank(params['traffic-pattern'])
  if (trafficPattern) {
    proxy['traffic-pattern'] = trafficPattern
  }

  return proxy
}
