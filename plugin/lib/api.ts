// Backend base URL + a fetch wrapper with a hard timeout. The Anthropic-backed endpoints had NO
// timeout at all — a hung call left the panel stuck forever.

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// `/chat` is one turn and stays snappy; `/analyze` and `/generate` stream large structured outputs
// and can legitimately run well past 25s, so callers pass ANALYZE_TIMEOUT_MS for those.
export const LLM_CALL_TIMEOUT_MS = 25000
export const ANALYZE_TIMEOUT_MS = 120000

export function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = LLM_CALL_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timeout))
}
