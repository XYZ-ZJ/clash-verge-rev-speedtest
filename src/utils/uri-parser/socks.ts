import {
  decodeAndTrim,
  decodeBase64OrOriginal,
  getIfNotBlank,
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

export function URI_SOCKS(line: string): IProxySocks5Config {
  const afterScheme = stripUriScheme(
    line,
    ['socks5', 'socks'],
    'Invalid socks uri',
  )
  if (!afterScheme) {
    throw new Error('Invalid socks uri')
  }

  const [beforeHash, nameRaw] = splitOnce(afterScheme, '#')
  const [mainRaw, queryRaw] = splitOnce(beforeHash, '?')
  let normalizedMain = mainRaw
  if (!mainRaw.includes('@')) {
    const decoded = decodeBase64OrOriginal(mainRaw)
    if (decoded !== mainRaw) {
      normalizedMain = decoded
    }
  }
  const reconstructed =
    normalizedMain +
    (queryRaw !== undefined ? `?${queryRaw}` : '') +
    (nameRaw !== undefined ? `#${nameRaw}` : '')

  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: fragmentRaw,
  } = parseUrlLike(reconstructed, { errorMessage: 'Invalid socks uri' })
  const portNum = parsePortOrDefault(port, 1080)

  let auth = safeDecodeURIComponent(authRaw) ?? authRaw
  if (auth && !auth.includes(':')) {
    const decodedAuth = decodeBase64OrOriginal(auth)
    if (decodedAuth.includes(':')) {
      auth = decodedAuth
    }
  }
  const decodedName = decodeAndTrim(fragmentRaw)
  const name = decodedName ?? `SOCKS5 ${server}:${portNum}`
  const proxy: IProxySocks5Config = {
    type: 'socks5',
    name,
    server,
    port: portNum,
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
      case 'udp':
        proxy.udp = parseBoolOrPresence(value)
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
