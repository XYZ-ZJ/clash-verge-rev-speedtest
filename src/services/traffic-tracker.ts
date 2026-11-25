import { useSyncExternalStore } from 'react'

export const NON_PROXY_KEYWORDS = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
  'DNS',
])

export interface ConnectionDataInput {
  activeConnections?: IConnectionsItem[]
  closedConnections?: IConnectionsItem[]
}

export interface TrafficInput {
  up?: number
  down?: number
  upTotal?: number
  downTotal?: number
}

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
  if (
    chains.some((c: string) => NON_PROXY_KEYWORDS.has(c.trim().toUpperCase()))
  ) {
    return false
  }

  // 5. 检查出口叶子节点（Mihomo chains[0] 为叶子节点）
  const exitNode = chains[0]?.trim()
  if (!exitNode || NON_PROXY_KEYWORDS.has(exitNode.toUpperCase())) {
    return false
  }

  return true
}

export interface AccumulatedTotals {
  proxyDownTotal: number
  proxyUpTotal: number
  directDownTotal: number
  directUpTotal: number
}

class TrafficTrackerStore {
  initialized = false
  proxyDownTotal = 0
  proxyUpTotal = 0
  directDownTotal = 0
  directUpTotal = 0
  lastKernelDownTotal = 0
  lastKernelUpTotal = 0
  seen = new Map<string, { down: number; up: number }>()

  private listeners = new Set<() => void>()
  private snapshot: AccumulatedTotals = {
    proxyDownTotal: 0,
    proxyUpTotal: 0,
    directDownTotal: 0,
    directUpTotal: 0,
  }

  getSnapshot = (): AccumulatedTotals => {
    return this.snapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify() {
    this.snapshot = {
      proxyDownTotal: this.proxyDownTotal,
      proxyUpTotal: this.proxyUpTotal,
      directDownTotal: this.directDownTotal,
      directUpTotal: this.directUpTotal,
    }
    this.listeners.forEach((l) => l())
  }

  update(
    connectionData: ConnectionDataInput | undefined,
    traffic: TrafficInput | undefined,
    currentMode: string | null | undefined,
  ) {
    if (!connectionData || !currentMode) return

    const activeConns = connectionData.activeConnections || []
    const closedConns = connectionData.closedConnections || []
    const allConns = [...activeConns, ...closedConns]

    const globalDownTotal = traffic?.downTotal || 0
    const globalUpTotal = traffic?.upTotal || 0
    const isTransientZeroFallback =
      globalDownTotal === 0 &&
      globalUpTotal === 0 &&
      (traffic?.up || 0) === 0 &&
      (traffic?.down || 0) === 0 &&
      allConns.some((c) => this.seen.has(c.id))

    // 仅在真实内核计数回落且非瞬断 FALLBACK_TRAFFIC 心跳时重置累计值
    if (
      this.initialized &&
      !isTransientZeroFallback &&
      (globalDownTotal < this.lastKernelDownTotal ||
        globalUpTotal < this.lastKernelUpTotal)
    ) {
      this.proxyDownTotal = 0
      this.proxyUpTotal = 0
      this.directDownTotal = 0
      this.directUpTotal = 0
      this.seen.clear()
      this.initialized = false
    }
    if (!isTransientZeroFallback) {
      this.lastKernelDownTotal = globalDownTotal
      this.lastKernelUpTotal = globalUpTotal
    }

    let changed = false

    // 首次加载建立已有连接的基准数据，防止重复累加历史存量
    if (!this.initialized) {
      this.initialized = true
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
        this.seen.set(conn.id, { down: d, up: u })
      })

      this.proxyDownTotal = initProxyDown
      this.proxyUpTotal = initProxyUp
      this.directDownTotal = initDirectDown
      this.directUpTotal = initDirectUp
      this.notify()
      return
    }

    // 后续仅增量统计 delta 流量
    allConns.forEach((conn) => {
      const isProxy = isThroughProxyNode(conn, currentMode)
      const curDown = conn.download || 0
      const curUp = conn.upload || 0
      const prev = this.seen.get(conn.id)

      if (!prev) {
        if (curDown > 0 || curUp > 0) {
          changed = true
          if (isProxy) {
            this.proxyDownTotal += curDown
            this.proxyUpTotal += curUp
          } else {
            this.directDownTotal += curDown
            this.directUpTotal += curUp
          }
        }
      } else {
        const deltaDown = Math.max(0, curDown - prev.down)
        const deltaUp = Math.max(0, curUp - prev.up)
        if (deltaDown > 0 || deltaUp > 0) {
          changed = true
          if (isProxy) {
            this.proxyDownTotal += deltaDown
            this.proxyUpTotal += deltaUp
          } else {
            this.directDownTotal += deltaDown
            this.directUpTotal += deltaUp
          }
        }
      }
      this.seen.set(conn.id, { down: curDown, up: curUp })
    })

    // 定期清理已关闭且不在活跃列表中的连接缓存，避免无限膨胀
    if (this.seen.size > 2000) {
      const activeIds = new Set(allConns.map((c) => c.id))
      for (const id of this.seen.keys()) {
        if (!activeIds.has(id)) {
          this.seen.delete(id)
        }
      }
    }

    if (changed) {
      this.notify()
    }
  }
}

export const globalTrafficTracker = new TrafficTrackerStore()

export const useAccumulatedTraffic = (): AccumulatedTotals => {
  return useSyncExternalStore(
    globalTrafficTracker.subscribe,
    globalTrafficTracker.getSnapshot,
  )
}
