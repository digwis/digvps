import { z } from "zod"

export type BitcoinPrice = {
  usd: number
  cny: number
  usd_24h_change: number
  cny_24h_change: number
  last_updated_at: number
}

const coinGeckoPriceSchema = z.object({
  bitcoin: z.object({
    usd: z.number(),
    cny: z.number(),
    usd_24h_change: z.number(),
    cny_24h_change: z.number(),
    last_updated_at: z.number(),
  }),
})

const PRICE_CACHE_TTL_MS = 60_000
const IN_FLIGHT_TTL_MS = 30_000

type CachedPrice = {
  price: BitcoinPrice
  cachedAt: number
}

let cachedPrice: CachedPrice | null = null
let inFlightPromise: Promise<BitcoinPrice> | null = null
let inFlightStartedAt = 0

async function fetchFreshPrice(): Promise<BitcoinPrice> {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,cny&include_24hr_change=true&include_last_updated_at=true",
    { headers: { Accept: "application/json" } },
  )

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }

  const raw: unknown = await response.json()
  const parsed = coinGeckoPriceSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error("Invalid response from CoinGecko API")
  }

  return parsed.data.bitcoin
}

export async function fetchBitcoinPrice(): Promise<BitcoinPrice> {
  const now = Date.now()
  if (cachedPrice && now - cachedPrice.cachedAt <= PRICE_CACHE_TTL_MS) {
    return cachedPrice.price
  }
  if (inFlightPromise && now - inFlightStartedAt <= IN_FLIGHT_TTL_MS) {
    return inFlightPromise
  }
  inFlightStartedAt = now
  inFlightPromise = fetchFreshPrice()
    .then((price) => {
      cachedPrice = { price, cachedAt: Date.now() }
      return price
    })
    .finally(() => {
      inFlightPromise = null
    })
  try {
    return await inFlightPromise
  } catch (error) {
    throw new Error(
      `Failed to fetch Bitcoin price: ${error instanceof Error ? error.message : "Unknown error"}`,
    )
  }
}
