type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

declare const OS_PLATFORM: Platform

type ValidationOutcome = import('@/services/bindings').ValidationOutcome

interface IConfigData {
  port: number
  mode: string
  ipv6: boolean
  'socket-port': number
  'allow-lan': boolean
  'log-level': string
  'mixed-port': number
  'redir-port': number
  'socks-port': number
  'tproxy-port': number
  'external-controller': string
  'external-controller-cors': {
    'allow-private-network': boolean
    'allow-origins': string[]
  }
  secret: string
  'unified-delay': boolean
  tun: {
    stack: string
    device: string
    'auto-route': boolean
    'auto-redirect'?: boolean
    'auto-detect-interface': boolean
    'dns-hijack': string[]
    'dns-mode'?: string
    'route-exclude-address'?: string[]
    'strict-route': boolean
    mtu: number
  }
  dns?: {
    enable?: boolean
    listen?: string
    'enhanced-mode'?: 'fake-ip' | 'redir-host'
    'fake-ip-range'?: string
    'fake-ip-range6'?: string
    'fake-ip-filter'?: string[]
    'fake-ip-filter-mode'?: 'blacklist' | 'whitelist'
    'prefer-h3'?: boolean
    'respect-rules'?: boolean
    nameserver?: string[]
    fallback?: string[]
    'default-nameserver'?: string[]
    'proxy-server-nameserver'?: string[]
    'direct-nameserver'?: string[]
    'direct-nameserver-follow-policy'?: boolean
    'nameserver-policy'?: Record<string, any>
    'use-hosts'?: boolean
    'use-system-hosts'?: boolean
    'fallback-filter'?: {
      geoip?: boolean
      'geoip-code'?: string
      ipcidr?: string[]
      domain?: string[]
    }
  }
  tunnels?: {
    network: string[]
    address: string
    target: string
    proxy?: string
  }[]
  'proxy-groups'?: IProxyGroupItem[]
}

interface IProxyItem {
  name: string
  type: string
  udp: boolean
  xudp: boolean
  tfo: boolean
  mptcp: boolean
  smux: boolean
  xhttp?: boolean
  xmux?: boolean
  history: {
    time: string
    delay: number
  }[]
  testUrl?: string
  all?: string[]
  now?: string
  hidden?: boolean
  icon?: string
  provider?: string // 记录是否来自provider
  fixed?: string // 记录固定(优先)的节点
}

type IProxyGroupItem = Omit<IProxyItem, 'all'> & {
  all: IProxyItem[]
}

interface ITrafficItem {
  up: number
  down: number
  up_rate?: number
  down_rate?: number
  last_updated?: number
  upTotal?: number
  downTotal?: number
}

interface IFormattedTrafficData {
  up_rate_formatted: string
  down_rate_formatted: string
  total_up_formatted: string
  total_down_formatted: string
  is_fresh: boolean
}

interface IFormattedMemoryData {
  inuse_formatted: string
  oslimit_formatted: string
  usage_percent: number
  is_fresh: boolean
}

interface ILogItem {
  type: string
  time?: string
  payload: string
}

type LogLevel = import('tauri-plugin-mihomo-api').LogLevel
type LogFilter = 'all' | 'debug' | 'info' | 'warn' | 'err'
type LogOrder = 'asc' | 'desc'

interface IClashLog {
  enable: boolean
  logLevel: LogLevel
  logFilter: LogFilter
  logOrder: LogOrder
}

interface IConnectionsItem {
  id: string
  metadata: {
    network: string
    type: string
    host: string
    sourceIP: string
    sourcePort: string
    destinationPort: string
    destinationIP?: string
    remoteDestination?: string
    process?: string
    processPath?: string
  }
  upload: number
  download: number
  start: string
  chains: string[]
  rule: string
  rulePayload: string
  curUpload?: number // upload speed, calculate at runtime
  curDownload?: number // download speed, calculate at runtime
}

interface IConnections {
  downloadTotal: number
  uploadTotal: number
  connections: IConnectionsItem[]
}

interface IConnectionSetting {
  layout: 'table' | 'list'
}

type IClashInfo = import('@/services/bindings').ClashInfo

type IProfileItem = import('@/services/bindings').PrfItem_Serialize

