import { getName, getVersion } from '@tauri-apps/api/app'
import { fetch } from '@tauri-apps/plugin-http'
import { asyncRetry } from 'foxts/async-retry'
import { extractErrorMessage } from 'foxts/extract-error-message'
import { once } from 'foxts/once'
import i18n from 'i18next'

import { debugLog } from '@/utils/debug'

const getUserAgentPromise = once(async () => {
  try {
    const [name, version] = await Promise.all([getName(), getVersion()])
    return `${name}/${version}`
  } catch (error) {
    console.debug('Failed to build User-Agent, fallback to default', error)
    return 'clash-verge-rev'
  }
})
// IP 风控信息定义
export interface RiskInfo {
  score: number
  level: 'low' | 'medium' | 'high'
  type: 'datacenter' | 'residential' | 'mobile' | 'business' | 'unknown'
  isProxy?: boolean
  isVpn?: boolean
  isTor?: boolean
  isAbuser?: boolean
}

// 启发式风控与风险等级计算
export function calculateRiskInfo(params: {
  isDatacenter?: boolean
  isVpn?: boolean
  isProxy?: boolean
  isTor?: boolean
  isAbuser?: boolean
  isMobile?: boolean
  type?: RiskInfo['type']
  organization?: string
  asnOrg?: string
}): RiskInfo {
  let type: RiskInfo['type'] = params.type || 'unknown'
  const orgText = `${params.organization || ''} ${params.asnOrg || ''}`.toLowerCase()

  if (type === 'unknown') {
    if (params.isMobile) {
      type = 'mobile'
    } else if (params.isDatacenter) {
      type = 'datacenter'
    } else if (
      /hosting|datacenter|data\s*centre|vps|cloud|server|compute|dedicated|cdn|asn|network|telecom|infrastructure/i.test(
        orgText,
      )
    ) {
      type = 'datacenter'
    } else if (
      /broadband|telecom|fiber|cable|dsl|residential|consumer/i.test(orgText)
    ) {
      type = 'residential'
    }
  }

  let score = 5
  if (type === 'datacenter') {
    score += 35
  } else if (type === 'business') {
    score += 15
  } else if (type === 'residential' || type === 'mobile') {
    score = 5
  }

  if (params.isProxy) score += 25
  if (params.isVpn) score += 20
  if (params.isTor) score += 40
  if (params.isAbuser) score += 40

  score = Math.min(100, Math.max(0, score))

  let level: RiskInfo['level'] = 'low'
  if (score >= 65) {
    level = 'high'
  } else if (score >= 25) {
    level = 'medium'
  } else {
    level = 'low'
  }

  return {
    score,
    level,
    type,
    isProxy: params.isProxy,
    isVpn: params.isVpn,
    isTor: params.isTor,
    isAbuser: params.isAbuser,
  }
}

// Get current IP and geolocation information （refactored IP detection with service-specific mappings）
export interface IpInfo {
  ip: string
  country_code: string
  country: string
  region: string
  city: string
  organization: string
  asn: number
  asn_organization: string
  longitude: number
  latitude: number
  timezone: string
  risk?: RiskInfo
}

// IP检测服务配置
interface ServiceConfig {
  url: string
  hasSecurityInfo?: boolean
  mapping: (data: any) => IpInfo
}

