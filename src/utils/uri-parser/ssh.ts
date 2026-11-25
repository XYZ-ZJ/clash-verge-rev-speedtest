import {
  decodeAndTrim,
  getIfNotBlank,
  parseCommaList,
  parsePortOrDefault,
  parseQueryStringNormalized,
  parseUrlLike,
  safeDecodeURIComponent,
  splitOnce,
  stripUriScheme,
} from './helpers'

export function URI_SSH(line: string): IProxySshConfig {
  const afterScheme = stripUriScheme(line, 'ssh', 'Invalid ssh uri')
  if (!afterScheme) {
    throw new Error('Invalid ssh uri')
  }

  const {
    auth: authRaw,
    host: server,
    port,
    query: addons,
    fragment: nameRaw,
  } = parseUrlLike(afterScheme, { errorMessage: 'Invalid ssh uri' })

  if (!server) {
    throw new Error('Invalid ssh uri: missing server')
  }

  const portNum = parsePortOrDefault(port, 22)
  const name = decodeAndTrim(nameRaw) ?? `SSH ${server}:${portNum}`
  const proxy: IProxySshConfig = {
    type: 'ssh',
    name,
    server,
    port: portNum,
  }

  if (authRaw) {
    const auth = safeDecodeURIComponent(authRaw) ?? authRaw
    const [username, password] = splitOnce(auth, ':')
    if (username) proxy.username = username
    if (password !== undefined) proxy.password = password
  }

  const params = parseQueryStringNormalized(addons)
  const privateKey = getIfNotBlank(
    params['private-key'] ?? params.privateKey ?? params.pk,
  )
  if (privateKey) {
    proxy['private-key'] = privateKey
  }
  const passphrase = getIfNotBlank(
    params['private-key-passphrase'] ?? params.passphrase,
  )
  if (passphrase) {
    proxy['private-key-passphrase'] = passphrase
  }
  const hostKey = parseCommaList(params['host-key'] ?? params.hostKey)
  if (hostKey) {
    proxy['host-key'] = hostKey
  }
  const hostKeyAlgs = parseCommaList(
    params['host-key-algorithms'] ?? params.hostKeyAlgorithms,
  )
  if (hostKeyAlgs) {
    proxy['host-key-algorithms'] = hostKeyAlgs
  }

  return proxy
}