type IProfileOption = import('@/services/bindings').PrfOption_Deserialize

type IProfilesConfig = Partial<
  import('@/services/bindings').IProfiles_Serialize
>

type IVergeTestItem = import('@/services/bindings').IVergeTestItem
type IAddress = import('@/services/bindings').InterfaceAddress
type INetworkInterface = import('@/services/bindings').NetworkInterfaceView

interface ISeqProfileConfig {
  prepend: []
  append: []
  delete: []
}

interface IProxyGroupConfig {
  name: string
  type: 'select' | 'url-test' | 'fallback' | 'load-balance' | 'relay'
  proxies?: string[]
  use?: string[]
  url?: string
  interval?: number
  lazy?: boolean
  timeout?: number
  'max-failed-times'?: number
  'disable-udp'?: boolean
  'interface-name': string
  'routing-mark'?: number
  'include-all'?: boolean
  'include-all-proxies'?: boolean
  'include-all-providers'?: boolean
  filter?: string
  'exclude-filter'?: string
  'exclude-type'?: string
  'expected-status'?: string
  hidden?: boolean
  icon?: string
}

interface WsOptions {
  path?: string
  headers?: {
    [key: string]: string
  }
  'max-early-data'?: number
  'early-data-header-name'?: string
  'v2ray-http-upgrade'?: boolean
  'v2ray-http-upgrade-fast-open'?: boolean
}

interface HttpOptions {
  method?: string
  path?: string[]
  headers?: {
    [key: string]: string[]
  }
}

interface H2Options {
  path?: string
  host?: string | string[]
}

interface GrpcOptions {
  'grpc-service-name'?: string
  'grpc-user-agent'?: string
  'ping-interval'?: number
  'max-connections'?: number
  'min-streams'?: number
  'max-streams'?: number
}

interface EchOptions {
  enable?: boolean
  config?: string
  'query-server-name'?: string
}

interface ShadowTlsOptions {
  password?: string
  version?: 1 | 2 | 3
}

interface RestlsOptions {
  password?: string
  'version-hint'?: 'tls12' | 'tls13'
  'restls-script'?: string
}

interface JlsOptions {
  username?: string
  password?: string
}

interface XHttpReuseSettings {
  'max-concurrency'?: string | number
  'max-connections'?: string | number
  'c-max-reuse-times'?: string | number
  'h-max-request-times'?: string | number
  'h-max-reusable-secs'?: string | number
  'h-keep-alive-period'?: number
}

interface XHttpDownloadSettings {
  path?: string
  host?: string
  headers?: Record<string, string>
  'no-grpc-header'?: boolean
  'no-sse-header'?: boolean
  'x-padding-bytes'?: string
  'x-padding-obfs-mode'?: boolean
  'x-padding-key'?: string
  'x-padding-header'?: string
  'x-padding-placement'?: 'queryInHeader' | 'cookie' | 'header' | 'query'
  'x-padding-method'?: 'repeat-x' | 'tokenish'
  'uplink-http-method'?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  'session-placement'?: 'path' | 'query' | 'cookie' | 'header'
  'session-key'?: string
  'session-table'?: string
  'session-length'?: string
  'seq-placement'?: 'path' | 'query' | 'cookie' | 'header'
  'seq-key'?: string
  'uplink-data-placement'?: 'body' | 'cookie' | 'header' | 'auto'
  'uplink-data-key'?: string
  'uplink-chunk-size'?: string
  'sc-max-each-post-bytes'?: string
  'sc-min-posts-interval-ms'?: string
  'sc-max-buffered-posts'?: string
  'sc-stream-up-server-secs'?: string
  'reuse-settings'?: XHttpReuseSettings
  server?: string
  port?: number
  tls?: boolean
  alpn?: string[]
  'ech-opts'?: EchOptions
  'shadow-tls-opts'?: ShadowTlsOptions
  'restls-opts'?: RestlsOptions
  'jls-opts'?: JlsOptions
  'reality-opts'?: RealityOptions
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  servername?: string
  'client-fingerprint'?: ClientFingerprint
}

