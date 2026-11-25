import { getName, getVersion } from '@tauri-apps/api/app'
import { fetch } from '@tauri-apps/plugin-http'
import { asyncRetry } from 'foxts/async-retry'
import { extractErrorMessage } from 'foxts/extract-error-message'
import { once } from 'foxts/once'
import i18n from 'i18next'

import { testDnsLeak } from '@/services/cmds'
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

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// IP 风控信息定义
interface RiskInfo {
  score: number
  level: 'low' | 'medium' | 'high'
  type: 'datacenter' | 'residential' | 'mobile' | 'business' | 'unknown'
  isProxy?: boolean
  isVpn?: boolean
  isTor?: boolean
  isAbuser?: boolean
}

// 启发式风控与风险等级计算（仅在外部权威风控源不可用时作为兜底）
function calculateRiskInfo(params: {
  isDatacenter?: boolean
  isVpn?: boolean
  isProxy?: boolean
  isTor?: boolean
  isAbuser?: boolean
  isMobile?: boolean
  type?: RiskInfo['type']
  organization?: string
  asnOrg?: string
  nativeScore?: number
}): RiskInfo {
  let type: RiskInfo['type'] = params.type || 'unknown'
  const orgText =
    `${params.organization || ''} ${params.asnOrg || ''}`.toLowerCase()

  if (type === 'unknown') {
    if (params.isMobile) {
      type = 'mobile'
    } else if (params.isDatacenter) {
      type = 'datacenter'
    } else if (
      /\b(hosting|datacenter|data\s*centre|colocation|vps|aws|amazon\s*web|google\s*cloud|microsoft\s*azure|digitalocean|vultr|linode|hetzner|ovh|choopa|oracle\s*cloud|alibaba\s*cloud|tencent\s*cloud|cloudflare|rackspace|leaseweb|quadranet|psychz|zenlayer|m247|datacamp)\b/i.test(
        orgText,
      )
    ) {
      type = 'datacenter'
    } else if (
      /\b(broadband|fiber|fibre|cable|dsl|residential|consumer|comcast|verizon|at&t|charter|spectrum|cox|frontier|t-mobile|vodafone|orange|telefonica|singtel|starhub|ntt|kddi|softbank|chunghwa|hinet|china\s*telecom|china\s*unicom|china\s*mobile)\b/i.test(
        orgText,
      )
    ) {
      type = 'residential'
    }
  }

  let score: number
  if (
    typeof params.nativeScore === 'number' &&
    Number.isFinite(params.nativeScore)
  ) {
    score = Math.round(params.nativeScore)
  } else {
    score = 5
    if (type === 'datacenter') {
      score += 25
    } else if (type === 'business') {
      score += 10
    } else if (type === 'residential' || type === 'mobile') {
      score = 3
    }

    if (params.isProxy) score += 25
    if (params.isVpn) score += 20
    if (params.isTor) score += 40
    if (params.isAbuser) score += 40
  }

  score = Math.min(100, Math.max(0, score))

  let level: RiskInfo['level']
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
interface IpInfo {
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

interface IpQueryRiskPayload {
  is_mobile?: boolean
  is_vpn?: boolean
  is_tor?: boolean
  is_proxy?: boolean
  is_datacenter?: boolean
  risk_score?: number
}

// IP检测服务配置
interface ServiceConfig {
  url: string
  priority?: boolean
  mapping: (data: any) => { info: IpInfo; ipqueryRisk?: IpQueryRiskPayload }
}

// 常见国家名称到二字码映射，用于部分接口只返回国家全名时的兜底
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  japan: 'JP',
  'united states': 'US',
  'united states of america': 'US',
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
  if (val && typeof val.asn === 'string') return cleanAsn(val.asn)
  return 0
}

const cleanAsnOrg = (asnVal: any, orgVal: any): string => {
  if (typeof asnVal === 'string') {
    const cleaned = asnVal.replace(/^AS\d+\s*/i, '').trim()
    if (cleaned) return cleaned
  }
  if (asnVal && typeof asnVal.org === 'string') return asnVal.org
  if (asnVal && typeof asnVal.name === 'string') return asnVal.name
  if (typeof orgVal === 'string') return orgVal
  return ''
}

const parseAbuserScorePercent = (val: unknown): number | null => {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val <= 1 ? Math.round(val * 100) : Math.round(val)
  }
  if (typeof val === 'string') {
    const match = val.match(/[\d.]+/)
    if (match) {
      const num = parseFloat(match[0])
      if (Number.isFinite(num)) {
        return num <= 1 ? Math.round(num * 100) : Math.round(num)
      }
    }
  }
  return null
}

