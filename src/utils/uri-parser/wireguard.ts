import {
  decodeAndTrim,
  decodeBase64ToBytes,
  getIfNotBlank,
  isIPv4,
  isIPv6,
  parseBoolOrPresence,
  parseCommaList,
  parseInteger,
  parsePortOrDefault,
  parseQueryStringNormalized,
  parseUrlLike,
  safeDecodeURIComponent,
  stripUriScheme,
} from './helpers'

const AMNEZIA_INT_KEYS = [
  ['awg-version', 'version'],
  ['amnezia-version', 'version'],
  ['jc', 'jc'],
  ['jmin', 'jmin'],
  ['jmax', 'jmax'],
  ['s1', 's1'],
  ['s2', 's2'],
  ['s3', 's3'],
  ['s4', 's4'],
  ['itime', 'itime'],
] as const

const AMNEZIA_STR_KEYS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'i1',
  'i2',
  'i3',
  'i4',
  'i5',
  'j1',
  'j2',
  'j3',
] as const

function parseWireguardReserved(value: string): number[] | undefined {
  const commaParts = value
    .split(',')
    .map((item) => parseInteger(item.trim()))
    .filter(
      (num): num is number =>
        num !== undefined && Number.isInteger(num) && num >= 0 && num <= 255,
    )
  if (commaParts.length === 3) {
    return commaParts
  }

  try {
    const bytes = decodeBase64ToBytes(value)
    if (bytes.length === 3) {
      return [bytes[0], bytes[1], bytes[2]]
    }
  } catch {
    // Ignore non-base64 reserved values
  }
  return undefined
}

export function URI_Wireguard(line: string): IProxyWireguardConfig {
  const afterScheme = stripUriScheme(
    line,
    ['wireguard', 'wg'],
    'Invalid wireguard uri',
  )
  if (!afterScheme) {
    throw new Error('Invalid wireguard uri')
  }
  const {
    auth: privateKeyRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, { errorMessage: 'Invalid wireguard uri' })
  const portNum = parsePortOrDefault(port, 51820)
  const privateKey = safeDecodeURIComponent(privateKeyRaw) ?? privateKeyRaw
  const decodedName = decodeAndTrim(nameRaw)

  const name = decodedName ?? `WireGuard ${server}:${portNum}`
  const proxy: IProxyWireguardConfig = {
    type: 'wireguard',
    name,
    server,
    port: portNum,
    'private-key': privateKey,
    udp: true,
  }

  const params = parseQueryStringNormalized(addons)
  const amnezia: AmneziaWgOption = {}
  const amneziaIntMap = new Map<string, keyof AmneziaWgOption>(AMNEZIA_INT_KEYS)
  const amneziaStrSet = new Set<string>(AMNEZIA_STR_KEYS)

  for (const [key, value] of Object.entries(params)) {
    const lowerKey = key.toLowerCase()
    const amneziaIntTarget = amneziaIntMap.get(lowerKey)
    if (amneziaIntTarget) {
      const num = parseInteger(value?.trim())
      if (num !== undefined) {
        ;(amnezia as Record<string, unknown>)[amneziaIntTarget] = num
      }
      continue
    }
    if (amneziaStrSet.has(lowerKey)) {
      const strVal = getIfNotBlank(value)
      if (strVal) {
        ;(amnezia as Record<string, unknown>)[lowerKey] = strVal
      }
      continue
    }

    switch (key) {
      case 'address':
      case 'ip':
        if (!value) break
        value.split(',').forEach((i) => {
          const ip = i
            .trim()
            .replace(/\/\d+$/, '')
            .replace(/^\[/, '')
            .replace(/\]$/, '')
          if (isIPv4(ip)) {
            proxy.ip = ip
          } else if (isIPv6(ip)) {
            proxy.ipv6 = ip
          }
        })
        break
      case 'publickey':
      case 'public-key':
        if (!value) break
        proxy['public-key'] = value
        break
      case 'allowed-ips':
        proxy['allowed-ips'] = parseCommaList(value)
        break
      case 'pre-shared-key':
      case 'psk':
        if (!value) break
        proxy['pre-shared-key'] = value
        break
      case 'reserved':
        if (value) {
          const parsedReserved = parseWireguardReserved(value)
          if (parsedReserved) proxy.reserved = parsedReserved
        }
        break
      case 'persistent-keepalive':
      case 'keepalive':
        proxy['persistent-keepalive'] = parseInteger(value?.trim())
        break
      case 'udp':
        proxy.udp = parseBoolOrPresence(value)
        break
      case 'mtu':
        proxy.mtu = parseInteger(value?.trim())
        break
      case 'dialer-proxy':
        proxy['dialer-proxy'] = value
        break
      case 'remote-dns-resolve':
        proxy['remote-dns-resolve'] = parseBoolOrPresence(value)
        break
      case 'dns':
        proxy.dns = parseCommaList(value)
        break
      default:
        break
    }
  }

  if (Object.keys(amnezia).length > 0) {
    proxy['amnezia-wg-option'] = amnezia
  }

  return proxy
}