interface XHttpOptions {
  path?: string
  host?: string
  mode?: 'auto' | 'stream-one' | 'stream-up' | 'packet-up' | string
  headers?: Record<string, string>
  'no-grpc-header'?: boolean
  'no-sse-header'?: boolean
  'x-padding-bytes'?: string
  'x-padding-obfs-mode'?: boolean
  'x-padding-key'?: string
  'x-padding-header'?: string
  'x-padding-placement'?: 'queryInHeader' | 'cookie' | 'header' | 'query'
  'x-padding-method'?: 'repeat-x' | 'tokenish'
  'uplink-http-method'?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  'session-placement'?: 'path' | 'query' | 'cookie' | 'header'
  'session-key'?: string
  'session-table'?: string
  'session-length'?: string
  'seq-placement'?: 'path' | 'query' | 'cookie' | 'header'
  'seq-key'?: string
  'uplink-data-placement'?: 'body' | 'cookie' | 'header' | 'auto'
  'uplink-data-key'?: string
  'uplink-chunk-size'?: string
  'sc-max-each-post-bytes'?: string
  'sc-min-posts-interval-ms'?: string
  'sc-max-buffered-posts'?: string
  'sc-stream-up-server-secs'?: string
  'reuse-settings'?: XHttpReuseSettings
  'download-settings'?: XHttpDownloadSettings
}

interface RealityOptions {
  'public-key'?: string
  'short-id'?: string
  'support-x25519mlkem768'?: boolean
}

type ClientFingerprint =
  | 'none'
  | 'chrome'
  | 'firefox'
  | 'safari'
  | 'ios'
  | 'iOS'
  | 'android'
  | 'edge'
  | '360'
  | 'qq'
  | 'random'
  | 'chrome120'
  | 'firefox120'
  | 'safari16'
  | 'chrome_psk'
  | 'chrome_psk_shuffle'
  | 'chrome_padding_psk_shuffle'
  | 'chrome_pq'
  | 'chrome_pq_psk'
  | 'randomized'

type NetworkType =
  | 'ws'
  | 'http'
  | 'h2'
  | 'grpc'
  | 'tcp'
  | 'xhttp'
  | 'mkcp'
  | 'kcp'
  | 'mekya'
  | 'h3-l4proxy'

type CipherType =
  | 'none'
  | 'auto'
  | 'dummy'
  | 'zero'
  | 'aes-128-ccm'
  | 'aes-128-gcm'
  | 'aes-192-ccm'
  | 'aes-192-gcm'
  | 'aes-256-ccm'
  | 'aes-256-gcm'
  | 'ascon128'
  | 'ascon128a'
  | 'lea-128-gcm'
  | 'lea-192-gcm'
  | 'lea-256-gcm'
  | 'aes-128-gcm-siv'
  | 'aes-256-gcm-siv'
  | '2022-blake3-aes-128-ccm'
  | '2022-blake3-aes-128-gcm'
  | '2022-blake3-aes-256-ccm'
  | '2022-blake3-aes-256-gcm'
  | '2022-blake3-chacha8-poly1305'
  | '2022-blake3-chacha12-poly1305'
  | 'aes-128-cfb'
  | 'aes-192-cfb'
  | 'aes-256-cfb'
  | 'aes-128-ctr'
  | 'aes-192-ctr'
  | 'aes-256-ctr'
  | 'chacha20'
  | 'chacha20-ietf'
  | 'chacha20-ietf-poly1305'
  | 'chacha20-poly1305'
  | 'chacha8-ietf-poly1305'
  | 'chacha8-poly1305'
  | '2022-blake3-chacha20-poly1305'
  | 'rabbit128-poly1305'
  | 'xchacha20-ietf-poly1305'
  | 'xchacha8-ietf-poly1305'
  | 'xchacha8-poly1305'
  | 'xchacha20'
  | 'aegis-128l'
  | 'aegis-256'
  | 'aez-384'
  | 'deoxys-ii-256-128'
  | 'rc4-md5'

type BbrProfile = 'standard' | 'conservative' | 'aggressive'

interface IpStackOptions {
  mode?: 'auto' | 'gvisor' | 'mips'
  'congestion-controller'?: string
}

