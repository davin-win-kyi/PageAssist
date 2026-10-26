/*
The following is the logic nessecary to connect the frontend to the backend 
- while also considering timeouts in order to deal with cases where the response
  is too long or there may be a potential error from the end of the LLM server call
*/


// This is the link to the backend endpoint calls 
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

/*
Runtime limitation for endpoint calls (chat turn, which uses low thinking)
- low thinking: overall calls take around 2-5 seconds
- medium thinking: overall calls take around 3-14 seconds
- high thinking: overall calls can take around 6-30 seconds
*/
export const LLM_CALL_TIMEOUT_MS = 90000

/*
Analyze runtime timeout: 
Task Representation runtime Creation averages 
Low thinking: 28 seconds 
Medium thinking: 52 seconds 
High thinking: 244 - 294 seconds
*/
export const ANALYZE_TIMEOUT_MS = 240000


// the following function is used in order to make sure that an LLM call is not longer than the provided constant: 
// LLM_CALL_TIMEOUT_MS
export function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = LLM_CALL_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => window.clearTimeout(timeout))
}
