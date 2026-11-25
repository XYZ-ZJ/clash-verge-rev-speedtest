import {
  applyWsEarlyData,
  decodeAndTrim,
  getIfNotBlank,
  parseBool,
  parseBoolOrPresence,
  parseCommaList,
  parseEchParam,
  parseInsecureParam,
  parsePortOrDefault,
  parseQueryStringNormalized,
  parseUrlLike,
  safeDecodeURIComponent,
  stripUriScheme,
} from './helpers'

export function URI_Trojan(line: string): IProxyTrojanConfig {
  const afterScheme = stripUriScheme(line, 'trojan', 'Invalid trojan uri')
  if (!afterScheme) {
    throw new Error('Invalid trojan uri')
  }
  const {
    auth: passwordRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, {
    requireAuth: true,
    errorMessage: 'Invalid trojan uri',
  })
  const portNum = parsePortOrDefault(port, 443)
  const password = safeDecodeURIComponent(passwordRaw) ?? passwordRaw
  const name = decodeAndTrim(nameRaw) ?? `Trojan ${server}:${portNum}`
  const proxy: IProxyTrojanConfig = {
    type: 'trojan',
    name,
    server,
    port: portNum,
    password,
  }

  const params = parseQueryStringNormalized(addons)

  let httpupgrade =
    parseBool(params['v2ray-http-upgrade'] ?? params.httpupgrade) ?? false
  let networkRaw = params.type
  if (networkRaw === 'websocket') networkRaw = 'ws'
  if (networkRaw === 'httpupgrade') {
    proxy.network = 'ws'
    httpupgrade = true
  } else if (
    networkRaw &&
    ['ws', 'grpc', 'h2', 'http', 'tcp'].includes(networkRaw)
  ) {
    proxy.network = networkRaw as NetworkType
  }

  const host = getIfNotBlank(params.host)
  const path = getIfNotBlank(params.path)

  const alpn = parseCommaList(params.alpn)
  if (alpn) {
    proxy.alpn = alpn
  }
  const sni = getIfNotBlank(params.sni ?? params.peer)
  if (sni) {
    proxy.sni = sni
  }
  if (Object.prototype.hasOwnProperty.call(params, 'udp')) {
    proxy.udp = parseBoolOrPresence(params.udp)
  }

  const insecure = parseInsecureParam(params)
  if (insecure !== undefined) {
    proxy['skip-cert-verify'] = insecure
  }

  const certFingerprint = getIfNotBlank(
    params.fingerprint ?? params.hpkp ?? params.pinSHA256,
  )
  if (certFingerprint) {
    proxy.fingerprint = certFingerprint
  }

  const clientFingerprint = getIfNotBlank(
    params['client-fingerprint'] ?? params.fp,
  )
  if (clientFingerprint) {
    proxy['client-fingerprint'] = clientFingerprint as ClientFingerprint
  }

  const echOpts = parseEchParam(
    params.ech ?? params['ech-config'],
    params['ech-query-server-name'] ?? params.echQueryServerName,
  )
  if (echOpts) {
    proxy['ech-opts'] = echOpts
  }

  if (params.security === 'reality' || params.pbk) {
    const realityOpts: RealityOptions = {}
    if (params.pbk) realityOpts['public-key'] = params.pbk
    if (params.sid) realityOpts['short-id'] = params.sid
    const mlkem = parseBool(
      params['support-x25519mlkem768'] ?? params.supportX25519mlkem768,
    )
    if (mlkem !== undefined) {
      realityOpts['support-x25519mlkem768'] = mlkem
    }
    if (Object.keys(realityOpts).length > 0) {
      proxy['reality-opts'] = realityOpts
    }
  }

  if (params.encryption) {
    const encryption = params.encryption.split(';')
    if (encryption.length === 3) {
      proxy['ss-opts'] = {
        enabled: true,
        method: encryption[1],
        password: encryption[2],
      }
    }
  }

  if (proxy.network === 'ws') {
    const wsOpts: WsOptions = {}
    if (host) wsOpts.headers = { Host: host }
    applyWsEarlyData(wsOpts, path, params.eh)
    if (httpupgrade) {
      wsOpts['v2ray-http-upgrade'] = true
      wsOpts['v2ray-http-upgrade-fast-open'] = true
    }
    if (Object.keys(wsOpts).length > 0) {
      proxy['ws-opts'] = wsOpts
    }
  } else if (proxy.network === 'grpc') {
    const serviceName = getIfNotBlank(path ?? params.serviceName)
    if (serviceName) {
      proxy['grpc-opts'] = { 'grpc-service-name': serviceName }
    }
  } else if (proxy.network === 'h2') {
    const h2Opts: H2Options = {}
    const hostList = parseCommaList(host)
    if (hostList) {
      h2Opts.host = hostList.length === 1 ? hostList[0] : hostList
    }
    if (path) h2Opts.path = path
    if (Object.keys(h2Opts).length > 0) {
      proxy['h2-opts'] = h2Opts
    }
  } else if (proxy.network === 'http') {
    const httpOpts: HttpOptions = {}
    if (path) httpOpts.path = [path]
    if (host) httpOpts.headers = { Host: [host] }
    if (Object.keys(httpOpts).length > 0) {
      proxy['http-opts'] = httpOpts
    }
  }

  return proxy
}
