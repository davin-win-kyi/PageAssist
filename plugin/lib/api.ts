// This is the link to the backend endpoint calls 
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

/*
Runtime limitation for endpoint calls
- low thinking: overall calls take around 3-5 seconds or less
- medium thinking: overall calls take around 14-23 seconds
- high thinking: 
*/
export const LLM_CALL_TIMEOUT_MS = 90000

/*
Analyze runtime timeout: 
Task Representation runtime Creation averages 
Low thinking: 
Medium thinking: 93-137 seconds 
High thinking: 
*/
export const ANALYZE_TIMEOUT_MS = 240000


// the following function is used in order to make sure that an LLM call is not longer than the provided constant: 
// LLM_CALL_TIMEOUT_MS
export function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = LLM_CALL_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timeout))
}
