export type GoApiResponse<T> = {
  success: boolean
  data: T
  error?: string
}

export type GoApiAuthResponse = {
  token: string
  user: { id: number; username: string; role: string }
}

export type SiteInfo = {
  id?: number
  hostname: string
  label: string
  spaceMode: "standard" | "theme"
}

export type CreateSiteInput = {
  hostname: string
  label: string
  databaseUrl: string
  spaceMode?: "standard" | "theme"
}

export type ContentTypeField = {
  key: string
  label: string
  type: "text" | "textarea" | "richtext" | "image" | "number" | "boolean" | "date" | "select" | "relation"
  required?: boolean
  options?: Record<string, unknown>
}

export type ContentType = {
  id: number
  siteId: number
  key: string
  name: string
  description?: string | null
  fields: ContentTypeField[]
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type CreateContentTypeInput = {
  key: string
  name: string
  description?: string
  fields?: ContentTypeField[]
}

export type ContentEntry = {
  id: number
  typeId: number
  typeKey: string
  typeName: string
  title: string
  slug?: string | null
  summary?: string | null
  data?: Record<string, unknown>
  coverImageUrl?: string | null
  editorialStatus: string
  publishedAt?: number | null
  createdAt: number
  updatedAt: number
}

export type CreateContentEntryInput = {
  typeKey: string
  title: string
  slug?: string
  summary?: string
  data?: Record<string, unknown>
  coverImageUrl?: string
}

export type RuntimeSettings = {
  homepageEntryType: string
  homepageViewMode: string
  showHomepageModeSwitcher: boolean
  spaceMode: string
  publicAppearanceConfig: Record<string, unknown>
  publicFooterConfig: Record<string, unknown>
  publicNavigationConfig: Record<string, unknown>
  publicHeaderConfig: Record<string, unknown>
  publicHeroConfig: Record<string, unknown>
}

export type CmsApi = {
  login: (apiBaseUrl: string, username: string, password: string) => Promise<GoApiAuthResponse>
  getMe: (apiBaseUrl: string, token: string) => Promise<{ id: number; username: string; role: string }>
  listSites: (apiBaseUrl: string, token: string) => Promise<SiteInfo[]>
  createSite: (apiBaseUrl: string, token: string, input: CreateSiteInput) => Promise<SiteInfo>
  deleteSite: (apiBaseUrl: string, token: string, hostname: string) => Promise<void>
  reloadSites: (apiBaseUrl: string, token: string) => Promise<{ loaded: number }>
  listContentTypes: (apiBaseUrl: string, token: string, hostname: string) => Promise<ContentType[]>
  createContentType: (apiBaseUrl: string, token: string, hostname: string, input: CreateContentTypeInput) => Promise<ContentType>
  listEntries: (apiBaseUrl: string, token: string, hostname: string, typeKey?: string, limit?: number) => Promise<ContentEntry[]>
  createEntry: (apiBaseUrl: string, token: string, hostname: string, input: CreateContentEntryInput) => Promise<ContentEntry>
  getEntry: (apiBaseUrl: string, token: string, hostname: string, slug?: string, id?: number) => Promise<ContentEntry>
  getRuntimeSettings: (apiBaseUrl: string, token: string, hostname: string) => Promise<RuntimeSettings>
}
