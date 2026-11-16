export function defenseHomeLink(pathname: string): string | undefined {
  return /\/demo\/dist\/(?:index\.html|degradation\.html)?$/.test(pathname) ? '../../index.html' : undefined
}

export function forecastMode(search: string): string | null {
  return new URLSearchParams(search).get('forecast')
}

export function forecastLink(page: 'index.html' | 'degradation.html'): string {
  const mode = typeof window !== 'undefined' ? forecastMode(window.location.search) : null
  return mode === 'candidate' || mode === 'demo' ? `./${page}?forecast=${mode}` : `./${page}`
}
