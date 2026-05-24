import { create } from "zustand"
import type {
  SiteInfo,
  ContentType,
  ContentEntry,
  RuntimeSettings,
  GoApiAuthResponse,
} from "../../../shared/cms"

const CMS_API_URL_KEY = "digwis:cms-api-url"
const CMS_TOKEN_KEY = "digwis:cms-token"
const CMS_USER_KEY = "digwis:cms-user"
const CMS_SELECTED_HOSTNAME_KEY = "digwis:cms-selected-hostname"

type CmsUser = { id: number; username: string; role: string }

type CmsState = {
  apiUrl: string
  token: string
  user: CmsUser | null
  isAuthenticated: boolean
  isLoggingIn: boolean
  loginError: string | null

  sites: SiteInfo[]
  selectedHostname: string | null
  selectedSite: SiteInfo | null

  contentTypes: ContentType[]
  entries: ContentEntry[]
  runtimeSettings: RuntimeSettings | null

  isLoadingSites: boolean
  isLoadingContentTypes: boolean
  isLoadingEntries: boolean
  isLoadingSettings: boolean

  login: (apiUrl: string, username: string, password: string) => Promise<void>
  logout: () => void
  restoreSession: () => void

  loadSites: () => Promise<void>
  selectSite: (hostname: string) => void
  createSite: (input: { hostname: string; label: string; databaseUrl: string; spaceMode?: "standard" | "theme" }) => Promise<void>
  deleteSite: (hostname: string) => Promise<void>

  loadContentTypes: () => Promise<void>
  createContentType: (input: { key: string; name: string; description?: string; fields?: unknown[] }) => Promise<void>

  loadEntries: (typeKey?: string, limit?: number) => Promise<void>
  createEntry: (input: { typeKey: string; title: string; slug?: string; summary?: string; data?: Record<string, unknown>; coverImageUrl?: string }) => Promise<void>

  loadRuntimeSettings: () => Promise<void>
}

function getStoredValue(key: string): string {
  try { return localStorage.getItem(key) || "" } catch { return "" }
}

function setStoredValue(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch {}
}

function removeStoredValue(key: string) {
  try { localStorage.removeItem(key) } catch {}
}

async function cmsInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const { getDesktopApi } = await import("@/lib/desktop-api")
  const api = getDesktopApi() as any
  if (!api.cms?.[channel]) {
    throw new Error(`CMS API method "${channel}" not available`)
  }
  return api.cms[channel](...args)
}

