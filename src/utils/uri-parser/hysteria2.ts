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
  stripUriScheme,
} from './helpers'

const BBR_PROFILES = new Set(['standard', 'conservative', 'aggressive'])

export function URI_Hysteria2(line: string): IProxyHysteria2Config {
  const afterScheme = stripUriScheme(
    line,
    ['hysteria2', 'hy2'],
    'Invalid hysteria2 uri',
  )
  if (!afterScheme) {
    throw new Error('Invalid hysteria2 uri')
  }
  const {
    auth: passwordRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, {
    requireAuth: true,
    errorMessage: 'Invalid hysteria2 uri',
  })

  const isPortRange = Boolean(port && /^\d+-\d+$/.test(port))
  const portNum = parsePortOrDefault(
    isPortRange && port ? port.split('-')[0] : port,
    443,
  )
  const password = safeDecodeURIComponent(passwordRaw) ?? passwordRaw

  const decodedName = decodeAndTrim(nameRaw)
  const name = decodedName ?? `Hysteria2 ${server}:${portNum}`

  const proxy: IProxyHysteria2Config = {
    type: 'hysteria2',
    name,
    server,
    port: portNum,
    password,
  }

  const params = parseQueryStringNormalized(addons)

  proxy.sni = getIfNotBlank(params.sni ?? params.peer)
  if (params.obfs && params.obfs !== 'none') {
    proxy.obfs = params.obfs
  }

  const queryPorts = getIfNotBlank(params.mport ?? params.ports)
  if (queryPorts) {
    proxy.ports = queryPorts
  } else if (isPortRange && port) {
    proxy.ports = port
  }

  const hopIntervalRaw = getIfNotBlank(
    params['hop-interval'] ??
      params['port-hopping-interval'] ??
      params.interval,
  )
  if (hopIntervalRaw) {
    proxy['hop-interval'] = /^\d+$/.test(hopIntervalRaw)
      ? parseInteger(hopIntervalRaw)
      : hopIntervalRaw
  }

  const up = getIfNotBlank(params.up ?? params.upmbps)
  if (up) proxy.up = up
  const down = getIfNotBlank(params.down ?? params.downmbps)
  if (down) proxy.down = down

  const alpn = parseCommaList(params.alpn)
  if (alpn) proxy.alpn = alpn

  const bbrProfile = getIfNotBlank(params['bbr-profile'] ?? params.bbrProfile)
  if (bbrProfile && BBR_PROFILES.has(bbrProfile)) {
    proxy['bbr-profile'] = bbrProfile as BbrProfile
  }

  const echOpts = parseEchParam(
    params.ech ?? params['ech-config'],
    params['ech-query-server-name'] ?? params.echQueryServerName,
  )
  if (echOpts) proxy['ech-opts'] = echOpts

  if (params['obfs-password']) {
    proxy['obfs-password'] = params['obfs-password']
  }

  const insecure = parseInsecureParam(params)
  if (insecure !== undefined) {
    proxy['skip-cert-verify'] = insecure
  }
  if (Object.prototype.hasOwnProperty.call(params, 'fastopen')) {
    proxy.tfo = parseBoolOrPresence(params.fastopen)
  }
  const fingerprint = getIfNotBlank(params.pinSHA256 ?? params.fingerprint)
  if (fingerprint) {
    proxy.fingerprint = fingerprint
  }

  return proxy
}
