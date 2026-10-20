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
import { useCallback, useState } from 'react'
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

const loadSavedResult = (): SpeedCardData => {
  try {
    const raw = localStorage.getItem(SPEED_TEST_STORAGE_KEY)
    if (raw) {
      return JSON.parse(raw) as SpeedCardData
    }
  } catch (e) {
    console.warn('Failed to parse speed test cache', e)
  }
  return {
    latency: null,
    lossRate: null,
    downloadSpeed: null,
    uploadSpeed: null,
    location: null,
    timestamp: null,
  }
}

export const NetworkSpeedTestCard = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'

  const [testData, setTestData] = useState<SpeedCardData>(loadSavedResult)
  const [isRunning, setIsRunning] = useState(false)

  const handleStartTest = useCallback(async () => {
    if (isRunning) return
    setIsRunning(true)

    const channel = new Channel<SpeedTestProgress>()
    channel.onmessage = (progress) => {
      setTestData((prev) => ({
        latency: progress.latency ?? prev.latency,
        lossRate: progress.loss_rate ?? prev.lossRate,
        downloadSpeed: progress.download_speed ?? prev.downloadSpeed,
        uploadSpeed: progress.upload_speed ?? prev.uploadSpeed,
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
      const msg =
        typeof error === 'string' ? error : error?.detail || error?.message || String(error)
      showNotice.error(msg)
    } finally {
      setIsRunning(false)
    }
  }, [isRunning])

  const itemBg = isDark
    ? alpha(theme.palette.common.white, 0.05)
    : alpha(theme.palette.common.black, 0.03)

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
        {/* 延迟 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            p: 1.5,
            borderRadius: 2,
            backgroundColor: itemBg,
          }}
        >
          <SignalCellularAltRounded
            sx={{
              fontSize: 32,
              color: '#1e88e5',
              mr: 1.5,
              flexShrink: 0,
            }}
          />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontSize: '0.8125rem', lineHeight: 1.2, mb: 0.5 }}
            >
              {t('home.components.speedTest.metrics.latency', '延迟')}
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
              {testData.latency !== null ? `${testData.latency} ms` : '- ms'}
            </Typography>
          </Box>
        </Box>

        {/* 丢包率 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            p: 1.5,
            borderRadius: 2,
            backgroundColor: itemBg,
          }}
        >
          <SignalCellularAltRounded
            sx={{
              fontSize: 32,
              color: '#ffa726',
              mr: 1.5,
              flexShrink: 0,
            }}
          />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontSize: '0.8125rem', lineHeight: 1.2, mb: 0.5 }}
            >
              {t('home.components.speedTest.metrics.packetLoss', '丢包率')}
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
              {testData.lossRate !== null
                ? `${testData.lossRate.toFixed(1)} %`
                : '- %'}
            </Typography>
          </Box>
        </Box>

        {/* 下载速度 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            p: 1.5,
            borderRadius: 2,
            backgroundColor: itemBg,
          }}
        >
          <CloudDownloadRounded
            sx={{
              fontSize: 32,
              color: '#4caf50',
              mr: 1.5,
              flexShrink: 0,
            }}
          />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontSize: '0.8125rem', lineHeight: 1.2, mb: 0.5 }}
            >
              {t('home.components.speedTest.metrics.download', '下载速度')}
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
              {testData.downloadSpeed !== null
                ? `${testData.downloadSpeed.toFixed(1)} MB/s`
                : '- MB/s'}
            </Typography>
          </Box>
        </Box>

        {/* 上传速度 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            p: 1.5,
            borderRadius: 2,
            backgroundColor: itemBg,
          }}
        >
          <CloudUploadRounded
            sx={{
              fontSize: 32,
              color: '#ff9800',
              mr: 1.5,
              flexShrink: 0,
            }}
          />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontSize: '0.8125rem', lineHeight: 1.2, mb: 0.5 }}
            >
              {t('home.components.speedTest.metrics.upload', '上传速度')}
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
              {testData.uploadSpeed !== null
                ? `${testData.uploadSpeed.toFixed(1)} MB/s`
                : '- MB/s'}
            </Typography>
          </Box>
        </Box>
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
