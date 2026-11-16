const CANDIDATE_QUERY = 'forecast=candidate'

export function defenseHomeLink(pathname: string): string | undefined {
  return /\/demo\/dist\/(?:index\.html|degradation\.html)?$/.test(pathname) ? '../../index.html' : undefined
}

export function opensCandidate(search: string): boolean {
  return new URLSearchParams(search).get('forecast') === 'candidate'
}

export function forecastLink(page: 'index.html' | 'degradation.html'): string {
  const candidate = typeof window !== 'undefined' && opensCandidate(window.location.search)
  return candidate ? `./${page}?${CANDIDATE_QUERY}` : `./${page}`
}