// 可用的IP检测服务列表及字段映射
const IP_CHECK_SERVICES: ServiceConfig[] = [
  {
    url: 'https://api.ip.sb/geoip',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country_code || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.organization || data.isp || '',
      asn: data.asn || 0,
      asn_organization: data.asn_organization || '',
      longitude: data.longitude || 0,
      latitude: data.latitude || 0,
      timezone: data.timezone || '',
      risk: calculateRiskInfo({
        organization: data.organization || data.isp,
        asnOrg: data.asn_organization,
      }),
    }),
  },
  {
    url: 'https://ipapi.co/json',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country_code || '',
      country: data.country_name || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.org || '',
      asn: data.asn ? parseInt(data.asn.replace('AS', '')) : 0,
      asn_organization: data.org || '',
      longitude: data.longitude || 0,
      latitude: data.latitude || 0,
      timezone: data.timezone || '',
      risk: calculateRiskInfo({
        organization: data.org,
      }),
    }),
  },
  {
    url: 'https://api.ipapi.is/',
    hasSecurityInfo: true,
    mapping: (data) => {
      const isDatacenter = Boolean(data.is_datacenter)
      const isMobile = Boolean(data.is_mobile)
      let resolvedType: RiskInfo['type'] = 'unknown'
      if (isMobile) resolvedType = 'mobile'
      else if (
        isDatacenter ||
        data.company?.type === 'hosting' ||
        data.asn?.type === 'hosting'
      )
        resolvedType = 'datacenter'
      else if (data.company?.type === 'isp' || data.asn?.type === 'isp')
        resolvedType = 'residential'
      else if (
        data.company?.type === 'business' ||
        data.asn?.type === 'business'
      )
        resolvedType = 'business'

      return {
        ip: data.ip || '',
        country_code: data.location?.country_code || '',
        country: data.location?.country || '',
        region: data.location?.state || '',
        city: data.location?.city || '',
        organization: data.asn?.org || data.company?.name || '',
        asn: data.asn?.asn || 0,
        asn_organization: data.asn?.org || '',
        longitude: data.location?.longitude || 0,
        latitude: data.location?.latitude || 0,
        timezone: data.location?.timezone || '',
        risk: calculateRiskInfo({
          isDatacenter,
          isMobile,
          isVpn: Boolean(data.is_vpn),
          isProxy: Boolean(data.is_proxy),
          isTor: Boolean(data.is_tor),
          isAbuser: Boolean(data.is_abuser),
          type: resolvedType,
          organization: data.company?.name || data.asn?.org,
          asnOrg: data.asn?.org,
        }),
      }
    },
  },
  {
    url: 'https://ipwho.is/',
    hasSecurityInfo: true,
    mapping: (data) => {
      const isDatacenter = Boolean(data.security?.hosting)
      let resolvedType: RiskInfo['type'] = 'unknown'
      if (isDatacenter) resolvedType = 'datacenter'
      else if (data.connection?.isp && !isDatacenter)
        resolvedType = 'residential'

      return {
        ip: data.ip || '',
        country_code: data.country_code || '',
        country: data.country || '',
        region: data.region || '',
        city: data.city || '',
        organization: data.connection?.org || data.connection?.isp || '',
        asn: data.connection?.asn || 0,
        asn_organization: data.connection?.isp || '',
        longitude: data.longitude || 0,
        latitude: data.latitude || 0,
        timezone: data.timezone?.id || '',
        risk: calculateRiskInfo({
          isDatacenter,
          isVpn: Boolean(data.security?.vpn),
          isProxy: Boolean(data.security?.proxy),
          isTor: Boolean(data.security?.tor),
          type: resolvedType,
          organization: data.connection?.org || data.connection?.isp,
          asnOrg: data.connection?.isp,
        }),
      }
    },
  },
  {
    url: 'https://ip.api.skk.moe/cf-geoip',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.asOrg || '',
      asn: data.asn || 0,
      asn_organization: data.asOrg || '',
      longitude: data.longitude || 0,
      latitude: data.latitude || 0,
      timezone: data.timezone || '',
      risk: calculateRiskInfo({
        organization: data.asOrg,
      }),
    }),
  },
  {
    url: 'https://get.geojs.io/v1/ip/geo.json',
    mapping: (data) => ({
      ip: data.ip || '',
      country_code: data.country_code || '',
      country: data.country || '',
      region: data.region || '',
      city: data.city || '',
      organization: data.organization_name || '',
      asn: data.asn || 0,
      asn_organization: data.organization_name || '',
      longitude: Number(data.longitude) || 0,
      latitude: Number(data.latitude) || 0,
      timezone: data.timezone || '',
      risk: calculateRiskInfo({
        organization: data.organization_name,
      }),
    }),
  },
]

// 获取当前IP和地理位置信息
export const getIpInfo = async (): Promise<
  IpInfo & { lastFetchTs: number }
> => {
  // 配置参数
  const maxRetries = 2
  const serviceTimeout = 5000

  const priorityServices = IP_CHECK_SERVICES.filter(
    (s) => s.hasSecurityInfo,
  ).sort(() => Math.random() - 0.5)
  const fallbackServices = IP_CHECK_SERVICES.filter(
    (s) => !s.hasSecurityInfo,
  ).sort(() => Math.random() - 0.5)
  const shuffledServices = [...priorityServices, ...fallbackServices]
  let lastError: unknown | null = null
  const userAgent = await getUserAgentPromise()
  console.debug('User-Agent for IP detection:', userAgent)

  for (const service of shuffledServices) {
    debugLog(`尝试IP检测服务: ${service.url}`)

    try {
      return await asyncRetry(
        async (bail) => {
          console.debug('Fetching IP information:', service.url)

          const timeoutController = new AbortController()
          const timeoutId = setTimeout(() => {
            timeoutController.abort()
          }, serviceTimeout)

          try {
            const response = await fetch(service.url, {
              method: 'GET',
              signal: timeoutController.signal,
              connectTimeout: serviceTimeout,
              headers: {
                'User-Agent': userAgent,
              },
            })

            if (!response.ok) {
              return bail(
                new Error(
                  `IP 检测服务出错，状态码: ${response.status} from ${service.url}`,
                ),
              )
            }

            let data: any
            try {
              data = await response.json()
            } catch {
              return bail(new Error(`无法解析 JSON 响应 from ${service.url}`))
            }

            if (data && data.ip) {
              debugLog(`IP检测成功，使用服务: ${service.url}`)
              return Object.assign(service.mapping(data), {
                // use last fetch success timestamp
                lastFetchTs: Date.now(),
              })
            } else {
              return bail(new Error(`无效的响应格式 from ${service.url}`))
            }
          } finally {
            clearTimeout(timeoutId)
          }
        },
        {
          retries: maxRetries,
          minTimeout: 1000,
          maxTimeout: 4000,
          randomize: true,
        },
      )
    } catch (error) {
      debugLog(`IP检测服务失败: ${service.url}`, error)
      lastError = error
    }
  }

  if (lastError) {
    console.error('[IP Info] All detection services failed:', lastError)
    throw new Error(
      i18n.t(($) => $.home.components.ipInfo.errors.loadWithDetails, {
        message:
          extractErrorMessage(lastError) ||
          i18n.t(($) => $.shared.feedback.errors.unknown),
      }),
    )
  } else {
    throw new Error(i18n.t(($) => $.home.components.ipInfo.errors.noServices))
  }
}


