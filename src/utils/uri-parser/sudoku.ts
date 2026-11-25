import {
  decodeAndTrim,
  decodeBase64OrOriginal,
  getIfNotBlank,
  normalizeHost,
  parseBool,
  parseBoolOrPresence,
  parseCommaList,
  parseInteger,
  parseJsonObjectSafe,
  parsePortOrDefault,
  parseQueryStringNormalized,
  parseRequiredPort,
  parseUrlLike,
  safeDecodeURIComponent,
  splitOnce,
  stripUriScheme,
} from './helpers'

const SUDOKU_TABLE_TYPES = new Set<SudokuTableType>([
  'entropy',
  'prefer_entropy',
  'ascii',
  'prefer_ascii',
  'up_ascii_down_entropy',
  'up_entropy_down_ascii',
])

const SUDOKU_HTTP_MASK_MODES = new Set<SudokuHttpMaskMode>([
  'legacy',
  'stream',
  'poll',
  'auto',
  'ws',
])

const SUDOKU_MULTIPLEX_VALUES = new Set<SudokuHttpMaskMultiplex>([
  'off',
  'auto',
  'on',
])

function normalizeTableType(raw: unknown): SudokuTableType | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim() as SudokuTableType
  return SUDOKU_TABLE_TYPES.has(trimmed) ? trimmed : undefined
}

