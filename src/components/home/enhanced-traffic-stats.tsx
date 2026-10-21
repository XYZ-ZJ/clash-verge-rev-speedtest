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
const isThroughProxyNode = (
  conn: IConnectionsItem,
  mode?: string | null,
): boolean => {
  // 1. 直连模式下任何连接均不通过代理节点
  if (mode && mode.toLowerCase() === 'direct') {
    return false
  }

  // 2. 匹配规则明确为 DIRECT / REJECT 等内置策略
  if (conn.rule && NON_PROXY_KEYWORDS.has(conn.rule.trim().toUpperCase())) {
    return false
  }
  if (
    conn.rulePayload &&
    NON_PROXY_KEYWORDS.has(conn.rulePayload.trim().toUpperCase())
  ) {
    return false
  }

  // 3. 内核内部自用连接或 DNS 查询
  if (conn.metadata?.type && ['Inner', 'DNS'].includes(conn.metadata.type)) {
    return false
  }

  const chains = conn.chains
  // 4. 没有节点链路信息的连接不属于代理节点流量
  if (!chains || chains.length === 0) {
    return false
  }

  // 5. 链路上包含 DIRECT 或 REJECT 等字样（例如代理组选择了 DIRECT）
  if (chains.some((c) => NON_PROXY_KEYWORDS.has(c.trim().toUpperCase()))) {
    return false
  }

  // 6. 检查出口叶子节点（Mihomo chains[0] 为叶子节点）
  const exitNode = chains[0]?.trim()
  if (!exitNode || NON_PROXY_KEYWORDS.has(exitNode.toUpperCase())) {
    return false
  }

  return true
}

const STORAGE_KEY_PROXY_TOTALS = 'cv_proxy_traffic_accumulators'

interface StoredTrafficTotals {
  proxyDownTotal: number
  proxyUpTotal: number
  kernelDownTotal: number
  kernelUpTotal: number
}

const loadStoredTotals = () => {
  try {
    const raw =
      typeof window !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY_PROXY_TOTALS)
        : null
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        seen: new Map<string, { down: number; up: number }>(),
        proxyDownTotal: Number(parsed.proxyDownTotal) || 0,
        proxyUpTotal: Number(parsed.proxyUpTotal) || 0,
        lastKernelDownTotal: Number(parsed.kernelDownTotal) || 0,
        lastKernelUpTotal: Number(parsed.kernelUpTotal) || 0,
      }
    }
  } catch {
    // ignore
  }
  return {
    seen: new Map<string, { down: number; up: number }>(),
    proxyDownTotal: 0,
    proxyUpTotal: 0,
    lastKernelDownTotal: 0,
    lastKernelUpTotal: 0,
  }
}

