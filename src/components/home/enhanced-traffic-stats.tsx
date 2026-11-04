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
import { cloneElement, useEffect, useMemo, useRef } from 'react'
import { ErrorBoundary, FallbackProps } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'

import { useClashMode } from '@/hooks/use-clash'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import parseTraffic from '@/utils/parse-traffic'

import {
  EnhancedCanvasTrafficGraph,
  type EnhancedCanvasTrafficGraphRef,
} from './enhanced-canvas-traffic-graph'

const NON_PROXY_KEYWORDS = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
  'DNS',
])

/**
 * 严格判断连接是否真正经由代理节点转发
 * 只有具备实际出海代理节点链路的连接才认定为代理连接，其余均认定为直连/外部流量
 */
export const isThroughProxyNode = (
  conn: IConnectionsItem,
  mode?: string | null,
): boolean => {
  // 1. 直连模式下任何连接均不通过代理节点
  if (mode && mode.toLowerCase() === 'direct') {
    return false
  }

  // 注：mihomo 连接对象中 `rule` 是规则类型（如 DomainSuffix/GeoIP/Match），
  // `rulePayload` 是匹配的域名/IP；出站策略只出现在 `chains` 里，因此无需
  // （也无法）通过 rule 字段判断直连，下面的 chains 与 metadata 检查已覆盖。

  // 2. 内核内部自用连接或 DNS 查询
  if (conn.metadata?.type && ['Inner', 'DNS'].includes(conn.metadata.type)) {
    return false
  }

  const chains = conn.chains
  // 3. 没有节点链路信息的连接不属于代理节点流量
  if (!chains || chains.length === 0) {
    return false
  }

  // 4. 链路上包含 DIRECT 或 REJECT 等字样（例如代理组选择了 DIRECT）
  if (chains.some((c) => NON_PROXY_KEYWORDS.has(c.trim().toUpperCase()))) {
    return false
  }

  // 5. 检查出口叶子节点（Mihomo chains[0] 为叶子节点）
  const exitNode = chains[0]?.trim()
  if (!exitNode || NON_PROXY_KEYWORDS.has(exitNode.toUpperCase())) {
    return false
  }

  return true
}

