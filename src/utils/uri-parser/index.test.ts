import { describe, expect, test } from 'vitest'

import parseUri from './index'

describe('uri-parser', () => {
  test('parses vless ws without httpupgrade regression and supports ed', () => {
    const proxy = parseUri(
      'vless://11111111-1111-4111-8111-111111111111@example.com:443' +
        '?type=ws&path=%2Fws%3Fed%3D2048&host=cdn.example.com' +
        '&security=tls&sni=tls.example.com#WS%20Node',
    )

    expect(proxy.type).toBe('vless')
    if (proxy.type !== 'vless') return

    expect(proxy.name).toBe('WS Node')
    expect(proxy.server).toBe('example.com')
    expect(proxy.port).toBe(443)
    expect(proxy.network).toBe('ws')
    expect(proxy['ws-opts']).toMatchObject({
      path: '/ws',
      headers: { Host: 'cdn.example.com' },
      'max-early-data': 2048,
    })
    expect(proxy['ws-opts']?.['v2ray-http-upgrade']).toBeUndefined()
  })

  test('parses vless xhttp/splithttp extra xmux, downloadSettings, ech, pqv', () => {
    const extra = JSON.stringify({
      scMaxEachPostBytes: '1000000',
      noSSEHeader: true,
      xmux: {
        maxConcurrency: { from: 16, to: 32 },
        hMaxRequestTimes: '600-900',
        hKeepAlivePeriod: 60,
      },
      downloadSettings: {
        address: 'dl.example.com',
        port: 8443,
        network: 'xhttp',
        security: 'reality',
        realitySettings: {
          publicKey: 'dl-pub',
          shortId: 'abcd',
        },
        xhttpSettings: {
          path: '/dl',
          host: 'cdn-dl.example.com',
          xmux: {
            maxConnections: 4,
          },
        },
      },
    })

    const query = new URLSearchParams({
      type: 'splithttp',
      security: 'reality',
      pbk: 'main-pub',
      sid: '1234',
      pqv: 'ignored-pqv',
      host: 'xhttp.example.com',
      path: '/xhttp',
      mode: 'packet-up',
      ech: 'dGVzdCthYmM=',
      note: 'user@example.com',
      extra,
    }).toString()

    const proxy = parseUri(
      `vless://11111111-1111-4111-8111-111111111111@main.example.com:443?${query}#XHttpNode`,
    )

    expect(proxy.type).toBe('vless')
    if (proxy.type !== 'vless') return

    expect(proxy.server).toBe('main.example.com')
    expect(proxy.servername).toBe('xhttp.example.com')
    expect(proxy.network).toBe('xhttp')
    expect(proxy['ech-opts']).toMatchObject({
      enable: true,
      config: 'dGVzdCthYmM=',
    })
    expect(proxy['xhttp-opts']).toMatchObject({
      path: '/xhttp',
      host: 'xhttp.example.com',
      mode: 'packet-up',
      'no-sse-header': true,
      'sc-max-each-post-bytes': '1000000',
      'reuse-settings': {
        'max-concurrency': '16-32',
        'h-max-request-times': '600-900',
        'h-keep-alive-period': 60,
      },
      'download-settings': {
        server: 'dl.example.com',
        port: 8443,
        path: '/dl',
        host: 'cdn-dl.example.com',
        'reality-opts': {
          'public-key': 'dl-pub',
          'short-id': 'abcd',
        },
        'reuse-settings': {
          'max-connections': '4',
        },
      },
    })
  })

  test('maps trojan fp to client-fingerprint and handles unknown ss plugins', () => {
    const trojan = parseUri(
      'trojan://secret@example.com:443?type=h2&host=h2.example.com&path=/h2&fp=chrome#TrojanH2',
    )
    expect(trojan.type).toBe('trojan')
    if (trojan.type === 'trojan') {
      expect(trojan['client-fingerprint']).toBe('chrome')
      expect(trojan.network).toBe('h2')
    }

    const ssShadowTls = parseUri(
      'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@ss.example.com:443?plugin=shadow-tls%3Bhost%3Dstls.example.com%3Bpassword%3Dpw%3Bversion%3D3#SSShadowTls',
    )
    expect(ssShadowTls.type).toBe('ss')
    if (ssShadowTls.type === 'ss') {
      expect(ssShadowTls.plugin).toBe('shadow-tls')
      expect(ssShadowTls['plugin-opts']).toMatchObject({
        host: 'stls.example.com',
        password: 'pw',
        version: 3,
      })
    }

    const ssCustom = parseUri(
      'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@ss2.example.com:8388?plugin=custom-plug%3Bfoo%3Dbar#SSCustom',
    )
    expect(ssCustom.type).toBe('ss')
  })

  test('parses tuic v4, wireguard defaults, mieru, sudoku and rejects yaml-only schemes', () => {
    const tuic4 = parseUri(
      'tuic://mytoken@tuic.example.com:443?udp_over_stream=1&congestion_controller=bbr#TuicV4',
    )
    expect(tuic4.type).toBe('tuic')
    if (tuic4.type === 'tuic') {
      expect(tuic4.token).toBe('mytoken')
      expect(tuic4['udp-over-stream']).toBe(true)
    }

    const wg = parseUri(
      'wireguard://privKeyHere@wg.example.com?publickey=pubKeyHere&reserved=AQID#WGNode',
    )
    expect(wg.type).toBe('wireguard')
    if (wg.type === 'wireguard') {
      expect(wg.port).toBe(51820)
      expect(wg.reserved).toEqual([1, 2, 3])
    }

    const mieru = parseUri(
      'mieru://alice:secret@mieru.example.com:2012-2016?protocol=TCP#MieruRange',
    )
    expect(mieru.type).toBe('mieru')
    if (mieru.type === 'mieru') {
      expect(mieru['port-range']).toBe('2012-2016')
    }

    const sudokuPayload = btoa(
      JSON.stringify({
        server: 'sudoku.example.com',
        port: 8443,
        key: 'mykey',
        aead: 'aes-128-gcm',
        name: 'SudokuNode',
      }),
    )
    const sudoku = parseUri(`sudoku://${sudokuPayload}`)
    expect(sudoku.type).toBe('sudoku')
    if (sudoku.type === 'sudoku') {
      expect(sudoku.server).toBe('sudoku.example.com')
      expect(sudoku.port).toBe(8443)
      expect(sudoku['aead-method']).toBe('aes-128-gcm')
    }

    expect(() =>
      parseUri('shadowquic://user:pass@sq.example.com:443#SQ'),
    ).toThrow()
  })
})
