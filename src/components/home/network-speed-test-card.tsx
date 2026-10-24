import {
  CloudDownloadRounded,
  CloudUploadRounded,
  SignalCellularAltRounded,
  WifiRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  CircularProgress,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { Channel } from '@tauri-apps/api/core'
import { cloneElement, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EnhancedCard } from '@/components/home/enhanced-card'
import {
  testNetworkSpeed,
  type SpeedTestProgress,
  type SpeedTestResult,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

const SPEED_TEST_STORAGE_KEY = 'clash-verge-speed-test-result'

interface SpeedCardData {
  latency: number | null
  lossRate: number | null
  downloadSpeed: number | null
  uploadSpeed: number | null
  location: string | null
  timestamp: string | null
}

const EMPTY_RESULT: SpeedCardData = {
  latency: null,
  lossRate: null,
  downloadSpeed: null,
  uploadSpeed: null,
  location: null,
  timestamp: null,
}

const loadSavedResult = (): SpeedCardData => {
  try {
    const raw = localStorage.getItem(SPEED_TEST_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SpeedCardData
      return { ...EMPTY_RESULT, ...parsed }
    }
  } catch (e) {
    console.warn('Failed to parse speed test cache', e)
  }
  return EMPTY_RESULT
}

/** Backend failures carry a stable `speedtest.*` code; prefer the translated
 * message and fall back to the raw detail when the code is unknown. */
const resolveErrorMessage = (error: unknown, t: (key: string) => string) => {
  if (typeof error === 'string') return error
  const err = error as { code?: string; detail?: string; message?: string }
  if (err?.code?.startsWith('speedtest.')) {
    const rawSubKey = err.code.slice('speedtest.'.length)
    const camelSubKey = rawSubKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    const key = `home.components.speedTest.errors.${camelSubKey}`
    const translated = t(key)
    if (translated !== key) return translated
  }
  return err?.detail || err?.message || String(error)
}

interface MetricTileProps {
  label: string
  value: string
  icon: React.ReactElement<any>
  iconColor: string
  bg: string
}

const MetricTile = ({ label, value, icon, iconColor, bg }: MetricTileProps) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      p: 1.5,
      borderRadius: 2,
      backgroundColor: bg,
    }}
  >
    {cloneElement(icon, {
      sx: { fontSize: 32, color: iconColor, mr: 1.5, flexShrink: 0 },
    })}
    <Box sx={{ minWidth: 0, flex: 1 }}>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontSize: '0.8125rem', lineHeight: 1.2, mb: 0.5 }}
      >
        {label}
      </Typography>
      <Typography
        variant="h6"
        sx={{
          fontWeight: 'bold',
          fontSize: '1.125rem',
          lineHeight: 1.2,
          color: 'text.primary',
        }}
      >
        {value}
      </Typography>
    </Box>
  </Box>
)

export const NetworkSpeedTestCard = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'

  const [testData, setTestData] = useState<SpeedCardData>(loadSavedResult)
  const [isRunning, setIsRunning] = useState(false)

  const handleStartTest = useCallback(async () => {
    if (isRunning) return
    setIsRunning(true)
    // Clear the previous run so a failed test never mixes old and new numbers.
    setTestData(EMPTY_RESULT)

    const channel = new Channel<SpeedTestProgress>()
    channel.onmessage = (progress) => {
      setTestData((prev) => ({
        latency: progress.latency ?? prev.latency,
        lossRate: progress.loss_rate ?? prev.lossRate,
        downloadSpeed: progress.download_speed ?? prev.downloadSpeed,
        // `upload_start` reports a 0 placeholder; keep the previous value so
        // the tile does not flash 0.0 before the real upload finishes.
        uploadSpeed:
          progress.stage === 'upload_start'
            ? prev.uploadSpeed
            : (progress.upload_speed ?? prev.uploadSpeed),
        location: progress.location ?? prev.location,
        timestamp: progress.timestamp ?? prev.timestamp,
      }))
    }

    try {
      const result: SpeedTestResult = await testNetworkSpeed(channel)
      const finalData: SpeedCardData = {
        latency: result.latency,
        lossRate: result.loss_rate,
        downloadSpeed: result.download_speed,
        uploadSpeed: result.upload_speed,
        location: result.location,
        timestamp: result.timestamp,
      }
      setTestData(finalData)
      localStorage.setItem(SPEED_TEST_STORAGE_KEY, JSON.stringify(finalData))
    } catch (error: any) {
      showNotice.error(resolveErrorMessage(error, t))
    } finally {
      setIsRunning(false)
    }
  }, [isRunning, t])

  const itemBg = isDark
    ? alpha(theme.palette.common.white, 0.05)
    : alpha(theme.palette.common.black, 0.03)

  const tiles = [
    {
      key: 'latency',
      label: t('home.components.speedTest.metrics.latency', '延迟'),
      icon: <SignalCellularAltRounded />,
      iconColor: '#1e88e5',
      value: `${testData.latency ?? '-'} ms`,
    },
    {
      key: 'packetLoss',
      label: t('home.components.speedTest.metrics.packetLoss', '丢包率'),
      icon: <SignalCellularAltRounded />,
      iconColor: '#ffa726',
      value: `${testData.lossRate !== null ? testData.lossRate.toFixed(1) : '-'} %`,
    },
    {
      key: 'download',
      label: t('home.components.speedTest.metrics.download', '下载速度'),
      icon: <CloudDownloadRounded />,
      iconColor: '#4caf50',
      value: `${testData.downloadSpeed !== null ? testData.downloadSpeed.toFixed(1) : '-'} MB/s`,
    },
    {
      key: 'upload',
      label: t('home.components.speedTest.metrics.upload', '上传速度'),
      icon: <CloudUploadRounded />,
      iconColor: '#ff9800',
      value: `${testData.uploadSpeed !== null ? testData.uploadSpeed.toFixed(1) : '-'} MB/s`,
    },
  ]

  return (
    <EnhancedCard
      title={t('home.components.speedTest.title', '网络测速')}
      icon={<WifiRounded />}
      iconColor="primary"
      action={
        <Button
          variant="outlined"
          size="small"
          onClick={handleStartTest}
          disabled={isRunning}
          startIcon={
            isRunning ? (
              <CircularProgress size={14} color="inherit" />
            ) : undefined
          }
          sx={{
            minWidth: 80,
            textTransform: 'none',
            fontSize: '0.8125rem',
            px: 1.5,
          }}
        >
          {isRunning
            ? t('home.components.speedTest.actions.testing', '测速中')
            : t('home.components.speedTest.actions.start', '开始测速')}
        </Button>
      }
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 1.5,
          flex: 1,
        }}
      >
        {tiles.map((tile) => (
          <MetricTile
            key={tile.key}
            label={tile.label}
            value={tile.value}
            icon={tile.icon}
            iconColor={tile.iconColor}
            bg={itemBg}
          />
        ))}
      </Box>

      {/* Footer: 测速节点所在地地区 & 测速时间 */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mt: 1.5,
          pt: 0.5,
          px: 0.5,
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontSize: '0.8125rem' }}
        >
          {testData.location || '-'}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontSize: '0.8125rem' }}
        >
          {testData.timestamp || '-'}
        </Typography>
      </Box>
    </EnhancedCard>
  )
}
