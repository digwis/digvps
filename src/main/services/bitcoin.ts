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

export async function fetchBitcoinPrice(): Promise<BitcoinPrice> {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,cny&include_24hr_change=true&include_last_updated_at=true"
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
  } catch (error) {
    throw new Error(
      `Failed to fetch Bitcoin price: ${error instanceof Error ? error.message : "Unknown error"}`
    )
  }
}
