import { describe, expect, test, vi } from 'vitest'

import { extractCandidateIp, getUtcOffsetHours } from './egress'

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))

describe('egress helpers', () => {
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
})
