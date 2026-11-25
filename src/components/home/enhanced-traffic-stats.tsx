import {
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  ErrorOutlineRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Grid,
  Paper,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useMemo, useRef } from 'react'
import { ErrorBoundary, FallbackProps } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'

import { useClashMode } from '@/hooks/use-clash'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import {
  isThroughProxyNode,
  useAccumulatedTraffic,
} from '@/services/traffic-tracker'
import parseTraffic from '@/utils/parse-traffic'

import {
  EnhancedCanvasTrafficGraph,
  type EnhancedCanvasTrafficGraphRef,
} from './enhanced-canvas-traffic-graph'

interface TrafficSideStats {
  downSpeed: string
  upSpeed: string
  downloadTotal: string
  uploadTotal: string
}

const SpeedRow = ({
  icon,
  color,
  value,
}: {
  icon: React.ReactElement<any>
  color: string
  value: string
}) => (
  <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
    <Box
      sx={{
        fontSize: 18,
        color,
        mr: 0.5,
        flexShrink: 0,
        display: 'inline-flex',
        '& svg': { fontSize: 18 },
      }}
    >
      {icon}
    </Box>
    <Typography
      variant="body2"
      noWrap
      sx={{
        fontWeight: 700,
        fontSize: '0.9375rem',
        color: 'text.primary',
        lineHeight: 1.2,
      }}
    >
      {value}
    </Typography>
  </Box>
)

const TotalLabel = ({ label, value }: { label: string; value: string }) => (
  <Typography
    variant="caption"
    color="text.secondary"
    noWrap
    sx={{ fontSize: '0.75rem', lineHeight: 1.2, display: 'block' }}
  >
    {label}{' '}
    <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
      {value}
    </Box>
  </Typography>
)

const TrafficCard = ({
  paletteKey,
  title,
  stats,
  downloadedLabel,
  uploadedLabel,
}: {
  paletteKey: 'info' | 'success'
  title: string
  stats: TrafficSideStats
  downloadedLabel: string
  uploadedLabel: string
}) => {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const color = theme.palette[paletteKey].main

  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: 2,
        bgcolor: isDark ? alpha(color, 0.12) : alpha(color, 0.06),
        border: `1px solid ${alpha(color, isDark ? 0.35 : 0.22)}`,
        transition: 'all 0.2s ease-in-out',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 卡片头部 */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <Box
          sx={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            bgcolor: `${paletteKey}.main`,
            mr: 1,
            boxShadow: `0 0 4px ${color}`,
            flexShrink: 0,
          }}
        />
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 700,
            fontSize: '0.875rem',
            lineHeight: 1.2,
            color: `${paletteKey}.main`,
          }}
        >
          {title}
        </Typography>
      </Box>

      {/* 实时速率 */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 1,
          mb: 0.75,
        }}
      >
        <SpeedRow
          icon={<ArrowDownwardRounded />}
          color={`${paletteKey}.main`}
          value={stats.downSpeed}
        />
        <SpeedRow
          icon={<ArrowUpwardRounded />}
          color={`${paletteKey}.main`}
          value={stats.upSpeed}
        />
      </Box>

      {/* 累计总量 */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 1,
          pt: 0.75,
          borderTop: `1px dashed ${alpha(color, 0.25)}`,
        }}
      >
        <TotalLabel label={downloadedLabel} value={stats.downloadTotal} />
        <TotalLabel label={uploadedLabel} value={stats.uploadTotal} />
      </Box>
    </Box>
  )
}

const fallbackSx = {
  p: 2,
  minHeight: 200,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px dashed',
  borderColor: 'error.main',
  borderRadius: 2,
  bgcolor: 'error.light',
}

const reloadPage = () => window.location.reload()

const TrafficFallback = ({ error, resetErrorBoundary }: FallbackProps) => {
  const { t } = useTranslation()

  return (
    <Box sx={fallbackSx}>
      <ErrorOutlineRounded color="error" sx={{ fontSize: 48, mb: 2 }} />
      <Typography variant="h6" gutterBottom>
        {t('shared.feedback.errors.trafficStats')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('shared.feedback.errors.trafficStatsDescription')}
      </Typography>
      <Alert severity="error" sx={{ mb: 2, maxWidth: 400 }}>
        {error instanceof Error
          ? error.message
          : t('shared.feedback.errors.unknown')}
      </Alert>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button variant="contained" size="small" onClick={resetErrorBoundary}>
          {t('shared.actions.retry')}
        </Button>
        <Button variant="outlined" size="small" onClick={reloadPage}>
          {t('shared.actions.refreshPage')}
        </Button>
      </Box>
    </Box>
  )
}

