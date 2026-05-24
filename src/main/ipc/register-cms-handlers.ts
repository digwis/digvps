import { ipcMain } from "../electron-shim"
import type { CreateSiteInput, CreateContentTypeInput, CreateContentEntryInput } from "../../shared/cms"
import {
  loginGoApi,
  getMe,
  listSites,
  createSite,
  deleteSite,
  reloadSites,
  listContentTypes,
  createContentType,
  listEntries,
  createEntry,
  getEntry,
  getRuntimeSettings,
} from "../services/go-api-client"

function makeConfig(apiBaseUrl: string, token: string) {
  return { baseUrl: apiBaseUrl, token }
}

export function registerCmsHandlers() {
  ipcMain.handle("cms:login", async (_event, apiBaseUrl: string, username: string, password: string) => {
    return loginGoApi(apiBaseUrl, username, password)
  })

  ipcMain.handle("cms:get-me", async (_event, apiBaseUrl: string, token: string) => {
    return getMe(makeConfig(apiBaseUrl, token))
  })

  ipcMain.handle("cms:list-sites", async (_event, apiBaseUrl: string, token: string) => {
    return listSites(makeConfig(apiBaseUrl, token))
  })

  ipcMain.handle("cms:create-site", async (_event, apiBaseUrl: string, token: string, input: CreateSiteInput) => {
    return createSite(makeConfig(apiBaseUrl, token), input)
  })

  ipcMain.handle("cms:delete-site", async (_event, apiBaseUrl: string, token: string, hostname: string) => {
    return deleteSite(makeConfig(apiBaseUrl, token), hostname)
  })

  ipcMain.handle("cms:reload-sites", async (_event, apiBaseUrl: string, token: string) => {
    return reloadSites(makeConfig(apiBaseUrl, token))
  })

  ipcMain.handle("cms:list-content-types", async (_event, apiBaseUrl: string, token: string, hostname: string) => {
    return listContentTypes(makeConfig(apiBaseUrl, token), hostname)
  })

  ipcMain.handle("cms:create-content-type", async (_event, apiBaseUrl: string, token: string, hostname: string, input: CreateContentTypeInput) => {
    return createContentType(makeConfig(apiBaseUrl, token), hostname, input)
  })

  ipcMain.handle("cms:list-entries", async (_event, apiBaseUrl: string, token: string, hostname: string, typeKey?: string, limit?: number) => {
    return listEntries(makeConfig(apiBaseUrl, token), hostname, typeKey, limit)
  })

  ipcMain.handle("cms:create-entry", async (_event, apiBaseUrl: string, token: string, hostname: string, input: CreateContentEntryInput) => {
    return createEntry(makeConfig(apiBaseUrl, token), hostname, input)
  })

  ipcMain.handle("cms:get-entry", async (_event, apiBaseUrl: string, token: string, hostname: string, slug?: string, id?: number) => {
    return getEntry(makeConfig(apiBaseUrl, token), hostname, slug, id)
  })

  ipcMain.handle("cms:get-runtime-settings", async (_event, apiBaseUrl: string, token: string, hostname: string) => {
    return getRuntimeSettings(makeConfig(apiBaseUrl, token), hostname)
  })
}
