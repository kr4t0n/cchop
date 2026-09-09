import { useCallback, useEffect, useRef, useState } from 'react'
import type { RequestRecord, StatusSnapshot } from '../../src/types'

export type ConnectionState = 'connecting' | 'connected' | 'offline' | 'error'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isRequestRecord(value: unknown): value is RequestRecord {
  return isObject(value)
    && typeof value.id === 'string'
    && typeof value.method === 'string'
    && typeof value.path === 'string'
    && isNumber(value.status)
    && ['ok', 'upstream_error', 'cancelled', 'relay_error'].includes(String(value.outcome))
    && isDate(value.startedAt)
    && isNumber(value.durationMs)
    && isNumber(value.bytesIn)
    && isNumber(value.bytesOut)
}

function isSnapshot(value: unknown): value is StatusSnapshot {
  if (!isObject(value) || !isObject(value.relay) || !isObject(value.totals)
    || !isObject(value.latency) || !isObject(value.runtime)) return false

  const { relay, totals, latency, runtime } = value
  return typeof value.version === 'string'
    && isDate(value.startedAt)
    && isNumber(value.uptimeSeconds)
    && (value.state === 'ready' || value.state === 'draining')
    && typeof relay.host === 'string'
    && isNumber(relay.port)
    && typeof relay.upstream === 'string'
    && relay.authMode === 'subscription'
    && isNumber(relay.activeRequests)
    && isNumber(relay.maxConcurrent)
    && (relay.publicUrl === null || typeof relay.publicUrl === 'string')
    && ['requests', 'succeeded', 'failed', 'cancelled', 'bytesReceived', 'bytesSent']
      .every((key) => isNumber(totals[key]))
    && ['averageMs', 'p95Ms', 'lastMs'].every((key) => latency[key] === null || isNumber(latency[key]))
    && Array.isArray(value.recentRequests)
    && value.recentRequests.every(isRequestRecord)
    && ['nodeVersion', 'platform', 'arch'].every((key) => typeof runtime[key] === 'string')
}

class StatusRequestError extends Error {}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (isObject(body) && isObject(body.error) && typeof body.error.message === 'string') {
      return body.error.message.slice(0, 240)
    }
  } catch {
    // A proxy may return an HTML error page. Keep it out of the dashboard.
  }
  return `The status endpoint returned HTTP ${response.status}.`
}

export function useRelayStatus(token: string, onUnauthorized: () => void) {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [message, setMessage] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [isFetching, setIsFetching] = useState(false)
  const [paused, setPaused] = useState(false)
  const mounted = useRef(false)
  const activeRequest = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!token || (activeRequest.current && !activeRequest.current.signal.aborted)) return

    const controller = new AbortController()
    activeRequest.current = controller
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 8_000)
    const isCurrent = () => mounted.current && activeRequest.current === controller
    setIsFetching(true)

    try {
      const response = await fetch('/api/status', {
        headers: { 'X-Cchop-Admin-Key': token, Accept: 'application/json' },
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
      if (!isCurrent()) return
      if (response.status === 401 || response.status === 403) {
        onUnauthorized()
        return
      }
      if (!response.ok) throw new StatusRequestError(await responseError(response))

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new StatusRequestError('The status endpoint returned an unreadable response.')
      }
      if (!isSnapshot(body)) throw new StatusRequestError('The status response has an unsupported format. Refresh after updating cchop.')
      if (!isCurrent()) return

      setSnapshot(body)
      setUpdatedAt(new Date())
      setConnection('connected')
      setMessage(null)
    } catch (error) {
      if (!isCurrent() || (controller.signal.aborted && !timedOut)) return
      setConnection(error instanceof StatusRequestError ? 'error' : 'offline')
      setMessage(timedOut
        ? 'The status request timed out. Check that cchop is reachable, then refresh.'
        : error instanceof StatusRequestError
          ? error.message
          : 'The relay cannot be reached. Check that cchop is running, then refresh.')
    } finally {
      window.clearTimeout(timeout)
      if (isCurrent()) {
        activeRequest.current = null
        setIsFetching(false)
      }
    }
  }, [token, onUnauthorized])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeRequest.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (paused) return
    const initial = window.setTimeout(() => { void refresh() }, 0)
    const interval = window.setInterval(() => { void refresh() }, 3_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [paused, refresh])

  return { snapshot, connection, message, updatedAt, isFetching, paused, setPaused, refresh }
}