// DNS 泄露检测服务接口定义
export interface DnsServerInfo {
  ip: string
  country?: string
  country_name?: string
  asn?: string
  org?: string
}

export interface DnsLeakResult {
  hasLeak: boolean
  servers: DnsServerInfo[]
  conclusion: string
  lastFetchTs: number
}

// 获取 DNS 泄露检测结果
export const getDnsLeakInfo = async (): Promise<DnsLeakResult> => {
  const userAgent = await getUserAgentPromise()
  const testId = Math.random().toString(36).substring(2, 12)

  // 1. 优先尝试 bash.ws 泄露检测
  try {
    const triggerController = new AbortController()
    const triggerTimeout = setTimeout(() => triggerController.abort(), 4000)
    try {
      await fetch(`https://${testId}.bash.ws`, {
        method: 'GET',
        signal: triggerController.signal,
        connectTimeout: 4000,
        headers: { 'User-Agent': userAgent },
      })
    } catch {
      // 触发 DNS 请求本身无需在意 response
    } finally {
      clearTimeout(triggerTimeout)
    }

    const res = await fetch(`https://bash.ws/dnsleak/test/${testId}?json`, {
      method: 'GET',
      connectTimeout: 5000,
      headers: { 'User-Agent': userAgent },
    })

    if (res.ok) {
      const data: any[] = await res.json()
      if (Array.isArray(data)) {
        const dnsServers: DnsServerInfo[] = data
          .filter((item) => item.type === 'dns')
          .map((item) => ({
            ip: item.ip,
            country: item.country,
            country_name: item.country_name,
            asn: item.asn,
            org: item.org,
          }))

        const conclusionItem = data.find((item) => item.type === 'conclusion')
        const ipItem = data.find((item) => item.type === 'ip')

        const hasLeak =
          conclusionItem?.ip?.toLowerCase().includes('leak') ||
          (ipItem &&
            dnsServers.some(
              (s) =>
                s.country &&
                ipItem.country &&
                s.country.toLowerCase() !== ipItem.country.toLowerCase() &&
                s.country.toLowerCase() === 'cn',
            ))

        return {
          hasLeak: Boolean(hasLeak),
          servers: dnsServers,
          conclusion:
            conclusionItem?.ip ||
            (hasLeak ? 'DNS may be leaking.' : 'DNS is not leaking.'),
          lastFetchTs: Date.now(),
        }
      }
    }
  } catch (err) {
    debugLog('bash.ws DNS 泄露测试出错，尝试备选接口', err)
  }

  // 2. 回退备选：edns.ip-api.com
  try {
    const res = await fetch('https://edns.ip-api.com/json', {
      method: 'GET',
      connectTimeout: 5000,
      headers: { 'User-Agent': userAgent },
    })
    if (res.ok) {
      const data = await res.json()
      const servers: DnsServerInfo[] = []
      if (data.dns) {
        servers.push({
          ip: data.dns.ip || '',
          org: data.dns.geo || '',
        })
      }
      if (data.edns && data.edns.ip && data.edns.ip !== data.dns?.ip) {
        servers.push({
          ip: data.edns.ip || '',
          org: data.edns.geo || '',
        })
      }

      const hasLeak = servers.some((s) =>
        s.org?.toLowerCase().includes('china'),
      )

      return {
        hasLeak,
        servers,
        conclusion: hasLeak ? 'DNS may be leaking.' : 'DNS is not leaking.',
        lastFetchTs: Date.now(),
      }
    }
  } catch (err) {
    debugLog('edns.ip-api.com DNS 测试失败', err)
  }

  throw new Error('All DNS leak test services failed')
}
