import { useMemo, useState } from 'react'
import type { RequestRecord } from '../../src/types'
import { bytes, duration, number, time } from './format'
import { Icon } from './Icons'

type Filter = 'all' | 'errors' | 'cancelled'

const outcomeStyles: Record<RequestRecord['outcome'], { label: string; className: string }> = {
  ok: { label: 'OK', className: 'bg-teal/8 text-teal' },
  upstream_error: { label: 'Upstream error', className: 'bg-amber-50 text-amber-800' },
  relay_error: { label: 'Relay error', className: 'bg-red-50 text-red-700' },
  cancelled: { label: 'Cancelled', className: 'bg-slate-100 text-slate-600' },
}

function Outcome({ request }: { request: RequestRecord }) {
  const style = outcomeStyles[request.outcome]
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold ${style.className}`}>
      <span className="font-mono tabular-nums" title={request.status === 0 ? 'No HTTP response' : undefined}>{request.status || '—'}</span>
      <span className="h-2.5 w-px bg-current opacity-25" aria-hidden="true" />
      {style.label}
    </span>
  )
}

export function RequestTable({ requests }: { requests: RequestRecord[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const filtered = useMemo(() => requests
    .filter((request) => filter === 'all'
      || (filter === 'cancelled' ? request.outcome === 'cancelled'
        : request.outcome === 'upstream_error' || request.outcome === 'relay_error'))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)), [requests, filter])

  return (
    <section aria-labelledby="requests-title" className="min-w-0 overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
        <div>
          <h2 id="requests-title" className="font-display text-base font-semibold tracking-tight">Recent requests</h2>
          <p className="mt-1 text-xs text-muted">Completed requests in this process’s retained history.</p>
        </div>
        <div role="group" aria-label="Filter requests" className="flex rounded-lg border border-line bg-canvas p-1">
          {(['all', 'errors', 'cancelled'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value) }} className={`rounded-md px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 motion-reduce:transition-none ${filter === value ? 'bg-white text-ink shadow-xs' : 'text-muted hover:bg-white/70 hover:text-ink'}`}>
              {value === 'all' ? 'All requests' : value === 'errors' ? 'Errors' : 'Cancelled'}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
          <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-canvas text-muted"><Icon name="activity" className="size-5" /></span>
          <h3 className="text-sm font-semibold">{requests.length === 0 ? 'Waiting for the first request' : `No ${filter === 'errors' ? 'errors' : 'cancelled requests'} in this window`}</h3>
          <p className="mt-2 max-w-sm text-xs leading-6 text-muted">{requests.length === 0 ? 'Start a Claude Code conversation through this relay. Requests appear here after they finish.' : 'Choose All requests to see the rest of the retained history.'}</p>
        </div>
      ) : (
        <>
          <div role="region" aria-label="Request table" tabIndex={0} className="hidden max-h-144 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal md:block">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Recent completed relay requests, newest start time first</caption>
              <thead className="sticky top-0 z-10 border-b border-line bg-canvas text-[10px] font-semibold uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" className="py-3 pl-6 pr-4">Request</th>
                  <th scope="col" className="px-3 py-3">Result</th>
                  <th scope="col" className="px-3 py-3 text-right">Duration</th>
                  <th scope="col" className="px-3 py-3 text-right">Received / Sent</th>
                  <th scope="col" className="py-3 pl-3 pr-6 text-right">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((request) => (
                  <tr key={request.id} className="hover:bg-canvas/60">
                    <td className="py-4 pl-6 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] font-semibold text-muted">{request.method}</span>
                        <span className="max-w-64 break-all font-mono text-xs font-medium">{request.path}</span>
                      </div>
                      <p className="mt-1.5 font-mono text-[10px] text-muted" title={request.id}>{request.id.slice(0, 12)}</p>
                    </td>
                    <td className="px-3 py-4"><Outcome request={request} /></td>
                    <td className="whitespace-nowrap px-3 py-4 text-right font-mono tabular-nums">{duration(request.durationMs)}</td>
                    <td className="whitespace-nowrap px-3 py-4 text-right font-mono text-[11px] tabular-nums text-muted">{bytes(request.bytesIn)} <span className="mx-1 text-slate-300">/</span> {bytes(request.bytesOut)}</td>
                    <td className="whitespace-nowrap py-4 pl-3 pr-6 text-right font-mono text-[11px] tabular-nums text-muted"><time dateTime={request.startedAt} title={new Date(request.startedAt).toLocaleString()}>{time(request.startedAt)}</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line md:hidden" aria-label="Recent completed requests">
            {filtered.map((request) => (
              <li key={request.id} className="px-5 py-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Outcome request={request} />
                  <time dateTime={request.startedAt} title={new Date(request.startedAt).toLocaleString()} className="font-mono text-[11px] tabular-nums text-muted">{time(request.startedAt)}</time>
                </div>
                <p className="mt-3 break-all font-mono text-xs"><span className="mr-2 font-semibold text-muted">{request.method}</span>{request.path}</p>
                <p className="mt-1.5 font-mono text-[10px] text-muted" title={request.id}>{request.id.slice(0, 12)}</p>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
                  <div><dt className="text-muted">Duration</dt><dd className="mt-1 font-mono tabular-nums">{duration(request.durationMs)}</dd></div>
                  <div><dt className="text-muted">Received</dt><dd className="mt-1 font-mono tabular-nums">{bytes(request.bytesIn)}</dd></div>
                  <div><dt className="text-muted">Sent</dt><dd className="mt-1 font-mono tabular-nums">{bytes(request.bytesOut)}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex flex-wrap justify-between gap-2 border-t border-line px-5 py-3 text-[11px] text-muted sm:px-6">
        <span>{number(filtered.length)} of {number(requests.length)} retained requests</span>
        <span>History clears on restart</span>
      </div>
    </section>
  )
}