// 可用的IP基础信息检测服务列表（按稳定性与信息完整度分层）
const IP_CHECK_SERVICES: ServiceConfig[] = [
  {
    url: 'https://api.ipquery.io/?format=json',
    priority: true,
    mapping: (data) => {
      const countryCode = resolveCountryCode(
        data.location?.country_code,
        data.location?.country,
      )
      const asn = cleanAsn(data.isp?.asn)
      const asnOrg = cleanAsnOrg(data.isp?.org, data.isp?.isp)
      const org = data.isp?.isp || data.isp?.org || asnOrg || ''
      const riskRaw: IpQueryRiskPayload | undefined = data.risk
      return {
        info: {
          ip: data.ip || '',
          country_code: countryCode,
          country: data.location?.country || countryCode || '',
          region: data.location?.state || '',
          city: data.location?.city || '',
          organization: org,
          asn,
          asn_organization: asnOrg,
          longitude: Number(data.location?.longitude) || 0,
          latitude: Number(data.location?.latitude) || 0,
          timezone: data.location?.timezone || '',
        },
        ipqueryRisk: riskRaw,
      }
    },
  },
  {
    url: 'https://ipwho.is/',
    priority: true,
    mapping: (data) => {
      const countryCode = resolveCountryCode(data.country_code, data.country)
      const asn = cleanAsn(data.connection?.asn || data.asn)
      const asnOrg = cleanAsnOrg(data.connection?.org, data.connection?.isp)
      const org = data.connection?.org || data.connection?.isp || asnOrg || ''
      return {
        info: {
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
        },
      }
    },
  },
  {
    url: 'https://api.ipapi.is/',
    priority: true,
    mapping: (data) => {
      const country = data.country || data.location?.country || ''
      const countryCode = resolveCountryCode(
        data.country_code || data.location?.country_code,
        country,
      )
      const asn = cleanAsn(data.asn?.asn || data.asn)
      const org =
        (typeof data.company === 'string'
          ? data.company
          : data.company?.name) ||
        (typeof data.asn === 'string' ? data.asn : data.asn?.org) ||
        ''
      const asnOrg = cleanAsnOrg(data.asn, org)
      return {
        info: {
          ip: data.ip || '',
          country_code: countryCode,
          country: country || countryCode || '',
          region: data.region || data.location?.state || '',
          city: data.city || data.location?.city || '',
          organization: org,
          asn,
          asn_organization: asnOrg,
          longitude:
            Number(data.lon ?? data.longitude ?? data.location?.longitude) || 0,
          latitude:
            Number(data.lat ?? data.latitude ?? data.location?.latitude) || 0,
          timezone: data.timezone || data.location?.timezone || '',
        },
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
        info: {
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
        },
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
        info: {
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
        },
      }
    },
  },
  {
    url: 'https://ipapi.co/json',
    mapping: (data) => {
      const countryCode = resolveCountryCode(
        data.country_code,
        data.country_name,
      )
      const asn = cleanAsn(data.asn)
      const org = data.org || ''
      return {
        info: {
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
        },
      }
    },
  },
  {
    url: 'https://api.ip.sb/geoip',
    mapping: (data) => {
      const countryCode = resolveCountryCode(data.country_code, data.country)
      const asn = cleanAsn(data.asn)
      const asnOrg = cleanAsnOrg(
        data.asn_organization,
        data.organization || data.isp,
      )
      const org = data.organization || data.isp || asnOrg || ''
      return {
        info: {
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
        },
      }
    },
  },
]

