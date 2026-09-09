export function number(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

export function duration(value: number | null): string {
  if (value === null) return '—'
  if (value < 1_000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`
  return `${Math.floor(value / 60_000)}m ${Math.floor((value % 60_000) / 1_000)}s`
}

export function bytes(value: number): string {
  if (value < 1_024) return `${number(value)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = value / 1_024
  let unit = 0
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024
    unit += 1
  }
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unit]}`
}

export function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds)}s`
}

export function time(value: string | Date): string {
  return new Date(value).toLocaleTimeString(undefined, { hour12: false })
}

export function endpointHost(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}
