import {
  GppGoodOutlined,
  GppMaybeOutlined,
  RefreshOutlined,
  SecurityOutlined,
  VisibilityOffOutlined,
  VisibilityOutlined,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  Skeleton,
  Switch,
  Typography,
} from '@mui/material'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEffect } from 'foxact/use-abortable-effect'
import { useIntersection } from 'foxact/use-intersection'
import { useLocalStorage } from 'foxact/use-local-storage'
import type { XOR } from 'foxts/ts-xor'
import {
  forwardRef,
  memo,
  useCallback,
  useEffectEvent,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { getDnsLeakInfo } from '@/services/api'
import { useQuery } from '@/services/query-client'
import getSystem from '@/utils/get-system'

import { EnhancedCard } from './enhanced-card'

const DNS_REFRESH_SECONDS = 300
const COUNTDOWN_TICK_INTERVAL = 5_000
const DNS_LEAK_CACHE_KEY = 'cv_dns_leak_cache'

const InfoItem = memo(({ label, value }: { label: string; value?: string }) => (
  <Box sx={{ mb: 0.7, display: 'flex', alignItems: 'flex-start' }}>
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{ minWidth: 60, mr: 0.5, flexShrink: 0, textAlign: 'right' }}
    >
      {label}:
    </Typography>
    <Typography
      variant="body2"
      sx={{
        ml: 0.5,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        wordBreak: 'break-word',
        whiteSpace: 'normal',
        flexGrow: 1,
      }}
    >
      {value || 'Unknown'}
    </Typography>
  </Box>
))

const getCountryFlag = (countryCode: string | undefined) => {
  if (!countryCode) return ''
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0))
  return String.fromCodePoint(...codePoints)
}

type CountDownState = XOR<
  {
    type: 'countdown'
    remainingSeconds: number
  },
  {
    type: 'revalidating'
  }
>

const DnsLeakCardContainer = forwardRef<
  HTMLElement,
  React.PropsWithChildren<{ hasLeak?: boolean }>
>(({ children, hasLeak }, ref) => {
  const { t } = useTranslation()
  const { refetch: mutate } = useDnsLeakInfo()

  return (
    <EnhancedCard
      title={t('home.components.dnsLeak.title')}
      icon={<SecurityOutlined />}
      iconColor={hasLeak ? 'warning' : 'primary'}
      ref={ref}
      action={
        <IconButton size="small" onClick={() => mutate()}>
          <RefreshOutlined />
        </IconButton>
      }
    >
      {children}
    </EnhancedCard>
  )
})

