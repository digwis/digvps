import { create } from "zustand"

const THEME_KEY = "digwis:theme"

type Theme = "light" | "dark"

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return stored === "light" || stored === "dark" ? stored : "dark"
  } catch {
    return "dark"
  }
}

function writeTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Ignore storage errors
  }
}

type ThemeState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initialTheme = readTheme()
  
  // 初始化时应用主题
  if (typeof document !== "undefined") {
    if (initialTheme === "dark") {
      document.documentElement.classList.add("dark")
    } else {
      document.documentElement.classList.remove("dark")
    }
  }
  
  return {
    theme: initialTheme,
    setTheme: (theme) => {
      if (theme === "dark") {
        document.documentElement.classList.add("dark")
      } else {
        document.documentElement.classList.remove("dark")
      }
      writeTheme(theme)
      set({ theme })
    },
    toggleTheme: () => {
      const currentTheme = get().theme
      const newTheme = currentTheme === "dark" ? "light" : "dark"
      get().setTheme(newTheme)
    },
  }
})
