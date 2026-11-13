import { commands } from '@/services/bindings'
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
      /hosting|datacenter|data\s*centre|vps|cloud|server|compute|dedicated|cdn|asn|network|telecom|infrastructure|llc|corp|inc|ltd|limited|gmbh|co\.|technology|technologies|solutions|communications|node|transit|peering|digital|service/i.test(
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

// 常见国家名称到二字码映射，用于部分接口只返回国家全名时的兜底
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  japan: 'JP',
  'united states': 'US',
  usa: 'US',
  'hong kong': 'HK',
  taiwan: 'TW',
  singapore: 'SG',
  'south korea': 'KR',
  korea: 'KR',
  'united kingdom': 'GB',
  uk: 'GB',
  germany: 'DE',
  france: 'FR',
  canada: 'CA',
  australia: 'AU',
  russia: 'RU',
  netherlands: 'NL',
  india: 'IN',
  china: 'CN',
}

const resolveCountryCode = (code?: string, countryName?: string): string => {
  if (code && code.length === 2) return code.toUpperCase()
  if (countryName) {
    const lower = countryName.toLowerCase().trim()
    if (COUNTRY_NAME_TO_CODE[lower]) return COUNTRY_NAME_TO_CODE[lower]
    if (countryName.length === 2) return countryName.toUpperCase()
  }
  return ''
}

const cleanAsn = (val: any): number => {
  if (typeof val === 'number') return val
  if (typeof val === 'string') {
    const match = val.match(/\d+/)
    return match ? parseInt(match[0], 10) : 0
  }
  if (val && typeof val.asn === 'number') return val.asn
  return 0
}

const cleanAsnOrg = (asnVal: any, orgVal: any): string => {
  if (typeof asnVal === 'string') {
    const cleaned = asnVal.replace(/^AS\d+\s*/i, '').trim()
    if (cleaned) return cleaned
  }
  if (asnVal && typeof asnVal.org === 'string') return asnVal.org
  if (typeof orgVal === 'string') return orgVal
  return ''
}

