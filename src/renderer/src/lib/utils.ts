import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

type DebouncedStorageWriter = {
  schedule: (next: string) => void
  flush: () => void
  cancel: () => void
}

const DEFAULT_DEBOUNCE_MS = 250

export function createDebouncedStorageWriter(
  key: string,
  options: { debounceMs?: number } = {},
): DebouncedStorageWriter {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  let pendingValue: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pendingValue === null) {
      return
    }
    const value = pendingValue
    pendingValue = null
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Ignore storage errors in desktop renderer.
    }
  }

  const schedule = (next: string) => {
    pendingValue = next
    if (timer) {
      return
    }
    timer = setTimeout(flush, debounceMs)
  }

  const cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pendingValue = null
  }

  return { schedule, flush, cancel }
}
