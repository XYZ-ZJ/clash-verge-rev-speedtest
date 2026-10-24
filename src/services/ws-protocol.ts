/**
 * Shared protocol conventions for mihomo websocket text frames.
 *
 * All websocket consumers (connections, logs, traffic, memory) sniff this
 * prefix to detect a transport-level error frame and trigger a reconnect.
 * Keep it in one place: the backend wording is load-bearing, and scattered
 * string literals drift silently when it changes.
 */
export const WS_ERROR_PREFIX = 'Websocket error'