export const EnhancedTrafficStats = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { verge } = useVerge()
  const trafficRef = useRef<EnhancedCanvasTrafficGraphRef>(null)
  const pageVisible = useVisibility()

  // 当前 Clash 模式（Rule, Global, Direct）
  const { data: currentMode } = useClashMode()

  // 是否显示流量图表
  const trafficGraph = verge?.traffic_graph ?? true

  const {
    response: { data: traffic },
  } = useTrafficData({ enabled: true })

  const {
    response: { data: connectionData },
  } = useConnectionData({ enabled: true })

  // 响应式订阅全局累计流量数据，跨页面切换后台持续常驻累加，不丢包、无二次渲染
  const accumulatedTotals = useAccumulatedTraffic()

  // 使用useMemo计算解析后的分类流量数据
  const trafficStats = useMemo(() => {
    let measuredProxyDown = 0
    let measuredProxyUp = 0
    let measuredDirectDown = 0
    let measuredDirectUp = 0
    let proxyActiveCount = 0
    let directActiveCount = 0

    const conns = connectionData?.activeConnections || []
    conns.forEach((conn) => {
      const isProxy = isThroughProxyNode(conn, currentMode)
      const dSpeed = conn.curDownload || 0
      const uSpeed = conn.curUpload || 0
      if (isProxy) {
        measuredProxyDown += dSpeed
        measuredProxyUp += uSpeed
        proxyActiveCount++
      } else {
        measuredDirectDown += dSpeed
        measuredDirectUp += uSpeed
        directActiveCount++
      }
    })

    const globalDown = traffic?.down || 0
    const globalUp = traffic?.up || 0

    let proxyDownSpeed: number
    let directDownSpeed: number
    let proxyUpSpeed: number
    let directUpSpeed: number

    // 直连模式：全部归属直连流量
    if (currentMode && currentMode.toLowerCase() === 'direct') {
      proxyDownSpeed = 0
      directDownSpeed = globalDown
      proxyUpSpeed = 0
      directUpSpeed = globalUp
    } else {
      // 实时下载速率：按实测速率比例分配，未测得明确代理流速时默认全部归直连
      const totalMeasuredDown = measuredProxyDown + measuredDirectDown
      if (totalMeasuredDown > 0 && globalDown > 0) {
        const ratio = measuredProxyDown / totalMeasuredDown
        proxyDownSpeed = globalDown * ratio
        directDownSpeed = globalDown * (1 - ratio)
      } else if (measuredProxyDown > 0) {
        proxyDownSpeed = globalDown
        directDownSpeed = 0
      } else if (measuredDirectDown > 0) {
        proxyDownSpeed = 0
        directDownSpeed = globalDown
      } else {
        if (proxyActiveCount > 0 && directActiveCount === 0) {
          proxyDownSpeed = globalDown
          directDownSpeed = 0
        } else {
          proxyDownSpeed = 0
          directDownSpeed = globalDown
        }
      }

      // 实时上传速率：按实测速率比例分配，未测得明确代理流速时默认全部归直连
      const totalMeasuredUp = measuredProxyUp + measuredDirectUp
      if (totalMeasuredUp > 0 && globalUp > 0) {
        const ratio = measuredProxyUp / totalMeasuredUp
        proxyUpSpeed = globalUp * ratio
        directUpSpeed = globalUp * (1 - ratio)
      } else if (measuredProxyUp > 0) {
        proxyUpSpeed = globalUp
        directUpSpeed = 0
      } else if (measuredDirectUp > 0) {
        proxyUpSpeed = 0
        directUpSpeed = globalUp
      } else {
        if (proxyActiveCount > 0 && directActiveCount === 0) {
          proxyUpSpeed = globalUp
          directUpSpeed = 0
        } else {
          proxyUpSpeed = 0
          directUpSpeed = globalUp
        }
      }
    }

    // 累计总量：双轨真实累加，并以各自实测比例校准至内核权威总流量，绝不发生减法截断为0
    const globalDownTotal = traffic?.downTotal || 0
    const globalUpTotal = traffic?.upTotal || 0

    const measuredDownTotal =
      accumulatedTotals.proxyDownTotal + accumulatedTotals.directDownTotal
    const measuredUpTotal =
      accumulatedTotals.proxyUpTotal + accumulatedTotals.directUpTotal

    let displayProxyDownTotal = accumulatedTotals.proxyDownTotal
    let displayDirectDownTotal = accumulatedTotals.directDownTotal
    let displayProxyUpTotal = accumulatedTotals.proxyUpTotal
    let displayDirectUpTotal = accumulatedTotals.directUpTotal

    if (measuredDownTotal > 0 && globalDownTotal > 0) {
      const proxyRatio = accumulatedTotals.proxyDownTotal / measuredDownTotal
      displayProxyDownTotal = globalDownTotal * proxyRatio
      displayDirectDownTotal = globalDownTotal * (1 - proxyRatio)
    } else if (globalDownTotal > 0) {
      displayProxyDownTotal = 0
      displayDirectDownTotal = globalDownTotal
    }

    if (measuredUpTotal > 0 && globalUpTotal > 0) {
      const proxyRatio = accumulatedTotals.proxyUpTotal / measuredUpTotal
      displayProxyUpTotal = globalUpTotal * proxyRatio
      displayDirectUpTotal = globalUpTotal * (1 - proxyRatio)
    } else if (globalUpTotal > 0) {
      displayProxyUpTotal = 0
      displayDirectUpTotal = globalUpTotal
    }

    const [proxyDownVal, proxyDownUnit] = parseTraffic(proxyDownSpeed)
    const [proxyUpVal, proxyUpUnit] = parseTraffic(proxyUpSpeed)
    const [proxyTotalDownVal, proxyTotalDownUnit] = parseTraffic(
      displayProxyDownTotal,
    )
    const [proxyTotalUpVal, proxyTotalUpUnit] =
      parseTraffic(displayProxyUpTotal)

    const [directDownVal, directDownUnit] = parseTraffic(directDownSpeed)
    const [directUpVal, directUpUnit] = parseTraffic(directUpSpeed)
    const [directTotalDownVal, directTotalDownUnit] = parseTraffic(
      displayDirectDownTotal,
    )
    const [directTotalUpVal, directTotalUpUnit] =
      parseTraffic(displayDirectUpTotal)

    return {
      proxy: {
        downSpeed: `${proxyDownVal} ${proxyDownUnit}/s`,
        upSpeed: `${proxyUpVal} ${proxyUpUnit}/s`,
        downloadTotal: `${proxyTotalDownVal} ${proxyTotalDownUnit}`,
        uploadTotal: `${proxyTotalUpVal} ${proxyTotalUpUnit}`,
        activeCount: proxyActiveCount,
      },
      direct: {
        downSpeed: `${directDownVal} ${directDownUnit}/s`,
        upSpeed: `${directUpVal} ${directUpUnit}/s`,
        downloadTotal: `${directTotalDownVal} ${directTotalDownUnit}`,
        uploadTotal: `${directTotalUpVal} ${directTotalUpUnit}`,
        activeCount: directActiveCount,
      },
    }
  }, [connectionData, traffic, currentMode, accumulatedTotals])

  // 渲染流量图表
  const trafficGraphComponent = useMemo(() => {
    if (!trafficGraph || !pageVisible) return null

    return (
      <Paper
        elevation={0}
        sx={{
          height: 130,
          cursor: 'pointer',
          border: `1px solid ${alpha(theme.palette.divider, 0.2)}`,
          borderRadius: 2,
          overflow: 'hidden',
        }}
        onClick={() => trafficRef.current?.toggleStyle()}
      >
        <div style={{ height: '100%', position: 'relative' }}>
          <EnhancedCanvasTrafficGraph ref={trafficRef} />
        </div>
      </Paper>
    )
  }, [trafficGraph, pageVisible, theme.palette.divider])

  return (
    <ErrorBoundary
      FallbackComponent={TrafficFallback}
      onError={(error, errorInfo) =>
        console.error('[EnhancedTrafficStats]', error, errorInfo)
      }
    >
      <Grid container spacing={1.5}>
        {trafficGraph && <Grid size={12}>{trafficGraphComponent}</Grid>}

        {/* 代理流量卡片 */}
        <Grid size={{ xs: 12, sm: 6 }}>
          <TrafficCard
            paletteKey="info"
            title={t('home.components.traffic.proxyTraffic', '代理流量')}
            stats={trafficStats.proxy}
            downloadedLabel={t('home.components.traffic.downloaded', '下载量')}
            uploadedLabel={t('home.components.traffic.uploaded', '上传量')}
          />
        </Grid>

        {/* 直连流量卡片 */}
        <Grid size={{ xs: 12, sm: 6 }}>
          <TrafficCard
            paletteKey="success"
            title={t('home.components.traffic.directTraffic', '直连流量')}
            stats={trafficStats.direct}
            downloadedLabel={t('home.components.traffic.downloaded', '下载量')}
            uploadedLabel={t('home.components.traffic.uploaded', '上传量')}
          />
        </Grid>
      </Grid>
    </ErrorBoundary>
  )
}