const fetchWithTimeout = async (
  url: string,
  timeoutMs = 3500,
): Promise<Awaited<ReturnType<typeof fetch>> | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      connectTimeout: timeoutMs,
      headers: {
        'User-Agent': BROWSER_UA,
        'Cache-Control': 'no-cache, no-store',
      },
    })
    return res.ok ? res : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 参考 IP.Check.Place 多库交叉验证思路：并发查询 IPinfo、ipapi、ipquery、proxycheck、Scamalytics
const enrichIpRiskFromAuthoritativeSources = async (
  baseInfo: IpInfo,
  initialIpQueryRisk?: IpQueryRiskPayload,
): Promise<IpInfo> => {
  const encodedIp = encodeURIComponent(baseInfo.ip)

  const [ipinfoRes, ipapiRes, ipqueryRes, proxycheckRes, scamRes] =
    await Promise.all([
      fetchWithTimeout(`https://ipinfo.io/widget/demo/${encodedIp}`, 3800).then(
        (r) => (r ? r.json().catch(() => null) : null),
      ),
      fetchWithTimeout(
        `https://ipinfo.check.place/${encodedIp}?db=ipapi`,
        3800,
      ).then((r) => (r ? r.json().catch(() => null) : null)),
      initialIpQueryRisk
        ? Promise.resolve({ risk: initialIpQueryRisk })
        : fetchWithTimeout(
            `https://api.ipquery.io/${encodedIp}?format=json`,
            3500,
          ).then((r) => (r ? r.json().catch(() => null) : null)),
      fetchWithTimeout(
        `https://proxycheck.io/v2/${encodedIp}?vpn=1&asn=1&risk=1`,
        3500,
      ).then((r) => (r ? r.json().catch(() => null) : null)),
      fetchWithTimeout(`https://scamalytics.com/ip/${encodedIp}`, 3800).then(
        (r) => (r ? r.text().catch(() => null) : null),
      ),
    ])

  // 若 IPinfo 返回了更完整的基础信息，顺便补全缺失字段
  const ipinfoData = ipinfoRes?.data
  if (ipinfoData) {
    if (!baseInfo.country_code && ipinfoData.country) {
      baseInfo.country_code = resolveCountryCode(
        ipinfoData.country,
        ipinfoData.country,
      )
    }
    if (!baseInfo.region && ipinfoData.region)
      baseInfo.region = ipinfoData.region
    if (!baseInfo.city && ipinfoData.city) baseInfo.city = ipinfoData.city
    if (!baseInfo.timezone && ipinfoData.timezone)
      baseInfo.timezone = ipinfoData.timezone
    if (!baseInfo.asn && ipinfoData.asn?.asn) {
      baseInfo.asn = cleanAsn(ipinfoData.asn.asn)
    }
    if (!baseInfo.asn_organization && ipinfoData.asn?.name) {
      baseInfo.asn_organization = ipinfoData.asn.name
    }
    if (
      !baseInfo.organization &&
      (ipinfoData.company?.name || ipinfoData.asn?.name)
    ) {
      baseInfo.organization = ipinfoData.company?.name || ipinfoData.asn?.name
    }
  }

  // 1. 多源加权投票确定 IP 类型（权重：IPinfo=2、ipapi=2、ipquery=1、proxycheck=1）
  const votes = { residential: 0, datacenter: 0, business: 0 }
  let isMobile = false
  let hasAuthoritativeType = false

  // 源 A: IPinfo (与 IP.Check.Place 同源)
  if (ipinfoData) {
    const asnType = String(ipinfoData.asn?.type || '').toLowerCase()
    const comType = String(ipinfoData.company?.type || '').toLowerCase()
    const isHosting = Boolean(ipinfoData.privacy?.hosting)
    if (isHosting || comType === 'hosting' || asnType === 'hosting') {
      votes.datacenter += 2
      hasAuthoritativeType = true
    } else if (comType === 'isp' || asnType === 'isp') {
      if (comType === 'business' && asnType === 'isp') {
        votes.residential += 1
        votes.business += 1
      } else {
        votes.residential += 2
      }
      hasAuthoritativeType = true
    } else if (comType === 'business' || asnType === 'business') {
      votes.business += 2
      hasAuthoritativeType = true
    }
  }

  // 源 B: ipapi (via ipinfo.check.place?db=ipapi，与 IP.Check.Place 同源)
  const ipapiData =
    ipapiRes && typeof ipapiRes === 'object' && ipapiRes.ip ? ipapiRes : null
  if (ipapiData) {
    if (ipapiData.is_mobile) isMobile = true
    const asnType = String(ipapiData.asn?.type || '').toLowerCase()
    const comType = String(ipapiData.company?.type || '').toLowerCase()
    if (
      ipapiData.is_datacenter ||
      comType === 'hosting' ||
      asnType === 'hosting'
    ) {
      votes.datacenter += 2
      hasAuthoritativeType = true
    } else if (comType === 'isp' || asnType === 'isp') {
      if (comType === 'business' && asnType === 'isp') {
        votes.residential += 1
        votes.business += 1
      } else {
        votes.residential += 2
      }
      hasAuthoritativeType = true
    } else if (comType === 'business' || asnType === 'business') {
      votes.business += 2
      hasAuthoritativeType = true
    }
  }

  // 源 C: ipquery
  const iqRisk: IpQueryRiskPayload | undefined = ipqueryRes?.risk
  if (iqRisk && typeof iqRisk === 'object') {
    if (iqRisk.is_mobile) isMobile = true
    if (iqRisk.is_datacenter === true) {
      votes.datacenter += 1
      hasAuthoritativeType = true
    } else if (
      iqRisk.is_datacenter === false &&
      !iqRisk.is_vpn &&
      !iqRisk.is_proxy
    ) {
      votes.residential += 1
      hasAuthoritativeType = true
    }
  }

  // 源 D: proxycheck.io
  const pcItem = proxycheckRes?.[baseInfo.ip]
  if (pcItem && typeof pcItem === 'object') {
    const pcType = String(pcItem.type || '').toLowerCase()
    if (pcType === 'wireless' || pcType === 'mobile') {
      isMobile = true
      hasAuthoritativeType = true
    } else if (pcType === 'hosting' || pcType === 'vpn') {
      votes.datacenter += 1
      hasAuthoritativeType = true
    } else if (pcType === 'residential') {
      votes.residential += 1
      hasAuthoritativeType = true
    } else if (pcType === 'business') {
      votes.business += 1
      hasAuthoritativeType = true
    }
  }

  // 源 E: Scamalytics HTML 欺诈分提取
  let scamScore: number | null = null
  let scamBlacklisted = false
  if (typeof scamRes === 'string' && scamRes.length > 0) {
    const scoreMatch = scamRes.match(/"score"\s*:\s*"(\d+)"/)
    if (scoreMatch) {
      const parsed = parseInt(scoreMatch[1], 10)
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
        scamScore = parsed
      }
    }
    if (/"is_blacklisted_external"\s*:\s*true/i.test(scamRes)) {
      scamBlacklisted = true
    }
  }

  let resolvedType: RiskInfo['type'] = 'unknown'
  if (isMobile) {
    resolvedType = 'mobile'
  } else if (hasAuthoritativeType) {
    if (
      votes.residential >= votes.datacenter &&
      votes.residential >= votes.business &&
      votes.residential > 0
    ) {
      resolvedType = 'residential'
    } else if (votes.datacenter >= votes.business && votes.datacenter > 0) {
      resolvedType = 'datacenter'
    } else if (votes.business > 0) {
      resolvedType = 'business'
    }
  }

  // 2. 风险因子融合判定（防止单源误报）
  const isTor = Boolean(
    ipinfoData?.privacy?.tor || ipapiData?.is_tor || iqRisk?.is_tor,
  )
  const isAbuser = Boolean(ipapiData?.is_abuser || scamBlacklisted)
  const pcIsProxy = pcItem?.proxy === 'yes'
  const pcRiskNum = typeof pcItem?.risk === 'number' ? pcItem.risk : null
  const isVpn = Boolean(
    ipinfoData?.privacy?.vpn ||
      ipapiData?.is_vpn ||
      iqRisk?.is_vpn ||
      (String(pcItem?.type || '').toLowerCase() === 'vpn' &&
        resolvedType === 'datacenter'),
  )
  const isProxy = Boolean(
    ipinfoData?.privacy?.proxy ||
      ipapiData?.is_proxy ||
      iqRisk?.is_proxy ||
      (pcIsProxy &&
        (resolvedType === 'datacenter' ||
          (pcRiskNum !== null && pcRiskNum >= 50))),
  )

  // 3. 收集真实原生连续风控分（0-100），多源去极值融合
  const nativeScores: number[] = []
  if (ipapiData) {
    const comAbuse = parseAbuserScorePercent(ipapiData.company?.abuser_score)
    const asnAbuse = parseAbuserScorePercent(ipapiData.asn?.abuser_score)
    const maxAbuse =
      comAbuse !== null && asnAbuse !== null
        ? Math.max(comAbuse, asnAbuse)
        : (comAbuse ?? asnAbuse)
    if (maxAbuse !== null)
      nativeScores.push(Math.min(100, Math.max(0, maxAbuse)))
  }
  if (
    typeof iqRisk?.risk_score === 'number' &&
    Number.isFinite(iqRisk.risk_score)
  ) {
    nativeScores.push(Math.min(100, Math.max(0, Math.round(iqRisk.risk_score))))
  }
  if (pcRiskNum !== null && Number.isFinite(pcRiskNum)) {
    nativeScores.push(Math.min(100, Math.max(0, Math.round(pcRiskNum))))
  }
  if (scamScore !== null) {
    nativeScores.push(scamScore)
  }

  let fusedScore: number | undefined
  if (nativeScores.length >= 3) {
    // 去掉最高极值，避免单个偏激数据源误拉高正常住宅 IP 评分
    const sorted = [...nativeScores].sort((a, b) => a - b)
    const trimmed = sorted.slice(0, sorted.length - 1)
    fusedScore = Math.round(
      trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length,
    )
  } else if (nativeScores.length === 2) {
    fusedScore = Math.round((nativeScores[0] + nativeScores[1]) / 2)
  } else if (nativeScores.length === 1) {
    fusedScore = nativeScores[0]
  }

  // 对明确检出的机房/代理/滥用风险做合理下限校准；住宅且无风险因子时完全保留真实低分
  if (typeof fusedScore === 'number') {
    if (isTor || isAbuser) fusedScore = Math.max(fusedScore, 65)
    else if (isVpn || isProxy) fusedScore = Math.max(fusedScore, 35)
    else if (resolvedType === 'datacenter')
      fusedScore = Math.max(fusedScore, 25)
  }

  baseInfo.risk = calculateRiskInfo({
    isDatacenter: resolvedType === 'datacenter',
    isMobile,
    isVpn,
    isProxy,
    isTor,
    isAbuser,
    type: resolvedType,
    organization: baseInfo.organization,
    asnOrg: baseInfo.asn_organization,
    nativeScore: fusedScore,
  })

  return baseInfo
}

