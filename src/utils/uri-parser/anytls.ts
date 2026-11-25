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

export function URI_AnyTLS(line: string): IProxyAnyTLSConfig {
  const afterScheme = stripUriScheme(line, 'anytls', 'Invalid anytls uri')
  if (!afterScheme) {
    throw new Error('Invalid anytls uri')
  }
  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, {
    errorMessage: 'Invalid anytls uri',
  })
  if (!server) {
    throw new Error('Invalid anytls uri')
  }
  const portNum = parsePortOrDefault(port, 443)
  const auth = safeDecodeURIComponent(authRaw) ?? authRaw
  const decodedName = decodeAndTrim(nameRaw)
  const name = decodedName ?? `AnyTLS ${server}:${portNum}`
  const proxy: IProxyAnyTLSConfig = {
    type: 'anytls',
    name,
    server,
    port: portNum,
    udp: true,
  }

  if (auth) {
    const [username, password] = splitOnce(auth, ':')
    proxy.password = password ?? username
  }

  const params = parseQueryStringNormalized(addons)
  if (params.sni) {
    proxy.sni = params.sni
  }
  const alpn = parseCommaList(params.alpn)
  if (alpn) {
    proxy.alpn = alpn
  }

  const fingerprint = getIfNotBlank(
    params.fingerprint ?? params.hpkp ?? params.pinSHA256,
  )
  if (fingerprint) {
    proxy.fingerprint = fingerprint
  }
  const clientFingerprint = getIfNotBlank(
    params['client-fingerprint'] ?? params.fp,
  )
  if (clientFingerprint) {
    proxy['client-fingerprint'] = clientFingerprint as ClientFingerprint
  }

  const nameCertVerify = getIfNotBlank(
    params['name-cert-verify'] ?? params.nameCertVerify,
  )
  if (nameCertVerify) {
    proxy['name-cert-verify'] = nameCertVerify
  }

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

  if (Object.prototype.hasOwnProperty.call(params, 'udp')) {
    proxy.udp = parseBoolOrPresence(params.udp)
  }
  if (Object.prototype.hasOwnProperty.call(params, 'disable-reuse')) {
    proxy['disable-reuse'] = parseBoolOrPresence(params['disable-reuse'])
  }

  const idleCheck = parseInteger(params['idle-session-check-interval'])
  if (idleCheck !== undefined) {
    proxy['idle-session-check-interval'] = idleCheck
  }
  const idleTimeout = parseInteger(params['idle-session-timeout'])
  if (idleTimeout !== undefined) {
    proxy['idle-session-timeout'] = idleTimeout
  }
  const minIdle = parseInteger(params['min-idle-session'])
  if (minIdle !== undefined) {
    proxy['min-idle-session'] = minIdle
  }

  return proxy
}
