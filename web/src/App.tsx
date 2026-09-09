import { useCallback, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { StatusSnapshot } from '../../src/types'
import { bytes, duration, endpointHost, number, time, uptime } from './format'
import { Icon, RelayMark } from './Icons'
import { RequestTable } from './RequestTable'
import { useRelayStatus } from './useRelayStatus'

const buttonClass = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-ink outline-none transition-colors hover:border-slate-300 hover:bg-canvas focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none'

function Header({ onSignOut }: { onSignOut?: () => void }) {
  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex min-h-19 max-w-7xl items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
        <a href="#main" aria-label="cchop, skip to content" className="flex shrink-0 items-center gap-2.5 rounded-lg text-ink outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-4">
          <RelayMark />
          <span className="font-mono text-[27px] font-bold tracking-[-0.09em]">cchop</span>
        </a>
        <div className="flex items-center gap-5">
          <span className="hidden text-xs text-muted sm:block">Relay operations</span>
          {onSignOut ? <button type="button" className={buttonClass} onClick={onSignOut}><Icon name="logout" />Sign out</button>
            : <span className="inline-flex items-center gap-1.5 text-xs text-muted"><Icon name="lock" className="size-3.5" />Private access</span>}
        </div>
      </div>
    </header>
  )
}

function SignIn({ onSignIn, message }: { onSignIn: (key: string) => void; message: string | null }) {
  const [key, setKey] = useState('')
  const [validation, setValidation] = useState<string | null>(null)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = key.trim()
    if (!value) {
      setValidation('Enter the admin key configured for this relay.')
      return
    }
    onSignIn(value)
  }

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 items-center px-5 py-12 sm:px-8 sm:py-20">
      <div className="grid w-full overflow-hidden rounded-2xl border border-line bg-white lg:grid-cols-[1fr_0.95fr]">
        <section className="relative flex flex-col justify-between border-b border-line bg-[#eaf0fb] px-7 py-9 sm:p-12 lg:min-h-136 lg:border-b-0 lg:border-r">
          <div>
            <p className="mb-7 flex items-center gap-2 text-xs font-semibold text-signal"><span className="h-px w-6 bg-signal" aria-hidden="true" />Claude Code relay</p>
            <h1 className="max-w-sm font-display text-[38px] font-semibold leading-[1.12] tracking-[-0.04em] sm:text-5xl">Your relay,<br />in view.</h1>
            <p className="mt-5 max-w-xs text-sm leading-7 text-muted">Follow requests, check the connection, and see how your relay is running.</p>
          </div>
          <div className="mt-10" aria-label="Request route: Claude Code to cchop to upstream">
            <div className="flex items-center">
              <div className="flex size-10 items-center justify-center rounded-lg border border-white bg-white/70 font-mono text-xs font-semibold text-muted">cc</div>
              <span className="mx-2 flex flex-1 items-center text-signal/50" aria-hidden="true"><span className="h-px flex-1 bg-signal/25" /><Icon name="arrow" /></span>
              <RelayMark className="size-12 text-signal" />
              <span className="mx-2 flex flex-1 items-center text-signal/50" aria-hidden="true"><span className="h-px flex-1 bg-signal/25" /><Icon name="arrow" /></span>
              <span className="flex size-10 items-center justify-center rounded-lg border border-white bg-white/70 text-muted"><Icon name="server" className="size-5" /></span>
            </div>
            <div className="mt-3 flex justify-between text-[10px] font-medium text-muted"><span>Claude Code</span><span className="-ml-5 font-mono font-bold text-signal">cchop</span><span>Upstream</span></div>
          </div>
        </section>
        <section className="flex flex-col justify-center px-7 py-9 sm:p-12" aria-labelledby="signin-title">
          <span className="mb-6 flex size-10 items-center justify-center rounded-xl border border-line text-muted"><Icon name="lock" className="size-5" /></span>
          <h2 id="signin-title" className="font-display text-2xl font-semibold tracking-tight">Open your dashboard</h2>
          <p className="mt-3 text-sm leading-6 text-muted">Enter the admin key configured for this relay.</p>
          {(message || validation) && <p role="alert" id="signin-error" className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-900">{validation || message}</p>}
          <form onSubmit={submit} className="mt-7">
            <label htmlFor="admin-key" className="mb-2 block text-xs font-semibold">Admin key</label>
            <input id="admin-key" name="admin-key" type="password" value={key} onChange={(event) => { setKey(event.target.value); setValidation(null) }} autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={4096} aria-describedby={message || validation ? 'signin-error key-note' : 'key-note'} aria-invalid={Boolean(validation)} placeholder="Enter your admin key" className="block h-12 w-full rounded-lg border border-line bg-white px-3.5 font-mono text-sm text-ink outline-none transition-colors placeholder:font-sans placeholder:text-slate-400 focus:border-signal focus:ring-3 focus:ring-signal/10 motion-reduce:transition-none" />
            <button type="submit" className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-signal px-4 py-3 text-sm font-semibold text-white outline-none transition-colors hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 motion-reduce:transition-none">Connect to relay<Icon name="arrow" /></button>
          </form>
          <p id="key-note" className="mt-5 text-xs leading-6 text-muted">Use <code className="font-mono text-[11px]">CCHOP_ADMIN_TOKEN</code> from your relay’s <code className="font-mono text-[11px]">credentials.env</code> file. The key stays in this tab’s memory; reloading signs you out.</p>
        </section>
      </div>
    </main>
  )
}

