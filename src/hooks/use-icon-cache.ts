import { convertFileSrc } from '@tauri-apps/api/core'

import { downloadIconCache } from '@/services/cmds'
import { useQuery } from '@/services/query-client'

export interface UseIconCacheOptions {
  icon?: string | null
  cacheKey?: string
  enabled?: boolean
}

const sanitizeFileSegment = (segment: string) => {
  const cleaned = Array.from(segment, (ch) =>
    ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch,
  )
    .join('')
    .trim()
  return cleaned || 'icon'
}

const getFileNameFromUrl = (url: string) => {
  try {
    const pathname = new URL(url).pathname
    const segment = pathname.slice(pathname.lastIndexOf('/') + 1)
    return sanitizeFileSegment(segment)
  } catch {
    const clean = url.split(/[?#]/)[0]
    const segment = clean.slice(clean.lastIndexOf('/') + 1)
    return sanitizeFileSegment(segment)
  }
}

export const useIconCache = ({
  icon,
  cacheKey,
  enabled = true,
}: UseIconCacheOptions) => {
  const iconValue = icon?.trim() ?? ''
  const cacheKeyValue = cacheKey?.trim() ?? ''

  const isEnabled =
    enabled && iconValue.startsWith('http') && cacheKeyValue !== ''

  const { data } = useQuery({
    queryKey: ['icon-cache', iconValue, cacheKeyValue],
    queryFn: async () => {
      try {
        const fileName = `${cacheKeyValue}-${getFileNameFromUrl(iconValue)}`
        const iconPath = await downloadIconCache(iconValue, fileName)
        return convertFileSrc(iconPath)
      } catch {
        return ''
      }
    },
    enabled: isEnabled,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    retry: 2,
  })

  if (!isEnabled) {
    return ''
  }

  return data ?? ''
}
