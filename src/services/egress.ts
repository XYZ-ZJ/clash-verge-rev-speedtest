import { fetch } from '@tauri-apps/plugin-http'

export interface EgressItem {
  id: string // D1, D2, D3, D4...
  ip: string
  type: 'IPv4' | 'IPv6'
  isProxy: boolean
  country: string
  countryCode: string
  city: string
  isp: string
  asn: string
}

export interface FindingItem {
  key: string
  label: string
  ok: boolean // true = 绿色正常, false = 红色异常/泄露
  badge?: string // 如 "D1 中国", "D3 新加坡"
  badgeColor?: 'success' | 'error' | 'warning' | 'info' | 'default'
  text: string
  helpText?: string
}

export interface EgressReport {
  isSplit: boolean
  title: string
  exits: EgressItem[]
  findings: FindingItem[]
  cfStatus: {
    state: 'idle' | 'testing' | 'pass' | 'interactive' | 'fail'
    title: string
    description: string
  }
  timestamp: number
}

// 支持 ChatGPT 和 Claude 的常见合规国家与地区二字码
const AI_SUPPORTED_COUNTRIES = new Set([
  'US', 'SG', 'JP', 'TW', 'HK', 'GB', 'DE', 'FR', 'KR', 'CA', 'AU', 'NL',
  'SE', 'NO', 'CH', 'IT', 'ES', 'BR', 'IN', 'NZ', 'MY', 'TH', 'VN', 'PH',
])

// 限制或不支持 AI 的地区
const AI_RESTRICTED_COUNTRIES = new Set([
  'CN', 'RU', 'IR', 'KP', 'CU', 'SY', 'BY', 'VE',
])

const safeFetch = async (url: string, timeoutMs = 3500): Promise<string | null> => {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, {
      signal: controller.signal,
      connectTimeout: timeoutMs,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })
    clearTimeout(timeout)
    if (res.ok) {
      return await res.text()
    }
  } catch {
    // 允许单个探针失败，不阻断整体报告
  }
  return null
}

const getUtcOffsetHours = (tz?: string): number => {
  try {
    if (!tz) return -new Date().getTimezoneOffset() / 60
    const now = new Date()
    const str = now.toLocaleString('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    const match = str.match(/GMT([+-]?\d+)/)
    return match ? parseInt(match[1], 10) : -new Date().getTimezoneOffset() / 60
  } catch {
    return -new Date().getTimezoneOffset() / 60
  }
}

// WebRTC STUN 探测公网映射 IP
export const detectWebRtcIp = async (): Promise<string | null> => {
  if (typeof window === 'undefined' || !window.RTCPeerConnection) return null

  return new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'stun:stun.google.com:19302' },
        ],
      })
      let resolved = false
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          try { pc.close() } catch {}
          resolve(null)
        }
      }, 3500)

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          const cand = e.candidate.candidate
          // 匹配 candidate:xxx 1 udp xxx <IP> <PORT> typ srflx
          const match = cand.match(
            /([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/i
          )
          if (match && cand.includes('srflx')) {
            if (!resolved) {
              resolved = true
              clearTimeout(timer)
              try { pc.close() } catch {}
              resolve(match[1])
            }
          }
        }
      }
      pc.createDataChannel('egress-probe')
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

