// Demonstration credentials live in memory only. No automatic request replay.
const DEMO_ORIGIN = 'https://api.freirenlikesleep.cyou:8443'
const configured = typeof import.meta.env.VITE_API_BASE_URL === 'string'
  ? import.meta.env.VITE_API_BASE_URL.trim().replace(/\/+$/, '') : ''
export const demoAuthenticationEnabled = configured === DEMO_ORIGIN
let authorization: string | null = null

export function setDemoCredentials(username: string, password: string): void {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  authorization = `Basic ${btoa(binary)}`
}

function notify(detail: string): void {
  window.dispatchEvent(new CustomEvent('seekjournal-demo-auth', { detail }))
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
  // Reject alternate destinations in demonstration mode, including explicit test client URLs.
  if (demoAuthenticationEnabled && url.origin !== DEMO_ORIGIN) {
    throw new Error('请求地址与演示服务不一致，已阻止请求。')
  }
  if (!demoAuthenticationEnabled) return globalThis.fetch(input, init)
  const requestAuthorization = authorization
  if (!requestAuthorization) {
    notify('auth')
    throw new Error('请先输入演示账号和密码，未保存内容仍保留在当前页面。')
  }
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  headers.set('Authorization', requestAuthorization)
  let response: Response
  try {
    // Reject redirects so a credential-bearing request is never followed to another origin.
    response = await globalThis.fetch(input, { ...init, headers, redirect: 'error' })
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) notify('network')
    throw error
  }
  if (response.status === 401 && authorization === requestAuthorization) {
    authorization = null
    notify('auth')
  } else if (response.status === 403) notify('forbidden')
  else if (response.status === 429) notify('rate')
  else if (response.status >= 500) notify('server')
  return response
}