export const EnhancedTrafficStats = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
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

  // 追踪连接生命周期中确凿属于代理节点的累计流量
  const trafficTrackerRef = useRef(loadStoredTotals())

  // 增量统计代理节点流量
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
      tracker.seen.clear()
    }
    tracker.lastKernelDownTotal = globalDownTotal
    tracker.lastKernelUpTotal = globalUpTotal

    allConns.forEach((conn) => {
      const isProxy = isThroughProxyNode(conn, currentMode)
      const curDown = conn.download || 0
      const curUp = conn.upload || 0
      const prev = tracker.seen.get(conn.id)

      if (isProxy) {
        if (!prev) {
          tracker.proxyDownTotal += curDown
          tracker.proxyUpTotal += curUp
        } else {
          const deltaDown = Math.max(0, curDown - prev.down)
          const deltaUp = Math.max(0, curUp - prev.up)
          tracker.proxyDownTotal += deltaDown
          tracker.proxyUpTotal += deltaUp
        }
      }
      tracker.seen.set(conn.id, { down: curDown, up: curUp })
    })

    // 防止长时间运行占用过多内存，修剪非活跃连接缓存
    if (tracker.seen.size > 2000) {
      const activeIds = new Set(allConns.map((c) => c.id))
      for (const id of tracker.seen.keys()) {
        if (!activeIds.has(id)) {
          tracker.seen.delete(id)
        }
      }
    }

    // 缓存至本地
    try {
      localStorage.setItem(
        STORAGE_KEY_PROXY_TOTALS,
        JSON.stringify({
          proxyDownTotal: tracker.proxyDownTotal,
          proxyUpTotal: tracker.proxyUpTotal,
          kernelDownTotal: globalDownTotal,
          kernelUpTotal: globalUpTotal,
        }),
      )
    } catch {
      // ignore
    }
  }, [connectionData, traffic, currentMode])

  // 计算代理与直连的实时速率和累计值
  const trafficStats = useMemo(() => {
    const activeConns = connectionData?.activeConnections || []
    let measuredProxyDown = 0
    let measuredProxyUp = 0
    let measuredDirectDown = 0
    let measuredDirectUp = 0
    let proxyActiveCount = 0
    let directActiveCount = 0

    activeConns.forEach((conn) => {
      const isProxy = isThroughProxyNode(conn, currentMode)
      const d = conn.curDownload || 0
      const u = conn.curUpload || 0
      if (isProxy) {
        measuredProxyDown += d
        measuredProxyUp += u
        proxyActiveCount += 1
      } else {
        measuredDirectDown += d
        measuredDirectUp += u
        directActiveCount += 1
      }
    })

    const globalDown = traffic?.down || 0
    const globalUp = traffic?.up || 0

    let proxyDownSpeed = 0
    let directDownSpeed = 0
    let proxyUpSpeed = 0
    let directUpSpeed = 0

    if (currentMode && currentMode.toLowerCase() === 'direct') {
      proxyDownSpeed = 0
      proxyUpSpeed = 0
      directDownSpeed = globalDown
      directUpSpeed = globalUp
    } else {
      // 实时下载速率：仅在有确切代理活跃连接产生速率时分摊至代理，其余全部归直连
      if (measuredProxyDown > 0 && measuredDirectDown > 0) {
        const ratio =
          measuredProxyDown / (measuredProxyDown + measuredDirectDown)
        proxyDownSpeed = globalDown * ratio
        directDownSpeed = globalDown * (1 - ratio)
      } else if (measuredProxyDown > 0) {
        proxyDownSpeed = globalDown
        directDownSpeed = 0
      } else if (measuredDirectDown > 0) {
        proxyDownSpeed = 0
        directDownSpeed = globalDown
      } else {
        // 未检测到明确代理流时，默认全部归直连
        if (proxyActiveCount > 0 && directActiveCount === 0) {
          proxyDownSpeed = globalDown
          directDownSpeed = 0
        } else {
          proxyDownSpeed = 0
          directDownSpeed = globalDown
        }
      }

      // 实时上传速率：仅在有确切代理活跃连接产生速率时分摊至代理，其余全部归直连
      if (measuredProxyUp > 0 && measuredDirectUp > 0) {
        const ratio =
          measuredProxyUp / (measuredProxyUp + measuredDirectUp)
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

    // 累计总量：代理卡只显示确凿通过代理节点的流量，直连卡显示除代理节点之外的所有流量
    const tracker = trafficTrackerRef.current
    const globalDownTotal = traffic?.downTotal || 0
    const globalUpTotal = traffic?.upTotal || 0

    const finalProxyDownTotal = Math.min(
      globalDownTotal,
      tracker.proxyDownTotal,
    )
    const finalProxyUpTotal = Math.min(globalUpTotal, tracker.proxyUpTotal)

    const finalDirectDownTotal = Math.max(
      0,
      globalDownTotal - finalProxyDownTotal,
    )
    const finalDirectUpTotal = Math.max(0, globalUpTotal - finalProxyUpTotal)

    const [proxyDownVal, proxyDownUnit] = parseTraffic(proxyDownSpeed)
    const [proxyUpVal, proxyUpUnit] = parseTraffic(proxyUpSpeed)
    const [proxyTotalDownVal, proxyTotalDownUnit] =
      parseTraffic(finalProxyDownTotal)
    const [proxyTotalUpVal, proxyTotalUpUnit] = parseTraffic(finalProxyUpTotal)

    const [directDownVal, directDownUnit] = parseTraffic(directDownSpeed)
    const [directUpVal, directUpUnit] = parseTraffic(directUpSpeed)
    const [directTotalDownVal, directTotalDownUnit] =
      parseTraffic(finalDirectDownTotal)
    const [directTotalUpVal, directTotalUpUnit] =
      parseTraffic(finalDirectUpTotal)

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
