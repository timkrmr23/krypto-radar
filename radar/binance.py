"""Öffentliche Binance-Marktdaten ohne Schlüssel: handelbare Coins und Tageskerzen mit Zwischenspeicher."""

import asyncio
import time
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

BASE_URL = "https://data-api.binance.vision/api/v3"
QUOTE = "USDT"
DAY_MS = 86_400_000
# Stablecoins, Fiat und verpackte Doppelgänger anderer Coins: keine eigenständigen Kursbewegungen
EXCLUDED = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USDE", "PYUSD", "RLUSD", "USD1", "U", "XUSD", "BFUSD",
            "EUR", "EURI", "AEUR", "GBP", "WBTC", "WBETH", "BETH", "BNSOL"}
COLUMNS = ["open", "high", "low", "close", "quote_volume"]
MAX_GAP_DAYS = 7   # längere Handelspause: danach beginnt eine neue Kursreihe
MAX_JUMP = 20.0    # Sprung um mehr als das 20-Fache an einem Tag: neuer Coin unter altem Namen (z. B. LUNA 2022)


def continuous(frame: pd.DataFrame) -> pd.DataFrame:
    """Nur der zusammenhängende Teil der Kursreihe seit dem letzten Bruch."""
    if len(frame) < 2:
        return frame
    gaps = frame.index.to_series().diff().dt.days > MAX_GAP_DAYS
    ratio = frame.close / frame.close.shift()
    jumps = (ratio > MAX_JUMP) | (ratio < 1 / MAX_JUMP)
    breaks = np.flatnonzero((gaps | jumps).to_numpy())
    return frame.iloc[breaks[-1]:] if len(breaks) else frame


class Binance:
    def __init__(self, client: httpx.AsyncClient, cache_dir: Path, parallel: int = 8):
        self.client = client
        self.cache_dir = cache_dir
        self.limit = asyncio.Semaphore(parallel)

    async def get(self, path: str, params: dict | None = None):
        for attempt in range(6):
            async with self.limit:
                response = await self.client.get(BASE_URL + path, params=params)
            if response.status_code in (418, 429):  # Abruflimit erreicht: so lange warten, wie Binance vorgibt
                await asyncio.sleep(int(response.headers.get("Retry-After", "5")) + attempt)
                continue
            response.raise_for_status()
            return response.json()
        response.raise_for_status()

    async def coins(self) -> list[str]:
        """Alle Coins, die gerade gegen USDT handelbar sind (ohne Stablecoins und Doppelgänger)."""
        info = await self.get("/exchangeInfo", {"permissions": "SPOT"})
        return sorted({s["baseAsset"] for s in info["symbols"]
                       if s["quoteAsset"] == QUOTE and s["status"] == "TRADING" and s.get("isSpotTradingAllowed")
                       and s["baseAsset"] not in EXCLUDED})

    async def daily(self, coin: str) -> pd.DataFrame:
        """Alle abgeschlossenen Tageskerzen seit Handelsbeginn (Index: Tag in UTC). Lädt nur fehlende Tage nach."""
        path = self.cache_dir / f"{coin}{QUOTE}_1d.csv.gz"
        frame = pd.read_csv(path, compression="gzip", index_col="time") if path.exists() else None
        today = int(time.time() * 1000) // DAY_MS * DAY_MS
        start = int(frame.index[-1]) + DAY_MS if frame is not None and len(frame) else 0
        rows = []
        while start < today:
            batch = await self.get("/klines", {"symbol": f"{coin}{QUOTE}", "interval": "1d", "startTime": start,
                                               "endTime": today - 1, "limit": 1000})
            rows += batch
            if len(batch) < 1000:
                break
            start = batch[-1][0] + DAY_MS
        if rows:
            new = pd.DataFrame([(r[0], *map(float, (r[1], r[2], r[3], r[4], r[7]))) for r in rows],
                               columns=["time", *COLUMNS]).set_index("time")
            frame = new if frame is None else pd.concat([frame, new])
            frame = frame[~frame.index.duplicated(keep="last")].sort_index()
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            frame.to_csv(path, compression="gzip")
        if frame is None:
            return pd.DataFrame(columns=COLUMNS)
        out = frame.copy()
        out.index = pd.to_datetime(out.index, unit="ms")
        return out
