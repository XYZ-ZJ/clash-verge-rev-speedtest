import {
  ArrowDownwardRounded,
  ArrowUpwardRounded,
} from '@mui/icons-material'
import {
  Box,
  Grid,
  Paper,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { TrafficErrorBoundary } from '@/components/shared/traffic-error-boundary'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useTrafficData } from '@/hooks/use-traffic-data'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import parseTraffic from '@/utils/parse-traffic'

import {
  EnhancedCanvasTrafficGraph,
  type EnhancedCanvasTrafficGraphRef,
} from './enhanced-canvas-traffic-graph'

const isDirectConnection = (conn: IConnectionsItem) => {
  const chains = conn.chains || []
  if (chains.some((c) => c.toUpperCase() === 'DIRECT')) return true
  if (conn.rule?.toUpperCase() === 'DIRECT') return true
  return false
}

export const EnhancedTrafficStats = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const { verge } = useVerge()
  const trafficRef = useRef<EnhancedCanvasTrafficGraphRef>(null)
  const pageVisible = useVisibility()

  // 是否显示流量图表
  const trafficGraph = verge?.traffic_graph ?? true

  const {
    response: { data: traffic },
  } = useTrafficData({ enabled: true })

  const {
    response: { data: connectionData },
  } = useConnectionData({ enabled: true })

  // 追踪连接生命周期的累计流量
  const trafficTrackerRef = useRef<{
    seen: Map<string, { down: number; up: number; isDirect: boolean }>
    proxyDownTotal: number
    proxyUpTotal: number
    directDownTotal: number
    directUpTotal: number
  }>({
    seen: new Map(),
    proxyDownTotal: 0,
    proxyUpTotal: 0,
    directDownTotal: 0,
    directUpTotal: 0,
  })

  // 增量累计连接流量数据
  useEffect(() => {
    if (!connectionData) return
    const tracker = trafficTrackerRef.current
    const activeConns = connectionData.activeConnections || []
    const closedConns = connectionData.closedConnections || []
    const allConns = [...activeConns, ...closedConns]

    allConns.forEach((conn) => {
      const prev = tracker.seen.get(conn.id)
      const isDirect = isDirectConnection(conn)
      const curDown = conn.download || 0
      const curUp = conn.upload || 0

      if (!prev) {
        if (isDirect) {
          tracker.directDownTotal += curDown
          tracker.directUpTotal += curUp
        } else {
          tracker.proxyDownTotal += curDown
          tracker.proxyUpTotal += curUp
        }
      } else {
        const deltaDown = Math.max(0, curDown - prev.down)
        const deltaUp = Math.max(0, curUp - prev.up)
        if (isDirect) {
          tracker.directDownTotal += deltaDown
          tracker.directUpTotal += deltaUp
        } else {
          tracker.proxyDownTotal += deltaDown
          tracker.proxyUpTotal += deltaUp
        }
      }
      tracker.seen.set(conn.id, { down: curDown, up: curUp, isDirect })
    })

    // 防止长时间运行占用过多内存，修剪非活跃历史记录
    if (tracker.seen.size > 2000) {
      const activeIds = new Set(allConns.map((c) => c.id))
      for (const id of tracker.seen.keys()) {
        if (!activeIds.has(id)) {
          tracker.seen.delete(id)
        }
      }
    }
  }, [connectionData])

  // 计算代理与直连的实时速率和累计值
  const trafficStats = useMemo(() => {
    const activeConns = connectionData?.activeConnections || []
    let proxySpeedDown = 0
    let proxySpeedUp = 0
    let directSpeedDown = 0
    let directSpeedUp = 0
    let proxyActiveCount = 0
    let directActiveCount = 0

    activeConns.forEach((conn) => {
      const isDirect = isDirectConnection(conn)
      const d = conn.curDownload || 0
      const u = conn.curUpload || 0
      if (isDirect) {
        directSpeedDown += d
        directSpeedUp += u
        directActiveCount += 1
      } else {
        proxySpeedDown += d
        proxySpeedUp += u
        proxyActiveCount += 1
      }
    })

    const globalDown = traffic?.down || 0
    const globalUp = traffic?.up || 0
    const totalSpeedDown = proxySpeedDown + directSpeedDown
    const totalSpeedUp = proxySpeedUp + directSpeedUp

    let finalProxyDown = proxySpeedDown
    let finalDirectDown = directSpeedDown
    let finalProxyUp = proxySpeedUp
    let finalDirectUp = directSpeedUp

    // 与 Mihomo /traffic 内核全局速率校准保持一致
    if (totalSpeedDown > 0 && globalDown > 0) {
      finalProxyDown = (proxySpeedDown / totalSpeedDown) * globalDown
      finalDirectDown = (directSpeedDown / totalSpeedDown) * globalDown
    } else if (globalDown > 0) {
      if (proxyActiveCount > 0 && directActiveCount === 0) finalProxyDown = globalDown
      else if (directActiveCount > 0 && proxyActiveCount === 0) finalDirectDown = globalDown
      else finalProxyDown = globalDown
    }

    if (totalSpeedUp > 0 && globalUp > 0) {
      finalProxyUp = (proxySpeedUp / totalSpeedUp) * globalUp
      finalDirectUp = (directSpeedUp / totalSpeedUp) * globalUp
    } else if (globalUp > 0) {
      if (proxyActiveCount > 0 && directActiveCount === 0) finalProxyUp = globalUp
      else if (directActiveCount > 0 && proxyActiveCount === 0) finalDirectUp = globalUp
      else finalProxyUp = globalUp
    }

    // 与 Mihomo /traffic 内核全局累计总量校准
    const tracker = trafficTrackerRef.current
    let pDownTotal = tracker.proxyDownTotal
    let dDownTotal = tracker.directDownTotal
    let pUpTotal = tracker.proxyUpTotal
    let dUpTotal = tracker.directUpTotal

    const globalDownTotal = traffic?.downTotal || 0
    const globalUpTotal = traffic?.upTotal || 0
    const measuredDownTotal = pDownTotal + dDownTotal
    const measuredUpTotal = pUpTotal + dUpTotal

    if (measuredDownTotal > 0 && globalDownTotal > 0) {
      pDownTotal = (pDownTotal / measuredDownTotal) * globalDownTotal
      dDownTotal = (dDownTotal / measuredDownTotal) * globalDownTotal
    } else if (globalDownTotal > 0 && measuredDownTotal === 0) {
      pDownTotal = globalDownTotal
    }

    if (measuredUpTotal > 0 && globalUpTotal > 0) {
      pUpTotal = (pUpTotal / measuredUpTotal) * globalUpTotal
      dUpTotal = (dUpTotal / measuredUpTotal) * globalUpTotal
    } else if (globalUpTotal > 0 && measuredUpTotal === 0) {
      pUpTotal = globalUpTotal
    }

    const [proxyDownVal, proxyDownUnit] = parseTraffic(finalProxyDown)
    const [proxyUpVal, proxyUpUnit] = parseTraffic(finalProxyUp)
    const [proxyTotalDownVal, proxyTotalDownUnit] = parseTraffic(pDownTotal)
    const [proxyTotalUpVal, proxyTotalUpUnit] = parseTraffic(pUpTotal)

    const [directDownVal, directDownUnit] = parseTraffic(finalDirectDown)
    const [directUpVal, directUpUnit] = parseTraffic(finalDirectUp)
    const [directTotalDownVal, directTotalDownUnit] = parseTraffic(dDownTotal)
    const [directTotalUpVal, directTotalUpUnit] = parseTraffic(dUpTotal)

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
  }, [connectionData, traffic])

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
    <TrafficErrorBoundary
      onError={(error, errorInfo) => {
        console.error('[EnhancedTrafficStats] 组件错误:', error, errorInfo)
      }}
    >
      <Grid container spacing={1.5} sx={{ width: '100%' }}>
        {trafficGraph && (
          <Grid size={12}>
            {trafficGraphComponent}
          </Grid>
        )}

        {/* 代理流量卡片 */}
        <Grid size={{ xs: 12, sm: 6 }}>
          <Paper
            elevation={0}
            sx={{
              p: 2,
              borderRadius: 2,
              bgcolor: isDark
                ? alpha(theme.palette.info.main, 0.08)
                : alpha(theme.palette.info.main, 0.04),
              border: `1px solid ${alpha(theme.palette.info.main, isDark ? 0.25 : 0.18)}`,
              transition: 'all 0.2s ease-in-out',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            {/* 卡片头部 */}
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: 'info.main',
                  mr: 1,
                  boxShadow: `0 0 6px ${theme.palette.info.main}`,
                  flexShrink: 0,
                }}
              />
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 700,
                  fontSize: '0.9375rem',
                  color: 'info.main',
                }}
              >
                {t('home.components.traffic.proxyTraffic', '代理流量')}
              </Typography>
            </Box>

            {/* 实时速率 */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 1,
                mb: 1.5,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                <ArrowDownwardRounded
                  sx={{
                    fontSize: 22,
                    color: 'info.main',
                    mr: 0.5,
                    flexShrink: 0,
                  }}
                />
                <Typography
                  variant="body1"
                  noWrap
                  sx={{
                    fontWeight: 700,
                    fontSize: '1.0625rem',
                    color: 'text.primary',
                  }}
                >
                  {trafficStats.proxy.downSpeed}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                <ArrowUpwardRounded
                  sx={{
                    fontSize: 22,
                    color: 'info.main',
                    mr: 0.5,
                    flexShrink: 0,
                  }}
                />
                <Typography
                  variant="body1"
                  noWrap
                  sx={{
                    fontWeight: 700,
                    fontSize: '1.0625rem',
                    color: 'text.primary',
                  }}
                >
                  {trafficStats.proxy.upSpeed}
                </Typography>
              </Box>
            </Box>

            {/* 累计总量 */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 1,
                pt: 1,
                borderTop: `1px dashed ${alpha(theme.palette.info.main, 0.2)}`,
              }}
            >
              <Typography variant="caption" color="text.secondary" noWrap>
                {t('home.components.traffic.downloaded', '下载量')}{' '}
                <Box
                  component="span"
                  sx={{ color: 'text.primary', fontWeight: 500 }}
                >
                  {trafficStats.proxy.downloadTotal}
                </Box>
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {t('home.components.traffic.uploaded', '上传量')}{' '}
                <Box
                  component="span"
                  sx={{ color: 'text.primary', fontWeight: 500 }}
                >
                  {trafficStats.proxy.uploadTotal}
                </Box>
              </Typography>
            </Box>
          </Paper>
        </Grid>

        {/* 直连流量卡片 */}
        <Grid size={{ xs: 12, sm: 6 }}>
          <Paper
            elevation={0}
            sx={{
              p: 2,
              borderRadius: 2,
              bgcolor: isDark
                ? alpha(theme.palette.success.main, 0.08)
                : alpha(theme.palette.success.main, 0.04),
              border: `1px solid ${alpha(theme.palette.success.main, isDark ? 0.25 : 0.18)}`,
              transition: 'all 0.2s ease-in-out',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
          >
            {/* 卡片头部 */}
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: 'success.main',
                  mr: 1,
                  boxShadow: `0 0 6px ${theme.palette.success.main}`,
                  flexShrink: 0,
                }}
              />
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 700,
                  fontSize: '0.9375rem',
                  color: 'success.main',
                }}
              >
                {t('home.components.traffic.directTraffic', '直连流量')}
              </Typography>
            </Box>

            {/* 实时速率 */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 1,
                mb: 1.5,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                <ArrowDownwardRounded
                  sx={{
                    fontSize: 22,
                    color: 'success.main',
                    mr: 0.5,
                    flexShrink: 0,
                  }}
                />
                <Typography
                  variant="body1"
                  noWrap
                  sx={{
                    fontWeight: 700,
                    fontSize: '1.0625rem',
                    color: 'text.primary',
                  }}
                >
                  {trafficStats.direct.downSpeed}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                <ArrowUpwardRounded
                  sx={{
                    fontSize: 22,
                    color: 'success.main',
                    mr: 0.5,
                    flexShrink: 0,
                  }}
                />
                <Typography
                  variant="body1"
                  noWrap
                  sx={{
                    fontWeight: 700,
                    fontSize: '1.0625rem',
                    color: 'text.primary',
                  }}
                >
                  {trafficStats.direct.upSpeed}
                </Typography>
              </Box>
            </Box>

            {/* 累计总量 */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 1,
                pt: 1,
                borderTop: `1px dashed ${alpha(theme.palette.success.main, 0.2)}`,
              }}
            >
              <Typography variant="caption" color="text.secondary" noWrap>
                {t('home.components.traffic.downloaded', '下载量')}{' '}
                <Box
                  component="span"
                  sx={{ color: 'text.primary', fontWeight: 500 }}
                >
                  {trafficStats.direct.downloadTotal}
                </Box>
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {t('home.components.traffic.uploaded', '上传量')}{' '}
                <Box
                  component="span"
                  sx={{ color: 'text.primary', fontWeight: 500 }}
                >
                  {trafficStats.direct.uploadTotal}
                </Box>
              </Typography>
            </Box>
          </Paper>
        </Grid>
      </Grid>
    </TrafficErrorBoundary>
  )
}