interface SmuxOptions {
  enabled?: boolean
  protocol?: 'smux' | 'yamux' | 'h2mux'
  'max-connections'?: number
  'min-streams'?: number
  'max-streams'?: number
  padding?: boolean
  statistic?: boolean
  'only-tcp'?: boolean
  'brutal-opts'?: {
    enabled?: boolean
    up?: string | number
    down?: string | number
  }
}

type MieruTransport = 'TCP' | 'UDP'
type MieruMultiplexing =
  | 'MULTIPLEXING_DEFAULT'
  | 'MULTIPLEXING_OFF'
  | 'MULTIPLEXING_LOW'
  | 'MULTIPLEXING_MIDDLE'
  | 'MULTIPLEXING_HIGH'
type MieruHandshakeMode =
  | 'HANDSHAKE_DEFAULT'
  | 'HANDSHAKE_STANDARD'
  | 'HANDSHAKE_NO_WAIT'

type SudokuAeadMethod = 'chacha20-poly1305' | 'aes-128-gcm' | 'none'
type SudokuTableType =
  | 'entropy'
  | 'prefer_entropy'
  | 'ascii'
  | 'prefer_ascii'
  | 'up_ascii_down_entropy'
  | 'up_entropy_down_ascii'
type SudokuHttpMaskMode = 'legacy' | 'stream' | 'poll' | 'auto' | 'ws'
type SudokuHttpMaskStrategy = 'random' | 'post' | 'websocket'
type SudokuHttpMaskMultiplex = 'off' | 'auto' | 'on'

interface SudokuHttpMaskOptions {
  disable?: boolean
  mode?: SudokuHttpMaskMode
  tls?: boolean
  host?: string
  'path-root'?: string
  multiplex?: SudokuHttpMaskMultiplex
}

interface AmneziaWgOption {
  version?: number
  jc?: number
  jmin?: number
  jmax?: number
  s1?: number
  s2?: number
  s3?: number
  s4?: number
  h1?: string
  h2?: string
  h3?: string
  h4?: string
  i1?: string
  i2?: string
  i3?: string
  i4?: string
  i5?: string
  j1?: string
  j2?: string
  j3?: string
  itime?: number
  'header-protection-key'?: string
  'content-padding-addition'?: string
  'rekey-after-time'?: string
  'rekey-timeout'?: string
  'reject-after-time'?: string
  'keepalive-timeout'?: string
  'max-handshake-attempts'?: string
  'random-trailers'?: boolean
  'disable-cookies'?: boolean
}

interface MkcpOptions {
  mtu?: number
  tti?: number
  'uplink-capacity'?: number
  'downlink-capacity'?: number
  congestion?: boolean
  'write-buffer'?: number
  'read-buffer'?: number
  seed?: string
  header?:
    | 'none'
    | 'noop'
    | 'srtp'
    | 'utp'
    | 'wechat-video'
    | 'wechat'
    | 'dtls'
    | 'wireguard'
}

