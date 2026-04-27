import { create } from "zustand"
import { getDesktopApi } from "@/lib/desktop-api"
import type {
  LocalProjectInput,
  LocalProjectRecord,
  ProjectDeployInput,
  ProjectOperationLogEntry,
  ProjectInitializeInput,
} from "../../../shared/projects"

type ProjectStoreState = {
  projects: LocalProjectRecord[]
  deployLogsByProject: Record<string, string[]>
  operationLogs: ProjectOperationLogEntry[]
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
  appendDeployLog: (projectId: string, chunk: string) => void
  clearDeployLogs: (projectId: string) => void
  loadOperationLogs: (limit?: number) => Promise<void>
  appendOperationLog: (entry: ProjectOperationLogEntry) => void
  clearFeedback: () => void
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  deployLogsByProject: {},
  operationLogs: [],
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
      await get().loadOperationLogs(400)
      set({
        isInitializing: false,
        initializingProjectId: undefined,
        info: result.ok ? `${result.message}（${Math.round(result.durationMs / 100) / 10}s）` : undefined,
        error: result.ok ? undefined : result.message,
      })
    } catch (error) {
      await get().loadProjects()
      await get().loadOperationLogs(400)
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
      deployLogsByProject: {
        ...get().deployLogsByProject,
        [payload.projectId]: [],
      },
    })
    try {
      const result = await getDesktopApi().projects.deployProject(payload)
      await get().loadProjects()
      await get().loadOperationLogs(400)
      set({
        isDeploying: false,
        deployingProjectId: undefined,
        info: result.ok ? `${result.message}（${Math.round(result.durationMs / 100) / 10}s）` : undefined,
        error: result.ok ? undefined : result.message,
      })
    } catch (error) {
      await get().loadProjects()
      await get().loadOperationLogs(400)
      set({
        isDeploying: false,
        deployingProjectId: undefined,
        error: error instanceof Error ? error.message : "部署失败",
      })
    }
  },
  appendDeployLog: (projectId, chunk) => {
    const text = chunk.replace(/\r/g, "")
    if (!text) {
      return
    }
    const nextLines = text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
    if (nextLines.length === 0) {
      return
    }
    set((state) => {
      const prev = state.deployLogsByProject[projectId] ?? []
      const merged = [...prev, ...nextLines]
      return {
        deployLogsByProject: {
          ...state.deployLogsByProject,
          [projectId]: merged.slice(-200),
        },
      }
    })
  },
  clearDeployLogs: (projectId) => {
    set((state) => ({
      deployLogsByProject: {
        ...state.deployLogsByProject,
        [projectId]: [],
      },
    }))
  },
  loadOperationLogs: async (limit) => {
    try {
      const items = await getDesktopApi().projects.listOperationLogs({ limit })
      set({ operationLogs: items })
    } catch {
      // ignore
    }
  },
  appendOperationLog: (entry) => {
    set((state) => {
      const merged = [...state.operationLogs, entry]
      return { operationLogs: merged.slice(-800) }
    })
  },
  clearFeedback: () => set({ error: undefined, info: undefined }),
}))