// 可用的IP检测服务列表及字段映射
const IP_CHECK_SERVICES: ServiceConfig[] = [
  {
    url: 'https://api.ip.sb/geoip',
    hasSecurityInfo: true,
    mapping: (data) => {
      const countryCode = resolveCountryCode(data.country_code, data.country)
      const asn = cleanAsn(data.asn)
      const asnOrg = cleanAsnOrg(data.asn_organization, data.organization || data.isp)
      const org = data.organization || data.isp || asnOrg || ''
      return {
        ip: data.ip || '',
        country_code: countryCode,
        country: data.country || countryCode || '',
        region: data.region || '',
        city: data.city || '',
        organization: org,
        asn,
        asn_organization: asnOrg,
        longitude: Number(data.longitude) || 0,
        latitude: Number(data.latitude) || 0,
        timezone: data.timezone || '',
        risk: calculateRiskInfo({
          organization: org,
          asnOrg,
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
      else if (data.connection?.isp && !isDatacenter) resolvedType = 'residential'

      const countryCode = resolveCountryCode(data.country_code, data.country)
      const asn = cleanAsn(data.connection?.asn || data.asn)
      const asnOrg = cleanAsnOrg(data.connection?.org, data.connection?.isp)
      const org = data.connection?.org || data.connection?.isp || asnOrg || ''

      return {
        ip: data.ip || '',
        country_code: countryCode,
        country: data.country || countryCode || '',
        region: data.region || '',
        city: data.city || '',
        organization: org,
        asn,
        asn_organization: asnOrg,
        longitude: Number(data.longitude) || 0,
        latitude: Number(data.latitude) || 0,
        timezone: data.timezone?.id || data.timezone || '',
        risk: calculateRiskInfo({
          isDatacenter,
          isVpn: Boolean(data.security?.vpn),
          isProxy: Boolean(data.security?.proxy),
          isTor: Boolean(data.security?.tor),
          type: resolvedType,
          organization: org,
          asnOrg,
        }),
      }
    },
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

      const country = data.country || data.location?.country || ''
      const countryCode = resolveCountryCode(data.country_code || data.location?.country_code, country)
      const asn = cleanAsn(data.asn?.asn || data.asn)
      const org =
        (typeof data.company === 'string' ? data.company : data.company?.name) ||
        (typeof data.asn === 'string' ? data.asn : data.asn?.org) ||
        ''
      const asnOrg = cleanAsnOrg(data.asn, org)

      return {
        ip: data.ip || '',
        country_code: countryCode,
        country: country || countryCode || '',
        region: data.region || data.location?.state || '',
        city: data.city || data.location?.city || '',
        organization: org,
        asn,
        asn_organization: asnOrg,
        longitude: Number(data.lon ?? data.longitude ?? data.location?.longitude) || 0,
        latitude: Number(data.lat ?? data.latitude ?? data.location?.latitude) || 0,
        timezone: data.timezone || data.location?.timezone || '',
        risk: calculateRiskInfo({
          isDatacenter,
          isMobile,
          isVpn: Boolean(data.is_vpn),
          isProxy: Boolean(data.is_proxy),
          isTor: Boolean(data.is_tor),
          isAbuser: Boolean(data.is_abuser),
          type: resolvedType,
          organization: org,
          asnOrg,
        }),
      }
    },
  },
  {
    url: 'https://ip.api.skk.moe/cf-geoip',
    mapping: (data) => {
      const countryCode = resolveCountryCode(data.country, data.country)
      const asn = cleanAsn(data.asn)
      const org = data.asOrg || ''
      return {
        ip: data.ip || '',
        country_code: countryCode,
        country: countryCode || '',
        region: data.region || '',
        city: data.city || '',
        organization: org,
        asn,
        asn_organization: org,
        longitude: Number(data.longitude) || 0,
        latitude: Number(data.latitude) || 0,
        timezone: data.timezone || '',
        risk: calculateRiskInfo({
          organization: org,
          asnOrg: org,
        }),
      }
    },
  },
  {
    url: 'https://get.geojs.io/v1/ip/geo.json',
    mapping: (data) => {
      const countryCode = resolveCountryCode(data.country_code, data.country)
      const asn = cleanAsn(data.asn)
      const org = data.organization_name || data.organization || ''
      return {
        ip: data.ip || '',
        country_code: countryCode,
        country: data.country || countryCode || '',
        region: data.region || '',
        city: data.city || '',
        organization: org,
        asn,
        asn_organization: org,
        longitude: Number(data.longitude) || 0,
        latitude: Number(data.latitude) || 0,
        timezone: data.timezone || '',
        risk: calculateRiskInfo({
          organization: org,
          asnOrg: org,
        }),
      }
    },
  },
  {
    url: 'https://ipapi.co/json',
    mapping: (data) => {
      const countryCode = resolveCountryCode(data.country_code, data.country_name)
      const asn = cleanAsn(data.asn)
      const org = data.org || ''
      return {
        ip: data.ip || '',
        country_code: countryCode,
        country: data.country_name || countryCode || '',
        region: data.region || '',
        city: data.city || '',
        organization: org,
        asn,
        asn_organization: org,
        longitude: Number(data.longitude) || 0,
        latitude: Number(data.latitude) || 0,
        timezone: data.timezone || '',
        risk: calculateRiskInfo({
          organization: org,
          asnOrg: org,
        }),
      }
    },
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
  // 1. 优先通过 Rust 后端使用当前 Clash 代理端口（MixedPort）发起检测请求
  // 该请求使用 HTTP 代理隧道（CONNECT），客户端本地完全不会进行 DNS 查询，
  // 从而彻底杜绝本地物理网卡向路由器下发 DNS 发送查询，全部解析由 Clash 内核处理！
  try {
    const rawJson = await commands.testDnsLeak()
    const data: any[] = JSON.parse(rawJson)
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

      const ipItem = data.find((item) => item.type === 'ip')

      const isCnDns = (s: DnsServerInfo) => {
        const country = s.country?.toLowerCase()
        const org = (s.org || '').toLowerCase()
        return (
          country === 'cn' ||
          /china|telecom|unicom|mobile|volcano|alibaba|tencent|baidu/i.test(org)
        )
      }

      const isPrivateIp = (ip: string) => {
        return (
          ip.startsWith('192.168.') ||
          ip.startsWith('10.') ||
          ip.startsWith('127.') ||
          /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
        )
      }

      const conclusionItem = data.find((item) => item.type === 'conclusion')
      // 只要检测出国内服务器（中国电信/移动/联通/阿里/腾讯等）、局域网私有 IP，或服务端判定泄露，严密判定为泄露！
      const hasLeak =
        dnsServers.some((s) => isCnDns(s) || isPrivateIp(s.ip)) ||
        Boolean(conclusionItem && /leak/i.test(conclusionItem.ip))

      return {
        hasLeak,
        servers: dnsServers,
        conclusion: hasLeak ? 'DNS may be leaking.' : 'DNS is not leaking.',
        lastFetchTs: Date.now(),
      }
    }
  } catch (err) {
    debugLog('testDnsLeak IPC error, fallback to direct test', err)
  }

  // 2. 回退备选：edns.ip-api.com
  try {
    const userAgent = await getUserAgentPromise()
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
    debugLog('edns.ip-api.com fallback error', err)
  }

  throw new Error('All DNS leak test services failed')
}