interface MekyaOptions {
  url?: string
  'h2-pool-size'?: number
  'max-write-delay'?: number
  'max-request-size'?: number
  'polling-interval-initial'?: number
  'max-write-size'?: number
  'max-write-duration-ms'?: number
  'max-simultaneous-write-connection'?: number
  'packet-writing-buffer'?: number
  kcp?: MkcpOptions
}
// base
interface IProxyBaseConfig {
  tfo?: boolean
  mptcp?: boolean
  'interface-name'?: string
  'routing-mark'?: number
  'ip-version'?: 'dual' | 'ipv4' | 'ipv6' | 'ipv4-prefer' | 'ipv6-prefer'
  'dialer-proxy'?: string
}
// direct
interface IProxyDirectConfig extends IProxyBaseConfig {
  name: string
  type: 'direct'
}
// dns
interface IProxyDnsConfig extends IProxyBaseConfig {
  name: string
  type: 'dns'
}
// http
interface IProxyHttpConfig extends IProxyBaseConfig {
  name: string
  type: 'http'
  server?: string
  port?: number
  username?: string
  password?: string
  tls?: boolean
  sni?: string
  alpn?: string[]
  'ech-opts'?: EchOptions
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  headers?: {
    [key: string]: string
  }
}
// socks5
interface IProxySocks5Config extends IProxyBaseConfig {
  name: string
  type: 'socks5'
  server?: string
  port?: number
  username?: string
  password?: string
  tls?: boolean
  sni?: string
  alpn?: string[]
  'ech-opts'?: EchOptions
  udp?: boolean
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
}
// ssh
interface IProxySshConfig extends IProxyBaseConfig {
  name: string
  type: 'ssh'
  server?: string
  port?: number
  username?: string
  password?: string
  'private-key'?: string
  'private-key-passphrase'?: string
  'host-key'?: string | string[]
  'host-key-algorithms'?: string | string[]
}
// trojan
interface IProxyTrojanConfig extends IProxyBaseConfig {
  name: string
  type: 'trojan'
  server?: string
  port?: number
  password?: string
  alpn?: string[]
  sni?: string
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  udp?: boolean
  network?: NetworkType
  'ech-opts'?: EchOptions
  'shadow-tls-opts'?: ShadowTlsOptions
  'restls-opts'?: RestlsOptions
  'jls-opts'?: JlsOptions
  'reality-opts'?: RealityOptions
  'http-opts'?: HttpOptions
  'h2-opts'?: H2Options
  'grpc-opts'?: GrpcOptions
  'ws-opts'?: WsOptions
  'ss-opts'?: {
    enabled?: boolean
    method?: string
    password?: string
  }
  'client-fingerprint'?: ClientFingerprint
}
// anytls
interface IProxyAnyTLSConfig extends IProxyBaseConfig {
  name: string
  type: 'anytls'
  server?: string
  port?: number
  password?: string
  alpn?: string[]
  sni?: string
  'ech-opts'?: EchOptions
  'shadow-tls-opts'?: ShadowTlsOptions
  'restls-opts'?: RestlsOptions
  'jls-opts'?: JlsOptions
  'client-fingerprint'?: ClientFingerprint
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  udp?: boolean
  'client-metadata'?: string
  'idle-session-check-interval'?: number
  'idle-session-timeout'?: number
  'min-idle-session'?: number
  'disable-reuse'?: boolean
}
// tuic
interface IProxyTuicConfig extends IProxyBaseConfig {
  name: string
  type: 'tuic'
  server?: string
  port?: number
  token?: string
  uuid?: string
  password?: string
  ip?: string
  'heartbeat-interval'?: number
  alpn?: string[]
  'reduce-rtt'?: boolean
  'request-timeout'?: number
  'udp-relay-mode'?: string
  'congestion-controller'?: string
  'disable-sni'?: boolean
  'max-udp-relay-packet-size'?: number
  'fast-open'?: boolean
  'max-open-streams'?: number
  cwnd?: number
  'bbr-profile'?: BbrProfile
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  ca?: string
  'ca-str'?: string
  'recv-window-conn'?: number
  'recv-window'?: number
  'disable-mtu-discovery'?: boolean
  'max-datagram-frame-size'?: number
  sni?: string
  'ech-opts'?: EchOptions
  'udp-over-stream'?: boolean
  'udp-over-stream-version'?: number
}
// mieru
interface IProxyMieruConfig extends IProxyBaseConfig {
  name: string
  type: 'mieru'
  server?: string
  port?: number
  'port-range'?: string
  transport?: MieruTransport
  udp?: boolean
  username?: string
  password?: string
  multiplexing?: MieruMultiplexing
  'handshake-mode'?: MieruHandshakeMode | string
  'traffic-pattern'?: string
}
// masque
interface IProxyMasqueConfig extends IProxyBaseConfig {
  name: string
  type: 'masque'
  server?: string
  port?: number
  'private-key'?: string
  'public-key'?: string
  ip?: string
  ipv6?: string
  uri?: string
  sni?: string
  mtu?: number
  udp?: boolean
  'handshake-timeout'?: number
  'skip-cert-verify'?: boolean
  network?: NetworkType
  'congestion-controller'?: string
  cwnd?: number
  'bbr-profile'?: BbrProfile
  'ip-stack'?: IpStackOptions
  'remote-dns-resolve'?: boolean
  dns?: string[]
}
// vless
interface IProxyVlessConfig extends IProxyBaseConfig {
  name: string
  type: 'vless'
  server?: string
  port?: number
  uuid?: string
  flow?: string
  tls?: boolean
  alpn?: string[]
  udp?: boolean
  'packet-addr'?: boolean
  xudp?: boolean
  'packet-encoding'?: string
  network?: NetworkType
  'ech-opts'?: EchOptions
  'shadow-tls-opts'?: ShadowTlsOptions
  'restls-opts'?: RestlsOptions
  'jls-opts'?: JlsOptions
  'reality-opts'?: RealityOptions
  'http-opts'?: HttpOptions
  'h2-opts'?: H2Options
  'grpc-opts'?: GrpcOptions
  'ws-opts'?: WsOptions
  'xhttp-opts'?: XHttpOptions
  'ws-path'?: string
  'ws-headers'?: {
    [key: string]: string
  }
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  servername?: string
  'client-fingerprint'?: ClientFingerprint
  encryption?: string
}
// vmess
interface IProxyVmessConfig extends IProxyBaseConfig {
  name: string
  type: 'vmess'
  server?: string
  port?: number
  uuid?: string
  alterId?: number
  cipher?: CipherType
  udp?: boolean
  network?: NetworkType
  tls?: boolean
  alpn?: string[]
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  servername?: string
  'ech-opts'?: EchOptions
  'shadow-tls-opts'?: ShadowTlsOptions
  'restls-opts'?: RestlsOptions
  'jls-opts'?: JlsOptions
  'reality-opts'?: RealityOptions
  'tlsmirror-opts'?: Record<string, any>
  'mekya-opts'?: MekyaOptions
  'mkcp-opts'?: MkcpOptions
  'http-opts'?: HttpOptions
  'h2-opts'?: H2Options
  'grpc-opts'?: GrpcOptions
  'ws-opts'?: WsOptions
  'packet-addr'?: boolean
  xudp?: boolean
  'packet-encoding'?: string
  'global-padding'?: boolean
  'authenticated-length'?: boolean
  'client-fingerprint'?: ClientFingerprint
}
interface WireGuardPeerOptions {
  server?: string
  port?: number
  'public-key'?: string
  'pre-shared-key'?: string
  reserved?: number[]
  'allowed-ips'?: string[]
}
// wireguard
interface IProxyWireguardConfig extends IProxyBaseConfig, WireGuardPeerOptions {
  name: string
  type: 'wireguard'
  ip?: string
  ipv6?: string
  'private-key'?: string
  workers?: number
  mtu?: number
  udp?: boolean
  'persistent-keepalive'?: number
  'ip-stack'?: IpStackOptions
  'amnezia-wg-option'?: AmneziaWgOption
  peers?: WireGuardPeerOptions[]
  'remote-dns-resolve'?: boolean
  dns?: string[]
  'refresh-server-ip-interval'?: number
}
// hysteria
interface IProxyHysteriaConfig extends IProxyBaseConfig {
  name: string
  type: 'hysteria'
  server?: string
  port?: number
  ports?: string
  protocol?: string
  'obfs-protocol'?: string
  up?: string
  'up-speed'?: number
  down?: string
  'down-speed'?: number
  auth?: string
  'auth-str'?: string
  obfs?: string
  sni?: string
  'skip-cert-verify'?: boolean
  fingerprint?: string
  alpn?: string[]
  ca?: string
  'ca-str'?: string
  'recv-window-conn'?: number
  'recv-window'?: number
  'disable-mtu-discovery'?: boolean
  'fast-open'?: boolean
  'hop-interval'?: number | string
}
// hysteria2
interface IProxyHysteria2Config extends IProxyBaseConfig {
  name: string
  type: 'hysteria2'
  server?: string
  port?: number
  ports?: string
  'hop-interval'?: number | string
  protocol?: string
  'obfs-protocol'?: string
  up?: string
  down?: string
  password?: string
  obfs?: string
  'obfs-password'?: string
  'obfs-min-packet-size'?: number
  'obfs-max-packet-size'?: number
  sni?: string
  'ech-opts'?: EchOptions
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  alpn?: string[]
  ca?: string
  'ca-str'?: string
  cwnd?: number
  'bbr-profile'?: BbrProfile
  'udp-mtu'?: number
  'handshake-timeout'?: number
  'realm-opts'?: Record<string, any>
  'initial-stream-receive-window'?: number
  'max-stream-receive-window'?: number
  'initial-connection-receive-window'?: number
  'max-connection-receive-window'?: number
}
// shadowsocks
interface IProxyShadowsocksConfig extends IProxyBaseConfig {
  name: string
  type: 'ss'
  server?: string
  port?: number
  password?: string
  cipher?: CipherType
  udp?: boolean
  plugin?:
    | 'obfs'
    | 'v2ray-plugin'
    | 'shadow-tls'
    | 'restls'
    | 'jls'
    | 'gost-plugin'
    | 'kcptun'
  'plugin-opts'?: {
    mode?: string
    host?: string
    username?: string
    password?: string
    path?: string
    tls?: boolean | string
    'ech-opts'?: EchOptions
    fingerprint?: string
    certificate?: string
    'private-key'?: string
    headers?: {
      [key: string]: string
    }
    'skip-cert-verify'?: boolean
    'name-cert-verify'?: string
    version?: number
    alpn?: string[]
    mux?: boolean
    'v2ray-http-upgrade'?: boolean
    'v2ray-http-upgrade-fast-open'?: boolean
    'version-hint'?: string
    'restls-script'?: string
    key?: string
    crypt?: string
    conn?: number
    autoexpire?: number
    scavengettl?: number
    mtu?: number
    ratelimit?: number
    sndwnd?: number
    rcvwnd?: number
    datashard?: number
    parityshard?: number
    dscp?: number
    nocomp?: boolean
    acknodelay?: boolean
    nodelay?: number
    interval?: number
    resend?: number
    nc?: number
    sockbuf?: number
    smuxver?: number
    smuxbuf?: number
    framesize?: number
    streambuf?: number
    keepalive?: number
  }
  'udp-over-tcp'?: boolean
  'udp-over-tcp-version'?: number
  'client-fingerprint'?: ClientFingerprint
}
// sudoku
interface IProxySudokuConfig extends IProxyBaseConfig {
  name: string
  type: 'sudoku'
  server?: string
  port?: number
  key?: string
  'aead-method'?: SudokuAeadMethod
  'padding-min'?: number
  'padding-max'?: number
  'table-type'?: SudokuTableType
  'enable-pure-downlink'?: boolean
  'http-mask'?: boolean
  'http-mask-mode'?: SudokuHttpMaskMode
  'http-mask-tls'?: boolean
  'http-mask-host'?: string
  'path-root'?: string
  multiplex?: SudokuHttpMaskMultiplex
  'http-mask-strategy'?: SudokuHttpMaskStrategy
  'http-mask-multiplex'?: SudokuHttpMaskMultiplex
  httpmask?: SudokuHttpMaskOptions
  'custom-table'?: string
  'custom-tables'?: string[]
}
// shadowsocksR
interface IProxyshadowsocksRConfig extends IProxyBaseConfig {
  name: string
  type: 'ssr'
  server?: string
  port?: number
  password?: string
  cipher?: CipherType
  obfs?: string
  'obfs-param'?: string
  protocol?: string
  'protocol-param'?: string
  udp?: boolean
}
// sing-mux
interface IProxySmuxConfig {
  smux?: SmuxOptions
}
// snell
interface IProxySnellConfig extends IProxyBaseConfig {
  name: string
  type: 'snell'
  server?: string
  port?: number
  psk?: string
  udp?: boolean
  version?: number
  reuse?: boolean
  mode?: 'default' | 'unshaped' | 'unsafe-raw'
  'obfs-opts'?: Record<string, any>
  'client-fingerprint'?: ClientFingerprint
}
// trusttunnel
interface IProxyTrustTunnelConfig extends IProxyBaseConfig {
  name: string
  type: 'trusttunnel'
  server?: string
  port?: number
  username?: string
  password?: string
  alpn?: string[]
  sni?: string
  'ech-opts'?: EchOptions
  'client-fingerprint'?: ClientFingerprint
  'skip-cert-verify'?: boolean
  'name-cert-verify'?: string
  fingerprint?: string
  certificate?: string
  'private-key'?: string
  udp?: boolean
  'health-check'?: boolean
  quic?: boolean
  'congestion-controller'?: string
  cwnd?: number
  'bbr-profile'?: BbrProfile
  'max-connections'?: number
  'min-streams'?: number
  'max-streams'?: number
}
// shadowquic
interface IProxyShadowQuicConfig extends IProxyBaseConfig {
  name: string
  type: 'shadowquic'
  server?: string
  port?: number
  username?: string
  password?: string
  sni?: string
  alpn?: string[]
  'quic-versions'?: string[]
  'udp-over-stream'?: boolean
  'zero-rtt'?: boolean
  'keep-alive-interval'?: number
  'congestion-controller'?: string
  up?: string
  down?: string
  cwnd?: number
  'bbr-profile'?: BbrProfile
  'recv-window-conn'?: number
  'recv-window'?: number
  'disable-mtu-discovery'?: boolean
  'max-datagram-frame-size'?: number
  'max-open-streams'?: number
}
interface IProxyConfig
  extends IProxyBaseConfig,
    IProxyDirectConfig,
    IProxyDnsConfig,
    IProxyHttpConfig,
    IProxySocks5Config,
    IProxySshConfig,
    IProxyTrojanConfig,
    IProxyAnyTLSConfig,
    IProxyTuicConfig,
    IProxyMieruConfig,
    IProxyMasqueConfig,
    IProxyVlessConfig,
    IProxyVmessConfig,
    IProxyWireguardConfig,
    IProxyHysteriaConfig,
    IProxyHysteria2Config,
    IProxyShadowsocksConfig,
    IProxySudokuConfig,
    IProxyshadowsocksRConfig,
    IProxySmuxConfig,
    IProxySnellConfig,
    IProxyTrustTunnelConfig,
    IProxyShadowQuicConfig {
  type:
    | 'ss'
    | 'ssr'
    | 'direct'
    | 'dns'
    | 'snell'
    | 'http'
    | 'trojan'
    | 'anytls'
    | 'hysteria'
    | 'hysteria2'
    | 'tuic'
    | 'wireguard'
    | 'ssh'
    | 'socks5'
    | 'masque'
    | 'vmess'
    | 'vless'
    | 'mieru'
    | 'sudoku'
    | 'trusttunnel'
    | 'shadowquic'
}

