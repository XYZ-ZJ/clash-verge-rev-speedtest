import { fetch } from '@tauri-apps/plugin-http'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  extractCandidateIp,
  fetchIpPurityScores,
  getUtcOffsetHours,
} from './egress'

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))

const mockFetch = vi.mocked(fetch)

const mockResponse = (body: string, ok = true) =>
  ({
    ok,
    text: async () => body,
  }) as unknown as Awaited<ReturnType<typeof fetch>>

describe('egress helpers', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })
  test('extracts srflx IPv4 and IPv6 addresses without false positives', () => {
    expect(
      extractCandidateIp(
        'candidate:1 1 udp 2122260223 203.0.113.10 54321 typ srflx',
      ),
    ).toBe('203.0.113.10')
    expect(
      extractCandidateIp(
        'candidate:2 1 udp 2122194687 2001:4860:4860::8888 54322 typ srflx',
      ),
    ).toBe('2001:4860:4860::8888')
    expect(
      extractCandidateIp(
        'candidate:3 1 udp 2122260223 192.168.1.25 54321 typ host',
      ),
    ).toBeNull()
    expect(
      extractCandidateIp(
        'candidate:4 1 tcp 1518280447 [fe80::1%eth0] 9 typ host',
      ),
    ).toBeNull()
    expect(extractCandidateIp('not-an-ip.local')).toBeNull()
    expect(extractCandidateIp('a'.repeat(512))).toBeNull()
  })

  test('computes UTC offsets including GMT and fractional zones', () => {
    expect(getUtcOffsetHours('UTC')).toBe(0)
    expect(getUtcOffsetHours('GMT')).toBe(0)
    expect(getUtcOffsetHours('Asia/Shanghai')).toBe(8)
    expect(getUtcOffsetHours('Asia/Kolkata')).toBe(5.5)
    expect(getUtcOffsetHours('Invalid/Timezone_Name')).toBeNull()
  })

  test('fetchIpPurityScores converts risk scores and avoids query bust on Scamalytics', async () => {
    mockFetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://scamalytics.com/ip/')) {
        expect(url).not.toContain('_t=')
        return mockResponse('{"score": 7}')
      }
      if (url.startsWith('https://api.ipquery.io/')) {
        return mockResponse(JSON.stringify({ risk: { risk_score: 18 } }))
      }
      if (url.startsWith('https://proxycheck.io/v2/')) {
        return mockResponse(
          JSON.stringify({ status: 'ok', '1.2.3.4': { risk: 25 } }),
        )
      }
      return mockResponse('', false)
    })

    const res = await fetchIpPurityScores('1.2.3.4')
    expect(res).toEqual([
      { id: 'scamalytics', label: 'Scamalytics', riskScore: 7, score: 93 },
      { id: 'ipquery', label: 'ipquery', riskScore: 18, score: 82 },
      { id: 'proxycheck', label: 'proxycheck.io', riskScore: 25, score: 75 },
    ])
  })

  test('fetchIpPurityScores calibrates ipapi floor and falls back on IPv6 proxycheck keys', async () => {
    mockFetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://scamalytics.com/ip/')) {
        return mockResponse('', false)
      }
      if (url.startsWith('https://api.ipquery.io/')) {
        return mockResponse(JSON.stringify({ risk: { risk_score: 60 } }))
      }
      if (url.startsWith('https://proxycheck.io/v2/')) {
        return mockResponse(
          JSON.stringify({
            status: 'ok',
            '2001:db8::1': { risk: 72 },
          }),
        )
      }
      if (url.startsWith('https://ipinfo.check.place/')) {
        return mockResponse(
          JSON.stringify({
            ip: '2001:0db8::1',
            is_proxy: true,
            is_datacenter: true,
            company: { abuser_score: '0.01 (Low)' },
          }),
        )
      }
      return mockResponse('', false)
    })

    const res = await fetchIpPurityScores('2001:0db8::1')
    expect(res).toEqual([
      { id: 'ipquery', label: 'ipquery', riskScore: 60, score: 40 },
      { id: 'proxycheck', label: 'proxycheck.io', riskScore: 72, score: 28 },
      { id: 'ipapi', label: 'ipapi', riskScore: 40, score: 60 },
    ])
  })

  test('fetchIpPurityScores returns empty array when all sources fail', async () => {
    mockFetch.mockResolvedValue(mockResponse('', false))
    const res = await fetchIpPurityScores('8.8.8.8')
    expect(res).toEqual([])
  })
})