function Route({ snapshot, live }: { snapshot: StatusSnapshot; live: boolean }) {
  return (
    <section aria-label="Configured request route" className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="grid divide-y divide-line sm:grid-cols-[1fr_1.15fr_1fr] sm:divide-x sm:divide-y-0">
        <div className="flex items-center gap-4 px-5 py-5 sm:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas font-mono text-xs font-semibold text-muted">cc</span>
          <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Client</p><p className="mt-1 text-sm font-semibold">Claude Code</p></div>
          <Icon name="arrow" className="ml-auto size-4 text-slate-300" />
        </div>
        <div className="flex items-center gap-4 bg-signal/4 px-5 py-5 sm:px-6">
          <RelayMark className="size-10 text-signal" />
          <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-signal">Relay</p><p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm font-bold">cchop<span className="font-sans text-[11px] font-normal text-muted">{live ? snapshot.state === 'ready' ? 'Accepting requests' : 'Draining requests' : 'Last reported configuration'}</span></p></div>
          <Icon name="arrow" className="ml-auto size-4 text-signal/40" />
        </div>
        <div className="flex min-w-0 items-center gap-4 px-5 py-5 sm:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-muted"><Icon name="server" className="size-5" /></span>
          <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Upstream destination</p><p className="mt-1 break-all font-mono text-xs font-medium">{endpointHost(snapshot.relay.upstream)}</p></div>
        </div>
      </div>
    </section>
  )
}

function Metric({ label, value, detail, children }: { label: string; value: string; detail: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-5 sm:px-6">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-3 flex flex-wrap items-baseline gap-2"><p className="min-w-0 break-all font-display text-3xl font-semibold tracking-tight tabular-nums">{value}</p>{children}</div>
      <p className="mt-2 text-[11px] leading-5 text-muted">{detail}</p>
    </div>
  )
}