// 初始状态生成器
const createInitialTracker = () => ({
  initialized: false,
  proxyDownTotal: 0,
  proxyUpTotal: 0,
  directDownTotal: 0,
  directUpTotal: 0,
  lastKernelDownTotal: 0,
  lastKernelUpTotal: 0,
  seen: new Map<string, { down: number; up: number }>(),
})

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
    {cloneElement(icon, { sx: { fontSize: 18, color, mr: 0.5, flexShrink: 0 } })}
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

  // 追踪连接生命周期中代理与直连的累计流量
  const trafficTrackerRef = useRef(createInitialTracker())

  // 增量统计代理与直连流量
  useEffect(() => {
    if (!connectionData) return
    const tracker = trafficTrackerRef.current
    const activeConns = connectionData.activeConnections || []
    const closedConns = connectionData.closedConnections || []
    const allConns = [...activeConns, ...closedConns]

    const globalDownTotal = traffic?.downTotal || 0
    const globalUpTotal = traffic?.upTotal || 0

    // 检测到内核重启，重置累计值
    if (
      globalDownTotal < tracker.lastKernelDownTotal ||
      globalUpTotal < tracker.lastKernelUpTotal
    ) {
      tracker.proxyDownTotal = 0
      tracker.proxyUpTotal = 0
      tracker.directDownTotal = 0
      tracker.directUpTotal = 0
      tracker.seen.clear()
      tracker.initialized = false
    }
    tracker.lastKernelDownTotal = globalDownTotal
    tracker.lastKernelUpTotal = globalUpTotal

    // 首次加载建立已有连接的基准数据，防止重复累加历史存量
    if (!tracker.initialized) {
      tracker.initialized = true
      let initProxyDown = 0
      let initProxyUp = 0
      let initDirectDown = 0
      let initDirectUp = 0

      allConns.forEach((conn) => {
        const isProxy = isThroughProxyNode(conn, currentMode)
        const d = conn.download || 0
        const u = conn.upload || 0
        if (isProxy) {
          initProxyDown += d
          initProxyUp += u
        } else {
          initDirectDown += d
          initDirectUp += u
        }
        tracker.seen.set(conn.id, { down: d, up: u })
      })

      tracker.proxyDownTotal = initProxyDown
      tracker.proxyUpTotal = initProxyUp
      tracker.directDownTotal = initDirectDown
      tracker.directUpTotal = initDirectUp
      return
    }

    // 后续仅增量统计 delta 流量
    allConns.forEach((conn) => {
      const isProxy = isThroughProxyNode(conn, currentMode)
      const curDown = conn.download || 0
      const curUp = conn.upload || 0
      const prev = tracker.seen.get(conn.id)

      if (!prev) {
        if (isProxy) {
          tracker.proxyDownTotal += curDown
          tracker.proxyUpTotal += curUp
        } else {
          tracker.directDownTotal += curDown
          tracker.directUpTotal += curUp
        }
      } else {
        const deltaDown = Math.max(0, curDown - prev.down)
        const deltaUp = Math.max(0, curUp - prev.up)
        if (isProxy) {
          tracker.proxyDownTotal += deltaDown
          tracker.proxyUpTotal += deltaUp
        } else {
          tracker.directDownTotal += deltaDown
          tracker.directUpTotal += deltaUp
        }
      }
      tracker.seen.set(conn.id, { down: curDown, up: curUp })
    })

    // 定期清理已关闭且不在活跃列表中的连接缓存，避免无限膨胀
    if (tracker.seen.size > 2000) {
      const activeIds = new Set(allConns.map((c) => c.id))
      for (const id of tracker.seen.keys()) {
        if (!activeIds.has(id)) {
          tracker.seen.delete(id)
        }
      }
    }
  }, [connectionData, traffic, currentMode])

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

    let proxyDownSpeed = 0
    let directDownSpeed = 0
    let proxyUpSpeed = 0
    let directUpSpeed = 0

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
    const tracker = trafficTrackerRef.current
    const globalDownTotal = traffic?.downTotal || 0
    const globalUpTotal = traffic?.upTotal || 0

    const measuredDownTotal =
      tracker.proxyDownTotal + tracker.directDownTotal
    const measuredUpTotal = tracker.proxyUpTotal + tracker.directUpTotal

    let displayProxyDownTotal = tracker.proxyDownTotal
    let displayDirectDownTotal = tracker.directDownTotal
    let displayProxyUpTotal = tracker.proxyUpTotal
    let displayDirectUpTotal = tracker.directUpTotal

    if (measuredDownTotal > 0 && globalDownTotal > 0) {
      const proxyRatio = tracker.proxyDownTotal / measuredDownTotal
      displayProxyDownTotal = globalDownTotal * proxyRatio
      displayDirectDownTotal = globalDownTotal * (1 - proxyRatio)
    } else if (globalDownTotal > 0) {
      displayProxyDownTotal = 0
      displayDirectDownTotal = globalDownTotal
    }

    if (measuredUpTotal > 0 && globalUpTotal > 0) {
      const proxyRatio = tracker.proxyUpTotal / measuredUpTotal
      displayProxyUpTotal = globalUpTotal * proxyRatio
      displayDirectUpTotal = globalUpTotal * (1 - proxyRatio)
    } else if (globalUpTotal > 0) {
      displayProxyUpTotal = 0
      displayDirectUpTotal = globalUpTotal
    }

    const [proxyDownVal, proxyDownUnit] = parseTraffic(proxyDownSpeed)
    const [proxyUpVal, proxyUpUnit] = parseTraffic(proxyUpSpeed)
    const [proxyTotalDownVal, proxyTotalDownUnit] =
      parseTraffic(displayProxyDownTotal)
    const [proxyTotalUpVal, proxyTotalUpUnit] =
      parseTraffic(displayProxyUpTotal)

    const [directDownVal, directDownUnit] = parseTraffic(directDownSpeed)
    const [directUpVal, directUpUnit] = parseTraffic(directUpSpeed)
    const [directTotalDownVal, directTotalDownUnit] =
      parseTraffic(displayDirectDownTotal)
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
  }, [connectionData, traffic, currentMode])

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
        {trafficGraph && (
          <Grid size={12}>
            {trafficGraphComponent}
          </Grid>
        )}

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
