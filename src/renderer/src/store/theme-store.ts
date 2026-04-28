import { create } from "zustand"

const THEME_KEY = "digwis:theme"
const DARK_QUERY = "(prefers-color-scheme: dark)"

export type Theme = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return stored === "system" || stored === "light" || stored === "dark" ? stored : "system"
  } catch {
    return "system"
  }
}

function writeTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Ignore storage errors
  }
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark"
  }
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light"
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? readSystemTheme() : theme
}

function applyResolvedTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") {
    return
  }
  document.documentElement.classList.toggle("dark", theme === "dark")
}

type ThemeState = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initialTheme = readTheme()
  const initialResolvedTheme = resolveTheme(initialTheme)
  applyResolvedTheme(initialResolvedTheme)

  return {
    theme: initialTheme,
    resolvedTheme: initialResolvedTheme,
    setTheme: (theme) => {
      const resolvedTheme = resolveTheme(theme)
      applyResolvedTheme(resolvedTheme)
      writeTheme(theme)
      set({ theme, resolvedTheme })
    },
    toggleTheme: () => {
      const newTheme = get().resolvedTheme === "dark" ? "light" : "dark"
      get().setTheme(newTheme)
    },
  }
})

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mediaQuery = window.matchMedia(DARK_QUERY)
  const syncSystemTheme = () => {
    const { theme, resolvedTheme } = useThemeStore.getState()
    const nextResolvedTheme = resolveTheme(theme)
    applyResolvedTheme(nextResolvedTheme)
    if (resolvedTheme !== nextResolvedTheme) {
      useThemeStore.setState({ resolvedTheme: nextResolvedTheme })
    }
  }

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", syncSystemTheme)
  } else if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(syncSystemTheme)
  }
}
