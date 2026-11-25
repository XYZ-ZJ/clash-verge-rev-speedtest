import {
  decodeAndTrim,
  getIfNotBlank,
  normalizeUriAndGetScheme,
  parseBoolOrPresence,
  parseCommaList,
  parseEchParam,
  parseInsecureParam,
  parseIpVersion,
  parsePortOrDefault,
  parseQueryStringNormalized,
  parseUrlLike,
  safeDecodeURIComponent,
  splitOnce,
  stripUriScheme,
} from './helpers'

export function URI_HTTP(line: string): IProxyHttpConfig {
  const { scheme } = normalizeUriAndGetScheme(line)
  const afterScheme = stripUriScheme(
    line,
    ['http', 'https'],
    'Invalid http uri',
  )
  if (!afterScheme) {
    throw new Error('Invalid http uri')
  }
  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, { errorMessage: 'Invalid http uri' })
  const isHttps = scheme === 'https'
  const portNum = parsePortOrDefault(port, isHttps ? 443 : 80)
  const auth = safeDecodeURIComponent(authRaw) ?? authRaw
  const decodedName = decodeAndTrim(nameRaw)

  const name = decodedName ?? `HTTP ${server}:${portNum}`
  const proxy: IProxyHttpConfig = {
    type: 'http',
    name,
    server,
    port: portNum,
    ...(isHttps ? { tls: true } : {}),
  }
  if (auth) {
    const [username, password] = splitOnce(auth, ':')
    proxy.username = username
    proxy.password = password
  }

  const params = parseQueryStringNormalized(addons)
  for (const [key, value] of Object.entries(params)) {
    switch (key) {
      case 'tls':
        proxy.tls = parseBoolOrPresence(value)
        break
      case 'sni':
      case 'peer':
        if (value) proxy.sni = value
        break
      case 'alpn':
        proxy.alpn = parseCommaList(value)
        break
      case 'fingerprint':
      case 'hpkp':
      case 'pinSHA256':
        if (value) proxy.fingerprint = value
        break
      case 'name-cert-verify':
        if (value) proxy['name-cert-verify'] = value
        break
      case 'ip-version':
        proxy['ip-version'] = parseIpVersion(value)
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