// 获取当前IP和地理位置信息
export const getIpInfo = async (): Promise<
  IpInfo & { lastFetchTs: number }
> => {
  const maxRetries = 1
  const serviceTimeout = 5000

  const priorityServices = IP_CHECK_SERVICES.filter((s) => s.priority)
  const fallbackServices = IP_CHECK_SERVICES.filter((s) => !s.priority)
  const orderedServices = [...priorityServices, ...fallbackServices]
  let lastError: unknown | null = null
  const userAgent = await getUserAgentPromise()
  console.debug('User-Agent for IP detection:', userAgent)

  for (const service of orderedServices) {
    debugLog(`尝试IP检测服务: ${service.url}`)

    try {
      const baseResult = await asyncRetry(
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
                'User-Agent': BROWSER_UA,
                'Cache-Control': 'no-cache, no-store',
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
              return service.mapping(data)
            } else {
              return bail(new Error(`无效的响应格式 from ${service.url}`))
            }
          } finally {
            clearTimeout(timeoutId)
          }
        },
        {
          retries: maxRetries,
          minTimeout: 800,
          maxTimeout: 2500,
          randomize: true,
        },
      )

      const enriched = await enrichIpRiskFromAuthoritativeSources(
        baseResult.info,
        baseResult.ipqueryRisk,
      )
      return Object.assign(enriched, {
        lastFetchTs: Date.now(),
      })
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
interface DnsServerInfo {
  ip: string
  country?: string
  country_name?: string
  asn?: string
  org?: string
}

