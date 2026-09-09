type IconName = 'arrow' | 'refresh' | 'pause' | 'play' | 'lock' | 'logout' | 'warning' | 'check' | 'server' | 'activity'

const paths: Record<IconName, string> = {
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9',
  pause: 'M8 5v14M16 5v14',
  play: 'm8 5 11 7-11 7V5Z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v9H5v-9a1 1 0 0 1 1-1ZM12 14v2',
  logout: 'M9 4H4v16h5M10 12h10m-4-4 4 4-4 4',
  warning: 'm12 3 10 18H2L12 3ZM12 9v5M12 17v.1',
  check: 'm5 12 4 4L19 6',
  server: 'M4 3h16v7H4V3ZM4 14h16v7H4v-7ZM8 6.5h.1M8 17.5h.1M12 6.5h5M12 17.5h5',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
}

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d={paths[name]} />
    </svg>
  )
}

export function RelayMark({ className = 'size-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect width="40" height="40" rx="11" fill="currentColor" />
      <path d="m10 14 6 6-6 6M23 14l6 6-6 6M16 20h13" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
    </svg>
  )
}
