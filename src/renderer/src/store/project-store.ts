import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
  LocalProjectInput,
  LocalProjectRecord,
  ProjectDeployInput,
  ProjectInitializeInput,
} from "../../../shared/projects"

type ProjectStoreState = {
  projects: LocalProjectRecord[]
  isLoading: boolean
  isImporting: boolean
  isDeploying: boolean
  deployingProjectId?: string
  isInitializing: boolean
  initializingProjectId?: string
  error?: string
  info?: string
  loadProjects: () => Promise<void>
  importFromPicker: () => Promise<void>
  addProject: (payload: LocalProjectInput) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  initializeProject: (payload: ProjectInitializeInput) => Promise<void>
  deployProject: (payload: ProjectDeployInput) => Promise<void>
  clearFeedback: () => void
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  isLoading: false,
  isImporting: false,
  isDeploying: false,
  deployingProjectId: undefined,
  isInitializing: false,
  initializingProjectId: undefined,
  error: undefined,
  info: undefined,
  loadProjects: async () => {
    set({ isLoading: true, error: undefined })
    try {
      const projects = await getDesktopApi().projects.listProjects()
      set({ projects, isLoading: false })
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : "项目列表加载失败",
      })
    }
  },
  importFromPicker: async () => {
    set({ isImporting: true, error: undefined, info: undefined })
    try {
      const picked = await getDesktopApi().projects.pickProjectDirectory()
      if (!picked) {
        set({ isImporting: false })
        return
      }
      await getDesktopApi().projects.addProjectFromPath({ localPath: picked })
      await get().loadProjects()
      set({ isImporting: false, info: "已导入本地项目" })
    } catch (error) {
      set({
        isImporting: false,
        error: error instanceof Error ? error.message : "导入失败",
      })
    }
  },
  addProject: async (payload) => {
    set({ error: undefined, info: undefined })
    try {
      await getDesktopApi().projects.addProjectFromPath(payload)
      await get().loadProjects()
      set({ info: "已添加项目" })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "添加项目失败",
      })
      throw error
    }
  },
  deleteProject: async (id) => {
    set({ error: undefined, info: undefined })
    try {
      await getDesktopApi().projects.deleteProject(id)
      await get().loadProjects()
      set({ info: "已移除项目" })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "移除失败",
      })
    }
  },
  initializeProject: async (payload) => {
    set({
      isInitializing: true,
      initializingProjectId: payload.projectId,
      error: undefined,
      info: undefined,
    })
    try {
      const result = await getDesktopApi().projects.initializeProject(payload)
      await get().loadProjects()
      set({
        isInitializing: false,
        initializingProjectId: undefined,
        info: result.ok ? `${result.message}（${Math.round(result.durationMs / 100) / 10}s）` : undefined,
        error: result.ok ? undefined : result.message,
      })
    } catch (error) {
      await get().loadProjects()
      set({
        isInitializing: false,
        initializingProjectId: undefined,
        error: error instanceof Error ? error.message : "初始化失败",
      })
    }
  },
  deployProject: async (payload) => {
    set({
      isDeploying: true,
      deployingProjectId: payload.projectId,
      error: undefined,
      info: undefined,
    })
    try {
      const result = await getDesktopApi().projects.deployProject(payload)
      await get().loadProjects()
      set({
        isDeploying: false,
        deployingProjectId: undefined,
        info: result.ok ? `${result.message}（${Math.round(result.durationMs / 100) / 10}s）` : undefined,
        error: result.ok ? undefined : result.message,
      })
    } catch (error) {
      await get().loadProjects()
      set({
        isDeploying: false,
        deployingProjectId: undefined,
        error: error instanceof Error ? error.message : "部署失败",
      })
    }
  },
  clearFeedback: () => set({ error: undefined, info: undefined }),
}))
