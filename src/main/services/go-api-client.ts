import type {
  GoApiResponse,
  GoApiAuthResponse,
  SiteInfo,
  CreateSiteInput,
  ContentType,
  CreateContentTypeInput,
  ContentEntry,
  CreateContentEntryInput,
  RuntimeSettings,
} from "../../shared/cms"

type GoApiClientConfig = {
  baseUrl: string
  token?: string
  hostname?: string
}

async function goFetch<T>(config: GoApiClientConfig, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (config.token) {
    headers["Authorization"] = `Bearer ${config.token}`
  }
  if (config.hostname) {
    headers["X-Site-Hostname"] = config.hostname
  }
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(15_000),
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${config.baseUrl}${path}`, init)
  const json = (await res.json()) as GoApiResponse<T>
  if (!json.success) {
    throw new Error(json.error || `Go API error: ${res.status}`)
  }
  return json.data as T
}

export async function loginGoApi(baseUrl: string, username: string, password: string): Promise<GoApiAuthResponse> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json()) as GoApiResponse<GoApiAuthResponse>
  if (!json.success) {
    throw new Error(json.error || "Login failed")
  }
  return json.data
}

export async function getMe(config: GoApiClientConfig): Promise<{ id: number; username: string; role: string }> {
  return goFetch(config, "GET", "/api/auth/me")
}

export async function listSites(config: GoApiClientConfig): Promise<SiteInfo[]> {
  return goFetch<SiteInfo[]>(config, "GET", "/api/sites")
}

export async function createSite(config: GoApiClientConfig, input: CreateSiteInput): Promise<SiteInfo> {
  return goFetch<SiteInfo>(config, "POST", "/api/sites", input)
}

export async function deleteSite(config: GoApiClientConfig, hostname: string): Promise<void> {
  await goFetch(config, "DELETE", `/api/sites?hostname=${encodeURIComponent(hostname)}`)
}

export async function reloadSites(config: GoApiClientConfig): Promise<{ loaded: number }> {
  return goFetch(config, "POST", "/api/sites/reload")
}

function withHostname(config: GoApiClientConfig, hostname: string): GoApiClientConfig {
  return { ...config, hostname }
}

export async function listContentTypes(config: GoApiClientConfig, hostname: string): Promise<ContentType[]> {
  return goFetch<ContentType[]>(withHostname(config, hostname), "GET", "/api/s/content-types")
}

export async function createContentType(config: GoApiClientConfig, hostname: string, input: CreateContentTypeInput): Promise<ContentType> {
  return goFetch<ContentType>(withHostname(config, hostname), "POST", "/api/s/content-types", input)
}

export async function listEntries(config: GoApiClientConfig, hostname: string, typeKey?: string, limit?: number): Promise<ContentEntry[]> {
  const params = new URLSearchParams()
  if (typeKey) params.set("typeKey", typeKey)
  if (limit) params.set("limit", String(limit))
  const qs = params.toString()
  return goFetch<ContentEntry[]>(withHostname(config, hostname), "GET", `/api/s/entries${qs ? `?${qs}` : ""}`)
}

export async function createEntry(config: GoApiClientConfig, hostname: string, input: CreateContentEntryInput): Promise<ContentEntry> {
  return goFetch<ContentEntry>(withHostname(config, hostname), "POST", "/api/s/entries", input)
}

export async function getEntry(config: GoApiClientConfig, hostname: string, slug?: string, id?: number): Promise<ContentEntry> {
  const params = new URLSearchParams()
  if (slug) params.set("slug", slug)
  if (id) params.set("id", String(id))
  return goFetch<ContentEntry>(withHostname(config, hostname), "GET", `/api/s/entries/detail?${params.toString()}`)
}

export async function getRuntimeSettings(config: GoApiClientConfig, hostname: string): Promise<RuntimeSettings> {
  return goFetch<RuntimeSettings>(withHostname(config, hostname), "GET", "/api/s/runtime-settings")
}
