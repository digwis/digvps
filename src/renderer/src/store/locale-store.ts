import { create } from "zustand"
import { changeLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE, type Locale } from "../i18n"

export { SUPPORTED_LOCALES, DEFAULT_LOCALE }
export type { Locale }

const LOCALE_KEY = "cloudroost:locale"

function readLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_KEY)
    if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
      return stored as Locale
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_LOCALE
}

function writeLocale(locale: Locale) {
  try {
    window.localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // Ignore storage errors
  }
}

type LocaleState = {
  locale: Locale
  setLocale: (locale: Locale) => void
}

export const useLocaleStore = create<LocaleState>((set) => {
  const initial = readLocale()
  changeLocale(initial)
  return {
    locale: initial,
    setLocale: (locale) => {
      writeLocale(locale)
      changeLocale(locale)
      set({ locale })
    },
  }
})
