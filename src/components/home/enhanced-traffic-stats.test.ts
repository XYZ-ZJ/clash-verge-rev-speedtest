import { describe, expect, it } from 'vitest'

import { isThroughProxyNode } from './enhanced-traffic-stats'

const makeConn = (overrides: Partial<IConnectionsItem> = {}) =>
  ({
    id: 'conn-1',
    metadata: {
      network: 'tcp',
      type: 'HTTP',
      host: 'example.com',
      sourceIP: '127.0.0.1',
      sourcePort: '12345',
      destinationPort: '443',
    },
    upload: 0,
    download: 0,
    start: '2026-01-01T00:00:00Z',
    chains: ['🇯🇵 Node', 'Proxy Group'],
    rule: 'GeoSite',
    rulePayload: 'example.com',
    ...overrides,
  }) as IConnectionsItem

describe('isThroughProxyNode', () => {
  it('treats a connection with a real proxy chain as proxied', () => {
    expect(isThroughProxyNode(makeConn(), 'rule')).toBe(true)
  })

  it('treats every connection as direct in direct mode', () => {
    const conn = makeConn({ chains: ['🇯🇵 Node', 'Proxy Group'] })
    expect(isThroughProxyNode(conn, 'direct')).toBe(false)
    expect(isThroughProxyNode(conn, 'Direct')).toBe(false)
  })

  it('rejects kernel-internal and DNS connections', () => {
    expect(
      isThroughProxyNode(
        makeConn({ metadata: { ...makeConn().metadata, type: 'Inner' } }),
        'rule',
      ),
    ).toBe(false)
    expect(
      isThroughProxyNode(
        makeConn({ metadata: { ...makeConn().metadata, type: 'DNS' } }),
        'rule',
      ),
    ).toBe(false)
  })

  it('rejects connections without chain information', () => {
    expect(isThroughProxyNode(makeConn({ chains: [] }), 'rule')).toBe(false)
    expect(
      isThroughProxyNode(makeConn({ chains: undefined as never }), 'rule'),
    ).toBe(false)
  })

  it('rejects chains that resolve to DIRECT/REJECT policy', () => {
    // group selected DIRECT: leaf chain still carries the policy name
    expect(
      isThroughProxyNode(makeConn({ chains: ['DIRECT', 'Proxy Group'] }), 'rule'),
    ).toBe(false)
    expect(
      isThroughProxyNode(makeConn({ chains: ['Node', 'REJECT'] }), 'rule'),
    ).toBe(false)
  })

  it('does not misread the rule type or payload as the policy', () => {
    // mihomo puts the policy in chains; rule/rulePayload carry the matcher
    const conn = makeConn({ rule: 'Match', rulePayload: 'DIRECT.example' })
    expect(isThroughProxyNode(conn, 'rule')).toBe(true)
  })

  it('trims whitespace around chain entries before matching', () => {
    expect(
      isThroughProxyNode(makeConn({ chains: ['  DIRECT  '] }), 'rule'),
    ).toBe(false)
    expect(isThroughProxyNode(makeConn({ chains: [' Node '] }), 'rule')).toBe(
      true,
    )
  })
})