export const DnsLeakCard = () => {
  const { t } = useTranslation()
  const [showIp, setShowIp] = useState(false)
  const [autoRefresh, setAutoRefresh] = useLocalStorage(
    'dns-leak-auto-refresh',
    true,
  )
  const appWindow = useMemo(() => getCurrentWebviewWindow(), [])

  const [containerRef, hasIntersected] = useIntersection({
    rootMargin: '0px',
  })

  const [countdown, setCountdown] = useState<CountDownState>({
    type: 'countdown',
    remainingSeconds: DNS_REFRESH_SECONDS,
  })

  const { data: dnsData, error, isLoading, refetch: mutate } = useDnsLeakInfo()

  const onCountdownTick = useEffectEvent(async () => {
    const now = Date.now()
    const ts = dnsData?.lastFetchTs
    if (!ts) return

    const elapsed = Math.floor((now - ts) / 1000)
    const remaining = DNS_REFRESH_SECONDS - elapsed

    if (remaining <= 0) {
      if (
        hasIntersected &&
        navigator.onLine &&
        countdown.type !== 'revalidating' &&
        (await appWindow.isVisible())
      ) {
        setCountdown({ type: 'revalidating' })
        try {
          await mutate()
        } finally {
          setCountdown({
            type: 'countdown',
            remainingSeconds: DNS_REFRESH_SECONDS,
          })
        }
      }
    } else {
      setCountdown({
        type: 'countdown',
        remainingSeconds: remaining,
      })
    }
  })

  useEffect(() => {
    if (!autoRefresh) return

    let timer: number | null = null

    if (hasIntersected) {
      timer = window.setInterval(onCountdownTick, COUNTDOWN_TICK_INTERVAL)
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (timer != null) {
          clearInterval(timer)
          timer = null
        }
      } else if (hasIntersected) {
        if (timer == null) {
          timer = window.setInterval(onCountdownTick, COUNTDOWN_TICK_INTERVAL)
        }
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      if (timer != null) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [autoRefresh, hasIntersected])

  const toggleShowIp = useCallback(() => {
    setShowIp((prev) => !prev)
  }, [])

  let mainElement: React.ReactElement

  switch (true) {
    case isLoading:
      mainElement = (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Skeleton variant="text" width="60%" height={30} />
          <Skeleton variant="text" width="80%" height={24} />
          <Skeleton variant="text" width="70%" height={24} />
          <Skeleton variant="text" width="50%" height={24} />
        </Box>
      )
      break
    case !!error:
      mainElement = (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'error.main',
          }}
        >
          <Typography variant="body1" color="error">
            {error instanceof Error
              ? error.message
              : t('home.components.dnsLeak.errors.load')}
          </Typography>
          <Button onClick={() => mutate()} sx={{ mt: 2 }}>
            {t('shared.actions.retry')}
          </Button>
        </Box>
      )
      break
    default: {
      const primaryServer = dnsData?.servers?.[0]
      const hasLeak = dnsData?.hasLeak ?? false

      mainElement = (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* 状态徽章条 */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 1,
            }}
          >
            <Chip
              icon={
                hasLeak ? (
                  <GppMaybeOutlined fontSize="small" />
                ) : (
                  <GppGoodOutlined fontSize="small" />
                )
              }
              label={
                hasLeak
                  ? t('home.components.dnsLeak.status.leaking')
                  : t('home.components.dnsLeak.status.safe')
              }
              color={hasLeak ? 'warning' : 'success'}
              size="small"
              sx={{ fontWeight: 'medium', height: 26 }}
            />
            <Typography variant="caption" color="text.secondary">
              {`${t('home.components.dnsLeak.labels.serversCount')}: ${dnsData?.servers?.length ?? 0}`}
            </Typography>
          </Box>

          {/* 解析服务器详情 */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'row',
              flex: 1,
              overflow: 'hidden',
            }}
          >
            <Box sx={{ width: '45%', overflow: 'hidden' }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  mb: 1,
                  overflow: 'hidden',
                }}
              >
                <Box
                  component="span"
                  sx={{
                    fontSize: '1.5rem',
                    mr: 1,
                    display: 'inline-block',
                    width: 28,
                    textAlign: 'center',
                    flexShrink: 0,
                    fontFamily:
                      getSystem() === 'windows'
                        ? '"twemoji mozilla", sans-serif'
                        : 'sans-serif',
                  }}
                >
                  {getCountryFlag(primaryServer?.country)}
                </Box>
                <Typography
                  variant="subtitle1"
                  sx={{
                    fontWeight: 'medium',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}
                >
                  {primaryServer?.country_name ||
                    primaryServer?.country?.toUpperCase() ||
                    (dnsData?.servers?.length === 0
                      ? t('home.components.dnsLeak.labels.noServers')
                      : 'N/A')}
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ flexShrink: 0 }}
                >
                  DNS:
                </Typography>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    ml: 1,
                    overflow: 'hidden',
                    maxWidth: 'calc(100% - 30px)',
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      fontFamily: 'monospace',
                      fontSize: '0.75rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      wordBreak: 'break-all',
                    }}
                  >
                    {primaryServer?.ip
                      ? showIp
                        ? primaryServer.ip
                        : '••••••••••'
                      : 'N/A'}
                  </Typography>
                  {primaryServer?.ip && (
                    <IconButton size="small" onClick={toggleShowIp}>
                      {showIp ? (
                        <VisibilityOffOutlined fontSize="small" />
                      ) : (
                        <VisibilityOutlined fontSize="small" />
                      )}
                    </IconButton>
                  )}
                </Box>
              </Box>

              <InfoItem
                label="ASN"
                value={primaryServer?.asn ? `${primaryServer.asn}` : 'N/A'}
              />
            </Box>

            <Box sx={{ width: '55%', overflow: 'auto' }}>
              <InfoItem
                label={t('home.components.dnsLeak.labels.isp')}
                value={primaryServer?.org || 'N/A'}
              />
              <InfoItem
                label={t('home.components.dnsLeak.labels.location')}
                value={
                  primaryServer?.country_name || primaryServer?.country || 'N/A'
                }
              />
              <InfoItem
                label={t('home.components.dnsLeak.labels.conclusion')}
                value={
                  hasLeak
                    ? t('home.components.dnsLeak.status.leaking')
                    : t('home.components.dnsLeak.status.safe')
                }
              />
            </Box>
          </Box>

          {/* 底部状态栏 */}
          <Box
            sx={{
              mt: 'auto',
              pt: 0.5,
              borderTop: 1,
              borderColor: 'divider',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              opacity: 0.7,
              fontSize: '0.7rem',
            }}
          >
            <FormControlLabel
              sx={{ m: 0 }}
              control={
                <Switch
                  size="small"
                  checked={autoRefresh}
                  onChange={(_, checked) => setAutoRefresh(checked)}
                />
              }
              label={
                <Typography variant="caption">
                  {t('home.components.dnsLeak.labels.autoRefresh')}
                  {autoRefresh &&
                    (countdown.type === 'countdown'
                      ? `: ${countdown.remainingSeconds}s`
                      : '...')}
                </Typography>
              }
            />
            <Typography
              variant="caption"
              sx={{
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                fontWeight: 'medium',
                color: hasLeak ? 'warning.main' : 'success.main',
              }}
            >
              {hasLeak
                ? t('home.components.dnsLeak.status.leaking')
                : t('home.components.dnsLeak.status.safe')}
            </Typography>
          </Box>
        </Box>
      )
      break
    }
  }

  return (
    <DnsLeakCardContainer
      ref={containerRef}
      hasLeak={dnsData?.hasLeak ?? false}
    >
      {mainElement}
    </DnsLeakCardContainer>
  )
}

function useDnsLeakInfo() {
  return useQuery({
    queryKey: [DNS_LEAK_CACHE_KEY],
    queryFn: getDnsLeakInfo,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    retryDelay: 30_000,
  })
}
