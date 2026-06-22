import i18n from "i18next"
import { initReactI18next } from "react-i18next"

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const
export const DEFAULT_LOCALE = "zh-CN" as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

const loadedResources: Record<string, { translation: Record<string, unknown> }> = {}

async function loadLocale(locale: string) {
  if (loadedResources[locale]) {
    return loadedResources[locale]
  }
  const mod = await import(`./locales/${locale}.json`)
  loadedResources[locale] = { translation: mod.default ?? mod }
  return loadedResources[locale]
}

// Load the default locale eagerly, then init i18n
loadLocale(DEFAULT_LOCALE).then((resources) => {
  void i18n.use(initReactI18next).init({
    resources: { [DEFAULT_LOCALE]: resources },
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  })
})

export async function changeLocale(locale: Locale) {
  if (!loadedResources[locale]) {
    const resources = await loadLocale(locale)
    i18n.addResourceBundle(locale, "translation", resources)
  }
  void i18n.changeLanguage(locale)
}

export default i18n