type IVergeConfig = Omit<
  Partial<import('@/services/bindings').IVerge_Serialize>,
  'theme_setting'
> & {
  theme_setting?:
    | (import('@/services/bindings').IVergeTheme & {
        background_image?: string
        background_blend_mode?: string
        background_opacity?: number
      })
    | null
}

type IWebDavFile = import('@/services/bindings').WebDavFile & {
  filename: string
}

type ILocalBackupFile = import('@/services/bindings').LocalBackupFile

interface IWebDavConfig {
  url: string
  username: string
  password: string
}

interface ITrafficDataPoint {
  up: number
  down: number
  timestamp: number
}

interface ISamplingConfig {
  rawDataMinutes: number
  compressedDataMinutes: number
  compressionRatio: number
}

interface ISamplerStats {
  rawBufferSize: number
  compressedBufferSize: number
  compressionQueueSize: number
  totalMemoryPoints: number
}

interface ITrafficWorkerInitMessage {
  type: 'init'
  config: ISamplingConfig & {
    snapshotIntervalMs: number
    defaultRangeMinutes: number
  }
}

interface ITrafficWorkerAppendMessage {
  type: 'append'
  payload: {
    up: number
    down: number
    timestamp?: number
  }
}

interface ITrafficWorkerSetRangeMessage {
  type: 'setRange'
  minutes: number
}

interface ITrafficWorkerRequestSnapshotMessage {
  type: 'requestSnapshot'
}

type TrafficWorkerRequestMessage =
  | ITrafficWorkerInitMessage
  | ITrafficWorkerAppendMessage
  | ITrafficWorkerSetRangeMessage
  | ITrafficWorkerRequestSnapshotMessage

interface ITrafficWorkerSnapshotMessage {
  type: 'snapshot'
  dataPoints: ITrafficDataPoint[]
  samplerStats: ISamplerStats
  lastTimestamp?: number
}

interface ITrafficWorkerLogMessage {
  type: 'log'
  message: string
}

type TrafficWorkerResponseMessage =
  | ITrafficWorkerSnapshotMessage
  | ITrafficWorkerLogMessage