export function URI_Sudoku(line: string): IProxySudokuConfig {
  const afterScheme = stripUriScheme(line, 'sudoku', 'Invalid sudoku uri')
  if (!afterScheme) {
    throw new Error('Invalid sudoku uri')
  }

  const [beforeHash, hashRaw] = splitOnce(afterScheme, '#')
  const nameFromHash = decodeAndTrim(hashRaw)

  // Support base64 JSON format: sudoku://<base64(json)>
  if (!beforeHash.includes('@') && !beforeHash.includes('?')) {
    const decoded = decodeBase64OrOriginal(beforeHash)
    const obj = parseJsonObjectSafe(decoded)
    if (obj) {
      const serverRaw = obj.server ?? obj.host
      if (typeof serverRaw !== 'string' || !serverRaw.trim()) {
        throw new Error('Invalid sudoku uri: missing server')
      }
      const server = normalizeHost(serverRaw.trim())
      const port = parseRequiredPort(
        obj.port,
        'Invalid sudoku uri: invalid port',
      )
      const name =
        nameFromHash ??
        getIfNotBlank(
          typeof obj.name === 'string'
            ? obj.name
            : typeof obj.remarks === 'string'
              ? obj.remarks
              : undefined,
        ) ??
        `Sudoku ${server}:${port}`

      const proxy: IProxySudokuConfig = {
        type: 'sudoku',
        name,
        server,
        port,
      }
      const key = getIfNotBlank(
        typeof obj.key === 'string' ? obj.key : undefined,
      )
      if (key) proxy.key = key

      const aead = obj['aead-method'] ?? obj.aead_method ?? obj.aead
      if (
        aead === 'chacha20-poly1305' ||
        aead === 'aes-128-gcm' ||
        aead === 'none'
      ) {
        proxy['aead-method'] = aead
      }

      const paddingMin = parseInteger(
        obj['padding-min'] !== undefined
          ? String(obj['padding-min'])
          : obj.padding_min !== undefined
            ? String(obj.padding_min)
            : undefined,
      )
      if (paddingMin !== undefined) proxy['padding-min'] = paddingMin
      const paddingMax = parseInteger(
        obj['padding-max'] !== undefined
          ? String(obj['padding-max'])
          : obj.padding_max !== undefined
            ? String(obj.padding_max)
            : undefined,
      )
      if (paddingMax !== undefined) proxy['padding-max'] = paddingMax

      const tableType = normalizeTableType(
        obj['table-type'] ?? obj.table_type ?? obj.ascii,
      )
      if (tableType) proxy['table-type'] = tableType

      const pureDownlink =
        obj['enable-pure-downlink'] ?? obj.enable_pure_downlink
      if (pureDownlink !== undefined) {
        proxy['enable-pure-downlink'] = Boolean(pureDownlink)
      }

      if (obj.httpmask && typeof obj.httpmask === 'object') {
        const hm = obj.httpmask as Record<string, unknown>
        const httpMaskOpts: SudokuHttpMaskOptions = {}
        if (hm.disable !== undefined) httpMaskOpts.disable = Boolean(hm.disable)
        if (
          typeof hm.mode === 'string' &&
          SUDOKU_HTTP_MASK_MODES.has(hm.mode as SudokuHttpMaskMode)
        ) {
          httpMaskOpts.mode = hm.mode as SudokuHttpMaskMode
        }
        if (hm.tls !== undefined) httpMaskOpts.tls = Boolean(hm.tls)
        if (typeof hm.host === 'string' && hm.host.trim()) {
          httpMaskOpts.host = hm.host.trim()
        }
        const pathRoot = hm['path-root'] ?? hm.path_root
        if (typeof pathRoot === 'string' && pathRoot.trim()) {
          httpMaskOpts['path-root'] = pathRoot.trim()
        }
        if (
          typeof hm.multiplex === 'string' &&
          SUDOKU_MULTIPLEX_VALUES.has(hm.multiplex as SudokuHttpMaskMultiplex)
        ) {
          httpMaskOpts.multiplex = hm.multiplex as SudokuHttpMaskMultiplex
        }
        if (Object.keys(httpMaskOpts).length > 0) {
          proxy.httpmask = httpMaskOpts
        }
      }

      return proxy
    }
  }

  // Standard URI format: sudoku://key@server:port?params#name
  const {
    auth: keyRaw,
    host: server,
    port,
    query: addons,
    fragment: fragmentRaw,
  } = parseUrlLike(afterScheme, {
    errorMessage: 'Invalid sudoku uri',
  })
  if (!server) {
    throw new Error('Invalid sudoku uri: missing server')
  }
  const portNum = parsePortOrDefault(port, 443)
  const name = decodeAndTrim(fragmentRaw) ?? `Sudoku ${server}:${portNum}`
  const proxy: IProxySudokuConfig = {
    type: 'sudoku',
    name,
    server,
    port: portNum,
  }
  const key = getIfNotBlank(safeDecodeURIComponent(keyRaw) ?? keyRaw)
  if (key) {
    proxy.key = key
  }

  const params = parseQueryStringNormalized(addons)
  const aead = params['aead-method'] ?? params.aead ?? params.method
  if (
    aead === 'chacha20-poly1305' ||
    aead === 'aes-128-gcm' ||
    aead === 'none'
  ) {
    proxy['aead-method'] = aead
  }
  const tableType = normalizeTableType(params['table-type'] ?? params.ascii)
  if (tableType) proxy['table-type'] = tableType

  const paddingMin = parseInteger(params['padding-min'])
  if (paddingMin !== undefined) proxy['padding-min'] = paddingMin
  const paddingMax = parseInteger(params['padding-max'])
  if (paddingMax !== undefined) proxy['padding-max'] = paddingMax

  if (params['enable-pure-downlink'] !== undefined) {
    proxy['enable-pure-downlink'] = parseBoolOrPresence(
      params['enable-pure-downlink'],
    )
  }

  const customTable = getIfNotBlank(params['custom-table'])
  if (customTable) proxy['custom-table'] = customTable
  const customTables = parseCommaList(params['custom-tables'])
  if (customTables) proxy['custom-tables'] = customTables

  const httpMaskOpts: SudokuHttpMaskOptions = {}
  const hmDisable = parseBool(params['http-mask-disable'])
  if (hmDisable !== undefined) {
    httpMaskOpts.disable = hmDisable
  } else if (params['http-mask'] !== undefined) {
    const hmEnable = parseBool(params['http-mask'])
    if (hmEnable !== undefined) {
      httpMaskOpts.disable = !hmEnable
    }
  }
  const hmMode = params['http-mask-mode']
  if (hmMode && SUDOKU_HTTP_MASK_MODES.has(hmMode as SudokuHttpMaskMode)) {
    httpMaskOpts.mode = hmMode as SudokuHttpMaskMode
  }
  if (params['http-mask-tls'] !== undefined) {
    httpMaskOpts.tls = parseBoolOrPresence(params['http-mask-tls'])
  }
  const hmHost = getIfNotBlank(params['http-mask-host'])
  if (hmHost) httpMaskOpts.host = hmHost
  const pathRoot = getIfNotBlank(params['path-root'])
  if (pathRoot) httpMaskOpts['path-root'] = pathRoot
  const hmMux = params.multiplex ?? params['http-mask-multiplex']
  if (hmMux && SUDOKU_MULTIPLEX_VALUES.has(hmMux as SudokuHttpMaskMultiplex)) {
    httpMaskOpts.multiplex = hmMux as SudokuHttpMaskMultiplex
  }
  if (Object.keys(httpMaskOpts).length > 0) {
    proxy.httpmask = httpMaskOpts
  }

  return proxy
}
