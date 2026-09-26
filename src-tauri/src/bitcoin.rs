//! CoinGecko Bitcoin price fetch with 60s cache — port of bitcoin.ts.

use crate::error::{internal_error, AppResult};
use crate::models::BitcoinPrice;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(60);
const URL: &str = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,cny&include_24hr_change=true&include_last_updated_at=true";

static CACHE: LazyLock<Mutex<Option<(BitcoinPrice, Instant)>>> = LazyLock::new(|| Mutex::new(None));

#[derive(serde::Deserialize)]
struct CoinGeckoResponse {
    bitcoin: CoinGeckoBitcoin,
}

#[derive(serde::Deserialize)]
struct CoinGeckoBitcoin {
    usd: f64,
    cny: f64,
    usd_24h_change: f64,
    cny_24h_change: f64,
    last_updated_at: f64,
}

pub fn fetch_bitcoin_price() -> AppResult<BitcoinPrice> {
    {
        let cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((price, at)) = cache.as_ref() {
            if at.elapsed() <= CACHE_TTL {
                return Ok(price.clone());
            }
        }
    }

    let response = ureq::get(URL)
        .header("Accept", "application/json")
        .call()
        .map_err(|e| internal_error(format!("Failed to fetch Bitcoin price: {e}")))?;
    if response.status() != 200 {
        return Err(internal_error(format!("HTTP error! status: {}", response.status())));
    }
    let parsed: CoinGeckoResponse = response
        .into_body()
        .read_json()
        .map_err(|_| internal_error("Invalid response from CoinGecko API"))?;
    let price = BitcoinPrice {
        usd: parsed.bitcoin.usd,
        cny: parsed.bitcoin.cny,
        usd_24h_change: parsed.bitcoin.usd_24h_change,
        cny_24h_change: parsed.bitcoin.cny_24h_change,
        last_updated_at: parsed.bitcoin.last_updated_at as u64,
    };
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some((price.clone(), Instant::now()));
    Ok(price)
}
