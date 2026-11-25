import { useEffect, useState } from 'react'

export type WebdavStatus = 'unknown' | 'ready' | 'failed'

interface WebdavStatusCache {
  signature: string
  status: WebdavStatus
  updatedAt: number
}

const WEBDAV_STATUS_KEY = 'webdav_status_cache'
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i

const fallbackDigestHex = (input: string): string => {
  // Deterministic non-reversible mix fallback if WebCrypto is unavailable.
  let h1 = 0x811c9dc5
  let h2 = 0xdeadbeef
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ ((ch + i) & 0xff), 0x85ebca6b) >>> 0
  }
  return `fb-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

export const buildWebdavSignature = async (
  verge?: Pick<
    IVergeConfig,
    'webdav_url' | 'webdav_username' | 'webdav_password'
  > | null,
): Promise<string> => {
  const url = verge?.webdav_url?.trim() ?? ''
  const username = verge?.webdav_username?.trim() ?? ''
  const password = verge?.webdav_password ?? ''

  if (!url && !username && !password) return ''

  const canonical = JSON.stringify([url, username, password])
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    return fallbackDigestHex(canonical)
  }

  const encoded = new TextEncoder().encode(canonical)
  const digest = await subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export const useWebdavSignatureState = (
  verge?: Pick<
    IVergeConfig,
    'webdav_url' | 'webdav_username' | 'webdav_password'
  > | null,
): { signature: string; ready: boolean } => {
  const url = verge?.webdav_url?.trim() ?? ''
  const username = verge?.webdav_username?.trim() ?? ''
  const password = verge?.webdav_password ?? ''
  const currentKey = `${url}\0${username}\0${password}`
  const [resolved, setResolved] = useState<{ key: string; signature: string }>({
    key: '',
    signature: '',
  })

  useEffect(() => {
    let active = true
    void buildWebdavSignature({
      webdav_url: url,
      webdav_username: username,
      webdav_password: password,
    }).then((nextSignature) => {
      if (active) {
        setResolved({ key: currentKey, signature: nextSignature })
      }
    })
    return () => {
      active = false
    }
  }, [currentKey, url, username, password])

  const ready = resolved.key === currentKey
  return {
    signature: ready ? resolved.signature : '',
    ready,
  }
}

export const useWebdavSignature = (
  verge?: Pick<
    IVergeConfig,
    'webdav_url' | 'webdav_username' | 'webdav_password'
  > | null,
): string => useWebdavSignatureState(verge).signature

const canUseStorage = () => typeof localStorage !== 'undefined'

const isSafeStoredSignature = (sig: unknown): sig is string =>
  typeof sig === 'string' && (SHA256_HEX_RE.test(sig) || sig.startsWith('fb-'))

export const getWebdavStatus = (signature: string): WebdavStatus => {
  if (!signature || !canUseStorage()) return 'unknown'

  const raw = localStorage.getItem(WEBDAV_STATUS_KEY)
  if (!raw) return 'unknown'

  try {
    const data = JSON.parse(raw) as Partial<WebdavStatusCache>
    if (!data || !isSafeStoredSignature(data.signature)) {
      localStorage.removeItem(WEBDAV_STATUS_KEY)
      return 'unknown'
    }
    if (data.signature !== signature) return 'unknown'
    return data.status === 'ready' || data.status === 'failed'
      ? data.status
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const setWebdavStatus = (signature: string, status: WebdavStatus) => {
  if (!canUseStorage()) return
  if (!signature || !isSafeStoredSignature(signature)) {
    localStorage.removeItem(WEBDAV_STATUS_KEY)
    return
  }

  const payload: WebdavStatusCache = {
    signature,
    status,
    updatedAt: Date.now(),
  }

  localStorage.setItem(WEBDAV_STATUS_KEY, JSON.stringify(payload))
}