function Detail({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="py-3"><dt className="text-[11px] text-muted">{label}</dt><dd className={`mt-1.5 break-all text-xs leading-5 ${mono ? 'font-mono' : ''}`}>{children}</dd></div>
}

function DetailsPanel({ snapshot }: { snapshot: StatusSnapshot }) {
  const relayAddress = `${snapshot.relay.host.includes(':') ? `[${snapshot.relay.host}]` : snapshot.relay.host}:${snapshot.relay.port}`
  return (
    <aside className="grid min-w-0 content-start gap-5 sm:grid-cols-2 xl:grid-cols-1" aria-label="Relay diagnostics">
      <section className="rounded-xl border border-line bg-white p-5 sm:p-6" aria-labelledby="latency-title">
        <h2 id="latency-title" className="font-display text-base font-semibold tracking-tight">Request latency</h2>
        <p className="mt-1 text-xs text-muted">Recent request window</p>
        <dl className="mt-5 divide-y divide-line">
          {[{ label: 'Average', value: snapshot.latency.averageMs }, { label: '95th percentile', value: snapshot.latency.p95Ms }, { label: 'Last completed', value: snapshot.latency.lastMs }].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between gap-3 py-3 first:pt-0"><dt className="text-xs text-muted">{label}</dt><dd className="whitespace-nowrap font-mono text-sm font-medium tabular-nums">{duration(value)}</dd></div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] leading-5 text-muted">Full request duration, including streaming. A dash means no measurement yet.</p>
      </section>
      <section className="rounded-xl border border-line bg-white p-5 sm:p-6" aria-labelledby="instance-title">
        <h2 id="instance-title" className="font-display text-base font-semibold tracking-tight">This instance</h2>
        <dl className="mt-2 divide-y divide-line">
          <Detail label="Public relay URL" mono>{snapshot.relay.publicUrl || 'Not configured'}</Detail>
          <Detail label="Relay listener" mono>{relayAddress}</Detail>
          <Detail label="Upstream" mono>{snapshot.relay.upstream}</Detail>
          <Detail label="Authentication">Remote subscription OAuth</Detail>
          <Detail label="Runtime" mono>Node {snapshot.runtime.nodeVersion}<br />{snapshot.runtime.platform} / {snapshot.runtime.arch}</Detail>
          <Detail label="Started"><time dateTime={snapshot.startedAt}>{new Date(snapshot.startedAt).toLocaleString()}</time></Detail>
        </dl>
      </section>
    </aside>
  )
}

function Dashboard({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const { snapshot, connection, message, updatedAt, isFetching, paused, setPaused, refresh } = useRelayStatus(token, onUnauthorized)
  const connected = connection === 'connected'
  const live = connected && !paused
  const statusText = connection === 'connecting' ? 'Connecting' : connection === 'offline' ? 'Disconnected'
    : connection === 'error' ? 'Status unavailable' : paused ? 'Updates paused' : snapshot?.state === 'draining' ? 'Draining' : 'Relay ready'
  const statusColor = connected && !paused && snapshot?.state === 'ready' ? 'bg-teal/8 text-teal'
    : connection === 'offline' || connection === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'

  return (
    <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-5 py-7 sm:px-8 sm:py-9 lg:px-10">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted">Operations / Overview</p>
          <h1 className="mt-2 font-display text-[28px] font-semibold tracking-[-0.035em] sm:text-[32px]">Relay overview</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
            <span role="status" className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold ${statusColor}`}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{statusText}</span>
            {snapshot && <span>Uptime {uptime(snapshot.uptimeSeconds)}</span>}
            {updatedAt && <span>Updated <time dateTime={updatedAt.toISOString()}>{time(updatedAt)}</time></span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" className={buttonClass} onClick={() => { setPaused((value) => !value) }} aria-pressed={paused}><Icon name={paused ? 'play' : 'pause'} />{paused ? 'Resume updates' : 'Pause updates'}</button>
          <button type="button" className={buttonClass} disabled={isFetching} onClick={() => { void refresh() }}><Icon name="refresh" className={`size-4 ${isFetching ? 'motion-safe:animate-spin' : ''}`} />{isFetching ? 'Refreshing' : 'Refresh'}</button>
        </div>
      </div>

      {message && <div role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-900"><Icon name="warning" className="mt-0.5 size-4" /><div><p className="text-sm font-medium">{message}</p><p className="mt-1 text-xs leading-6">{snapshot ? 'The values below are from the last successful update.' : 'No status data has been received.'}{!paused && ' Retrying automatically every 3 seconds.'}</p></div></div>}
      {paused && !message && <div role="status" className="mb-5 rounded-xl border border-line bg-white px-5 py-3 text-xs leading-6 text-muted">Updates are paused. The relay continues running. Refresh once or resume updates to retrieve its current state.</div>}
      {snapshot?.state === 'draining' && connected && <div role="status" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3 text-xs leading-6 text-amber-900">The relay is shutting down. Existing requests are draining; new requests are no longer accepted.</div>}

      {snapshot ? (
        <div className="space-y-5">
          <Route snapshot={snapshot} live={live} />
          <section aria-label="Request totals since process start" className="grid grid-cols-2 divide-x divide-line overflow-hidden rounded-xl border border-line bg-white lg:grid-cols-4">
            <Metric label="Total requests" value={number(snapshot.totals.requests)} detail="Since process start" />
            <Metric label="In flight" value={number(snapshot.relay.activeRequests)} detail="Concurrent requests"><span className="text-sm tabular-nums text-muted">/ {number(snapshot.relay.maxConcurrent)}</span></Metric>
            <div className="border-t border-line lg:border-t-0"><Metric label="Succeeded" value={number(snapshot.totals.succeeded)} detail="Finished without an error" /></div>
            <div className="border-t border-line lg:border-t-0"><Metric label="Failed" value={number(snapshot.totals.failed)} detail={`${number(snapshot.totals.cancelled)} cancelled separately`} /></div>
          </section>
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-5">
              <RequestTable requests={snapshot.recentRequests} />
              <section aria-label="Transferred data since process start" className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-white px-5 py-4 sm:px-6">
                <div className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-canvas text-muted"><Icon name="activity" /></span><div><h2 className="text-xs font-semibold">Data transferred</h2><p className="mt-1 text-[11px] text-muted">Since process start</p></div></div>
                <dl className="flex gap-7 text-xs"><div><dt className="text-[10px] text-muted">Received</dt><dd className="mt-1 font-mono tabular-nums">{bytes(snapshot.totals.bytesReceived)}</dd></div><div><dt className="text-[10px] text-muted">Sent</dt><dd className="mt-1 font-mono tabular-nums">{bytes(snapshot.totals.bytesSent)}</dd></div></dl>
              </section>
            </div>
            <DetailsPanel snapshot={snapshot} />
          </div>
          <p className="flex flex-wrap justify-between gap-2 pt-1 text-[11px] leading-6 text-muted"><span>Process-local metrics · request bodies and keys are never shown</span><span className="font-mono">cchop {snapshot.version}</span></p>
        </div>
      ) : (
        <section aria-label="Connection status" className="flex min-h-96 flex-col items-center justify-center rounded-xl border border-line bg-white px-6 py-16 text-center">
          <span className={`mb-5 flex size-12 items-center justify-center rounded-xl ${message ? 'bg-amber-50 text-amber-700' : 'bg-signal/5 text-signal'}`}><Icon name={message ? 'warning' : 'refresh'} className={`size-5 ${isFetching ? 'motion-safe:animate-spin' : ''}`} /></span>
          <h2 className="font-display text-lg font-semibold tracking-tight">{message ? 'Waiting for a connection' : 'Connecting to your relay'}</h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted">{message ? 'Check the service and network, then refresh to try again.' : 'Checking access and retrieving the latest status.'}</p>
        </section>
      )}
    </main>
  )
}

export default function App() {
  const [token, setToken] = useState<string | null>(null)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const signOut = useCallback(() => { setToken(null); setAuthMessage(null) }, [])
  const unauthorized = useCallback(() => {
    setToken(null)
    setAuthMessage('The admin key was rejected or changed. Enter the current key to reconnect.')
  }, [])
  const signIn = useCallback((key: string) => { setAuthMessage(null); setToken(key) }, [])

  return (
    <div className="flex min-h-svh flex-col">
      <Header onSignOut={token ? signOut : undefined} />
      {token ? <Dashboard token={token} onUnauthorized={unauthorized} /> : <SignIn onSignIn={signIn} message={authMessage} />}
      <footer className="border-t border-line px-5 py-4 text-center text-[11px] leading-6 text-muted">cchop <span aria-hidden="true" className="mx-1.5 text-slate-300">/</span> Your self-hosted relay</footer>
    </div>
  )
}