interface DnsLeakResult {
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
    const rawJson = await testDnsLeak()
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
        const country = (s.country || '').trim().toLowerCase()
        const countryName = (s.country_name || '').trim().toLowerCase()
        const org = (s.org || '').toLowerCase()
        return (
          country === 'cn' ||
          country === 'china' ||
          countryName === 'cn' ||
          countryName === 'china' ||
          countryName.includes('china') ||
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

      const ipCountry = (ipItem?.country || ipItem?.country_name || '')
        .trim()
        .toLowerCase()
      const isOverseasProxy = Boolean(
        ipCountry && !['cn', 'china'].includes(ipCountry),
      )

      // 严密且符合分流规律的远程 DNS 泄露判定：
      // 1. 若测试请求走海外代理出口，但 DNS 查询服务器混入了中国大陆境内服务器或局域网私有 IP，为真实远程 DNS 泄露；
      // 2. 若走海外代理，且 DNS 均为境外安全服务器，为正常安全解析，绝不误报；
      // 3. 若走国内直连，国内流量走国内直连 DNS 符合分流规则，不是泄露。
      let hasLeak = false
      if (isOverseasProxy) {
        hasLeak = dnsServers.some((s) => isCnDns(s) || isPrivateIp(s.ip))
      } else {
        hasLeak = dnsServers.some((s) => isPrivateIp(s.ip))
      }

      return {
        hasLeak,
        servers: dnsServers,
        conclusion: hasLeak ? 'DNS may be leaking.' : 'DNS is not leaking.',
        lastFetchTs: Date.now(),
      }
    }
  } catch (err) {
    const errObj = err as
      | { code?: unknown; detail?: unknown; message?: unknown }
      | undefined
    const errCode = typeof errObj?.code === 'string' ? errObj.code : undefined
    const errMessage = extractErrorMessage(err) ?? ''
    if (
      errCode === 'dnsleak.portUnavailable' ||
      errCode === 'dnsleak.proxyConfigFailed' ||
      errCode === 'dnsleak.clientSetupFailed' ||
      errMessage.includes('dnsleak.portUnavailable') ||
      errMessage.includes('proxy port is unavailable')
    ) {
      throw err instanceof Error
        ? err
        : new Error(
            (typeof errObj?.detail === 'string' && errObj.detail) ||
              errMessage ||
              'Proxy port is unavailable for DNS leak check',
          )
    }
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