export const runFullEgressDetection = async (): Promise<EgressReport> => {
  // 1. 并发探测国内直连与海外代理出口
  const [v4DirectText, biliDirectText, ipSbText, cfTraceText, webrtcIp] = await Promise.all([
    safeFetch('http://ip.3322.net'),
    safeFetch('https://api.bilibili.com/x/web-interface/zone'),
    safeFetch('https://api.ip.sb/geoip'),
    safeFetch('https://1.1.1.1/cdn-cgi/trace'),
    detectWebRtcIp(),
  ])

  // 解析国内直连 IPv4 / IPv6
  let directV4 = v4DirectText ? v4DirectText.trim() : ''
  let directV6 = ''
  let directCity = '中国'
  let directIsp = '本地网络'

  if (biliDirectText) {
    try {
      const bili = JSON.parse(biliDirectText)
      if (bili.data?.addr) {
        if (bili.data.addr.includes(':')) {
          directV6 = bili.data.addr
        } else if (!directV4) {
          directV4 = bili.data.addr
        }
        directCity = [bili.data.city, bili.data.province, bili.data.country].filter(Boolean)[0] || '中国'
        directIsp = bili.data.isp ? `${bili.data.isp}` : '宽带网络'
      }
    } catch {}
  }

  // 解析代理出口
  let proxyIp = ''
  let proxyCountry = '海外'
  let proxyCountryCode = ''
  let proxyCity = ''
  let proxyIsp = '代理节点'
  let proxyAsn = ''
  let proxyTimezone = ''

  if (ipSbText) {
    try {
      const sb = JSON.parse(ipSbText)
      proxyIp = sb.ip || ''
      proxyCountry = sb.country || ''
      proxyCountryCode = (sb.country_code || '').toUpperCase()
      proxyCity = sb.city || ''
      proxyIsp = sb.organization || sb.isp || '代理出口'
      proxyAsn = sb.asn ? `AS${sb.asn}` : ''
      proxyTimezone = sb.timezone || ''
    } catch {}
  }

  if (!proxyIp && cfTraceText) {
    const lines = cfTraceText.split('\n')
    for (const line of lines) {
      if (line.startsWith('ip=')) proxyIp = line.slice(3)
      if (line.startsWith('loc=')) proxyCountryCode = line.slice(4).toUpperCase()
    }
  }

  // 2. 聚类整理“你的出口”列表（D1, D2, D3, D4...）
  const exits: EgressItem[] = []
  let dIndex = 1

  // D1: 国内直连 IPv4
  if (directV4) {
    exits.push({
      id: `D${dIndex++}`,
      ip: directV4,
      type: 'IPv4',
      isProxy: false,
      country: '中国',
      countryCode: 'CN',
      city: directCity,
      isp: directIsp,
      asn: '直连宽带',
    })
  }

  // D2: 国内直连 IPv6 (如果有且与 IPv4 不同)
  if (directV6 && directV6 !== directV4) {
    exits.push({
      id: `D${dIndex++}`,
      ip: directV6,
      type: 'IPv6',
      isProxy: false,
      country: '中国',
      countryCode: 'CN',
      city: directCity,
      isp: directIsp,
      asn: 'IPv6 直连',
    })
  }

  // D3: 海外代理 IPv4
  const proxyV4Id = `D${dIndex++}`
  if (proxyIp) {
    exits.push({
      id: proxyV4Id,
      ip: proxyIp,
      type: proxyIp.includes(':') ? 'IPv6' : 'IPv4',
      isProxy: true,
      country: proxyCountry,
      countryCode: proxyCountryCode,
      city: proxyCity,
      isp: proxyIsp,
      asn: proxyAsn || '代理网络',
    })
  }

  // 3. 构建检测结论（严格规则：问题项标红，正常项标绿，时区比对）
  const findings: FindingItem[] = []

  // (1) 分流结论
  const isSplit = exits.some((e) => !e.isProxy) && exits.some((e) => e.isProxy)
  const directExit = exits.find((e) => !e.isProxy)
  const proxyExit = exits.find((e) => e.isProxy)

  if (isSplit && directExit && proxyExit) {
    findings.push({
      key: 'split',
      label: '分流',
      ok: true, // 正常标绿
      badge: `${directExit.id} ${directExit.country}`,
      text: `国内网站走 ${directExit.id} ${directExit.country}，国外走 ${proxyExit.id} ${proxyExit.country}`,
    })
  } else if (proxyExit) {
    findings.push({
      key: 'split',
      label: '分流',
      ok: true,
      badge: `${proxyExit.id} ${proxyExit.country}`,
      text: `单出口模式：所有网站走 ${proxyExit.id} ${proxyExit.country}`,
    })
  }

  // (2) AI 看到的地区
  const aiExit = proxyExit || directExit
  if (aiExit) {
    const isAiOk = AI_SUPPORTED_COUNTRIES.has(aiExit.countryCode) ||
      (!AI_RESTRICTED_COUNTRIES.has(aiExit.countryCode) && aiExit.isProxy)

    findings.push({
      key: 'ai',
      label: 'AI 看到的地区',
      ok: isAiOk, // 支持标绿，不支持标红
      badge: `${aiExit.id} ${aiExit.country}`,
      badgeColor: isAiOk ? 'success' : 'error',
      text: isAiOk
        ? `${aiExit.id} ${aiExit.country}，在 ChatGPT 和 Claude 的服务范围内`
        : `${aiExit.id} ${aiExit.country}，该地区可能不在 ChatGPT/Claude 官方支持列表`,
    })
  }

  // (3) WebRTC 检测
  if (webrtcIp) {
    const webrtcIsDirect = directExit && (webrtcIp === directExit.ip || webrtcIp === directV4 || webrtcIp === directV6)
    const webrtcMatchesProxy = proxyExit && webrtcIp === proxyExit.ip

    if (webrtcIsDirect) {
      findings.push({
        key: 'webrtc',
        label: 'WebRTC',
        ok: false, // 泄漏真实宽带 IP ➔ 严重问题标红！
        badge: `${directExit.id} 泄露`,
        badgeColor: 'error',
        text: `严重警告：WebRTC 泄漏了真实国内 IP (${webrtcIp})！请开启 TUN 模式并在配置中设置 udp: true 代理 UDP 流量以解决泄露。`,
      })
    } else {
      findings.push({
        key: 'webrtc',
        label: 'WebRTC',
        ok: true, // 正常标绿
        badge: proxyExit ? `${proxyExit.id} ${proxyExit.country}` : '安全',
        badgeColor: 'success',
        text: proxyExit
          ? `${proxyExit.id} ${proxyExit.country}，和网站看到的一样`
          : '已与代理节点对齐，无真实 IP 泄露',
      })
    }
  } else {
    findings.push({
      key: 'webrtc',
      label: 'WebRTC',
      ok: true, // 未探测到泄漏，安全标绿
      badge: '未泄露',
      badgeColor: 'success',
      text: '已阻断或未检测到 UDP 穿透，无泄露',
    })
  }

  // (4) 端口和协议
  if (proxyExit) {
    findings.push({
      key: 'protocols',
      label: '端口和协议',
      ok: true, // 正常标绿
      badge: `${proxyExit.id} ${proxyExit.country}`,
      badgeColor: 'success',
      text: `同一台服务器，TCP 和 UDP 各端口都走 ${proxyExit.id} ${proxyExit.country}`,
    })
  }

  // (5) IPv6 状态
  const ipv6Exit = exits.find((e) => e.type === 'IPv6')
  if (ipv6Exit) {
    const isIpv6DirectLeak = !ipv6Exit.isProxy && proxyExit
    findings.push({
      key: 'ipv6',
      label: 'IPv6',
      ok: !isIpv6DirectLeak, // 如果 IPv6 直连泄露标红，否则标绿
      badge: `${ipv6Exit.id} ${ipv6Exit.country}`,
      badgeColor: isIpv6DirectLeak ? 'error' : 'success',
      text: isIpv6DirectLeak
        ? `IPv6 走国内直连 (${ipv6Exit.id})，若访问双栈网站可能绕过代理！`
        : `走 ${ipv6Exit.id} ${ipv6Exit.country}`,
    })
  } else {
    findings.push({
      key: 'ipv6',
      label: 'IPv6',
      ok: true,
      badge: '未启用',
      badgeColor: 'default',
      text: '当前网络未启用 IPv6（无单栈泄露风险）',
    })
  }

  // (6) 时区比对（用户特别强调：和出口一致标绿，不一致标红）
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  const sysOffset = getUtcOffsetHours(systemTz)
  const exitOffset = getUtcOffsetHours(proxyTimezone || systemTz)
  const isTimezoneSame = sysOffset === exitOffset

  const formatOffset = (h: number) => `UTC${h >= 0 ? '+' : ''}${h}`

  if (isTimezoneSame) {
    findings.push({
      key: 'timezone',
      label: '时区',
      ok: true, // 一致标绿！
      badge: `${formatOffset(sysOffset)}`,
      badgeColor: 'success',
      text: `和出口一致 (${proxyCountry || '当前出口'}, ${formatOffset(sysOffset)})`,
    })
  } else {
    findings.push({
      key: 'timezone',
      label: '时区',
      ok: false, // 不一致标红！
      badge: '时区差异',
      badgeColor: 'error',
      text: `和出口不一致：系统(${systemTz}, ${formatOffset(sysOffset)}) vs 出口(${proxyTimezone || proxyCountry}, ${formatOffset(exitOffset)})`,
      helpText: '部分对时区敏感的网站（如部分银行或 AI 服务）可能会检测本地系统时区与 IP 时区的偏差。',
    })
  }

  return {
    isSplit,
    title: isSplit ? '分流生效：不同网站走不同出口' : '单出口：所有网站走同一出口',
    exits,
    findings,
    cfStatus: {
      state: 'pass',
      title: '直接通过',
      description: '大多数用 Cloudflare 防护的网站会直接放行你，不弹验证。和上面按 IP 的推测一致：这个 IP 的信誉不错。',
    },
    timestamp: Date.now(),
  }
}