export const useCmsStore = create<CmsState>((set, get) => ({
  apiUrl: getStoredValue(CMS_API_URL_KEY),
  token: getStoredValue(CMS_TOKEN_KEY),
  user: (() => { try { return JSON.parse(getStoredValue(CMS_USER_KEY)) } catch { return null } })(),
  isAuthenticated: !!getStoredValue(CMS_TOKEN_KEY),
  isLoggingIn: false,
  loginError: null,

  sites: [],
  selectedHostname: getStoredValue(CMS_SELECTED_HOSTNAME_KEY) || null,
  selectedSite: null,

  contentTypes: [],
  entries: [],
  runtimeSettings: null,

  isLoadingSites: false,
  isLoadingContentTypes: false,
  isLoadingEntries: false,
  isLoadingSettings: false,

  login: async (apiUrl, username, password) => {
    set({ isLoggingIn: true, loginError: null })
    try {
      const result = await cmsInvoke<GoApiAuthResponse>("login", apiUrl, username, password)
      const user = result.user
      setStoredValue(CMS_API_URL_KEY, apiUrl)
      setStoredValue(CMS_TOKEN_KEY, result.token)
      setStoredValue(CMS_USER_KEY, JSON.stringify(user))
      set({
        apiUrl,
        token: result.token,
        user,
        isAuthenticated: true,
        isLoggingIn: false,
        loginError: null,
      })
    } catch (error) {
      set({
        isLoggingIn: false,
        loginError: error instanceof Error ? error.message : "Login failed",
        isAuthenticated: false,
      })
      throw error
    }
  },

  logout: () => {
    removeStoredValue(CMS_TOKEN_KEY)
    removeStoredValue(CMS_USER_KEY)
    removeStoredValue(CMS_SELECTED_HOSTNAME_KEY)
    set({
      token: "",
      user: null,
      isAuthenticated: false,
      sites: [],
      selectedHostname: null,
      selectedSite: null,
      contentTypes: [],
      entries: [],
      runtimeSettings: null,
    })
  },

  restoreSession: () => {
    const token = getStoredValue(CMS_TOKEN_KEY)
    const apiUrl = getStoredValue(CMS_API_URL_KEY)
    const userStr = getStoredValue(CMS_USER_KEY)
    const hostname = getStoredValue(CMS_SELECTED_HOSTNAME_KEY)
    if (token && apiUrl) {
      let user = null
      try { user = JSON.parse(userStr) } catch {}
      set({ token, apiUrl, user, isAuthenticated: true, selectedHostname: hostname || null })
    }
  },

  loadSites: async () => {
    const { apiUrl, token } = get()
    if (!apiUrl || !token) return
    set({ isLoadingSites: true })
    try {
      const sites = await cmsInvoke<SiteInfo[]>("listSites", apiUrl, token)
      const { selectedHostname } = get()
      const selectedSite = sites.find((s) => s.hostname === selectedHostname) || null
      set({ sites, isLoadingSites: false, selectedSite })
    } catch {
      set({ isLoadingSites: false })
    }
  },

  selectSite: (hostname) => {
    setStoredValue(CMS_SELECTED_HOSTNAME_KEY, hostname)
    const { sites } = get()
    const selectedSite = sites.find((s) => s.hostname === hostname) || null
    set({ selectedHostname: hostname, selectedSite, contentTypes: [], entries: [], runtimeSettings: null })
  },

  createSite: async (input) => {
    const { apiUrl, token } = get()
    if (!apiUrl || !token) return
    await cmsInvoke("createSite", apiUrl, token, input)
    await get().loadSites()
  },

  deleteSite: async (hostname) => {
    const { apiUrl, token } = get()
    if (!apiUrl || !token) return
    await cmsInvoke("deleteSite", apiUrl, token, hostname)
    const { selectedHostname } = get()
    if (selectedHostname === hostname) {
      set({ selectedHostname: null, selectedSite: null })
    }
    await get().loadSites()
  },

  loadContentTypes: async () => {
    const { apiUrl, token, selectedHostname } = get()
    if (!apiUrl || !token || !selectedHostname) return
    set({ isLoadingContentTypes: true })
    try {
      const contentTypes = await cmsInvoke<ContentType[]>("listContentTypes", apiUrl, token, selectedHostname)
      set({ contentTypes, isLoadingContentTypes: false })
    } catch {
      set({ isLoadingContentTypes: false })
    }
  },

  createContentType: async (input) => {
    const { apiUrl, token, selectedHostname } = get()
    if (!apiUrl || !token || !selectedHostname) return
    await cmsInvoke("createContentType", apiUrl, token, selectedHostname, input)
    await get().loadContentTypes()
  },

  loadEntries: async (typeKey?, limit?) => {
    const { apiUrl, token, selectedHostname } = get()
    if (!apiUrl || !token || !selectedHostname) return
    set({ isLoadingEntries: true })
    try {
      const entries = await cmsInvoke<ContentEntry[]>("listEntries", apiUrl, token, selectedHostname, typeKey, limit)
      set({ entries, isLoadingEntries: false })
    } catch {
      set({ isLoadingEntries: false })
    }
  },

  createEntry: async (input) => {
    const { apiUrl, token, selectedHostname } = get()
    if (!apiUrl || !token || !selectedHostname) return
    await cmsInvoke("createEntry", apiUrl, token, selectedHostname, input)
    await get().loadEntries()
  },

  loadRuntimeSettings: async () => {
    const { apiUrl, token, selectedHostname } = get()
    if (!apiUrl || !token || !selectedHostname) return
    set({ isLoadingSettings: true })
    try {
      const runtimeSettings = await cmsInvoke<RuntimeSettings>("getRuntimeSettings", apiUrl, token, selectedHostname)
      set({ runtimeSettings, isLoadingSettings: false })
    } catch {
      set({ isLoadingSettings: false })
    }
  },
}))
