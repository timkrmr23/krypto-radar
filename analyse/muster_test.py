"""Prüft die Mustersuche an der Vergangenheit aller Binance-Coins.

Frage: Wenn frühere, ähnliche Verläufe eines Coins meist in einen Anstieg mündeten, stieg der Coin danach dann auch
tatsächlich – und zwar stärker als der Rest des Marktes? Walk-forward: An jedem Tag zählen nur Daten, die damals
bekannt waren. Schwellen werden 2021–2023 ausgewählt und 2024–2026 unabhängig geprüft.

Robuste Maßstäbe, weil einzelne Coins extreme Sprünge haben: Vergleich mit dem mittleren Coin desselben Tages
(Median), Mittelwerte mit gekappten Ausreißern, Rangkorrelation nur an Tagen, deren Zeiträume sich nicht überlappen.

Zum Vergleich: der Trendstart nach EMA 10/30 mit Bitcoin-Filter (EMA 10 steigt über EMA 30, Bitcoin über seiner
200-Tage-Linie).

Aufruf aus dem Ordner krypto-radar:
    %LOCALAPPDATA%\\TradingDesk\\venv\\Scripts\\python.exe -u analyse\\muster_test.py
"""

import asyncio
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from radar import muster  # noqa: E402
from radar.binance import Binance, continuous  # noqa: E402

DATA = Path(os.environ["LOCALAPPDATA"]) / "KryptoRadar" / "daten" / "1d"
RESULT = ROOT / "analyse" / "muster_ergebnis.json"
START = pd.Timestamp("2021-01-01")  # erste ausgewertete Tage; davor nur Vorlauf
SPLIT = pd.Timestamp("2024-01-01")  # ab hier unabhängige Prüfung
MIN_VOLUME = 1_000_000              # nur liquide Coins: Median-Tagesumsatz der letzten 30 Tage in USDT
COST = 0.003                        # Kauf und Verkauf bei Binance: 2 × 0,1 % Gebühr plus Spread
WINSOR = (-0.9, 3.0)                # für Mittelwerte: Ausreißer auf −90 % / +300 % kappen
GRID = [(10, 5), (20, 5), (20, 10), (30, 10), (30, 20)]  # (Musterlänge, Horizont) in Tagen
MIN_COUNT = 6                       # mindestens so viele frühere Phasen
SHARES = (0.6, 0.7, 0.8, 0.9)       # Anteil der früheren Phasen mit Anstieg
MEDIANS = (0.0, 0.05, 0.10)         # mittlerer Anstieg der früheren Phasen


async def load() -> dict[str, pd.DataFrame]:
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": "KryptoRadar/1.0"}) as client:
        api = Binance(client, DATA)
        coins = await api.coins()
        frames = await asyncio.gather(*(api.daily(coin) for coin in coins))
    cleaned = {coin: continuous(frame) for coin, frame in zip(coins, frames)}
    return {coin: frame for coin, frame in cleaned.items() if len(frame) >= 400}


def coin_rows(args) -> pd.DataFrame:
    coin, frame, length, horizon = args
    close = frame.close.to_numpy()
    first = int(np.searchsorted(frame.index, START))
    table = muster.analog_table(close, length, horizon, from_day=first)
    actual, _, _ = muster.outcomes(close, horizon)
    ema_fast = frame.close.ewm(span=10, adjust=False).mean()
    ema_slow = frame.close.ewm(span=30, adjust=False).mean()
    trend = ema_fast > ema_slow
    rows = pd.DataFrame({
        "coin": coin, "date": frame.index, "actual": actual,
        "liquid": (frame.quote_volume.rolling(30).median() >= MIN_VOLUME).to_numpy(),
        "trend_start": (trend & ~trend.shift(1, fill_value=True)).to_numpy(),
        **{f"a_{key}": values for key, values in table.items()},
    })
    return rows[(rows.date >= START) & rows.actual.notna() & rows.liquid]


def first_of_episode(signals: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Wie eine Benachrichtigung: zählt erst wieder, wenn der Coin `horizon` Tage lang kein Signal hatte."""
    signals = signals.sort_values(["coin", "date"])
    gap = signals.groupby("coin").date.diff().dt.days
    return signals[gap.isna() | (gap > horizon)]


def stats(part: pd.DataFrame) -> dict:
    if part.empty:
        return {"n": 0}
    by_day = part.groupby("date").excess.mean()  # Signale am selben Tag hängen zusammen: erst je Tag mitteln
    t = by_day.mean() / by_day.std() * np.sqrt(len(by_day)) if len(by_day) > 2 and by_day.std() > 0 else float("nan")
    return {"n": int(len(part)), "median": float(part.actual.median()), "hit": float((part.actual > 0).mean()),
            "beat": float((part.actual > part.market).mean()), "excess": float(part.excess.mean()),
            "excess_median": float((part.actual - part.market).median()), "t": float(t),
            "after_cost": float(part.actual.clip(*WINSOR).mean() - COST)}


def line(label: str, s: dict) -> str:
    if not s["n"]:
        return f"    {label:36s}  keine Signale"
    return (f"    {label:36s} {s['n']:6d}  Median {s['median']:+7.2%}  gestiegen {s['hit']:4.0%}  "
            f"besser als mittlerer Coin {s['beat']:4.0%}  Vorsprung Median {s['excess_median']:+6.2%} / Ø {s['excess']:+6.2%} "
            f"(t {s['t']:+4.1f})  Ø nach Kosten {s['after_cost']:+6.2%}")


def daily_ic(part: pd.DataFrame, horizon: int) -> tuple[float, float, int]:
    """Rangkorrelation zwischen Vorhersage (Median der früheren Phasen) und Ergebnis, nur an jedem `horizon`-ten Tag."""
    usable = part[part.a_count >= MIN_COUNT]
    days = sorted(usable.date.unique())[::horizon]
    values = []
    for day, group in usable[usable.date.isin(days)].groupby("date"):
        if len(group) >= 20:
            values.append(group.a_median.rank().corr(group.actual.rank()))
    values = pd.Series(values).dropna()
    t = values.mean() / values.std() * np.sqrt(len(values)) if len(values) > 2 else float("nan")
    return float(values.mean()), float(t), len(values)


def main() -> None:
    started = time.time()
    frames = asyncio.run(load())
    print(f"{len(frames)} Coins mit mindestens 400 zusammenhängenden Tageskerzen ({time.time() - started:.0f} s)")
    btc = frames["BTC"].close
    btc_above = (btc > btc.rolling(200).mean()).rename("btc_above")
    summary = {"coins": len(frames), "start": str(START.date()), "split": str(SPLIT.date()), "variants": []}

    with ProcessPoolExecutor() as pool:
        for length, horizon in GRID:
            tick = time.time()
            rows = pd.concat(pool.map(coin_rows, [(c, f, length, horizon) for c, f in frames.items()], chunksize=4))
            rows = rows.join(btc_above, on="date")
            rows["market"] = rows.groupby("date").actual.transform("median")
            rows["excess"] = rows.actual.clip(*WINSOR) - rows.market
            periods = {"Auswahl 2021–2023": rows[rows.date < SPLIT], "Prüfung 2024–2026": rows[rows.date >= SPLIT]}
            print(f"\n=== Muster {length} Tage, Ausgang nach {horizon} Tagen ({time.time() - tick:.0f} s) ===")
            variant = {"length": length, "horizon": horizon, "periods": {}}
            for name, part in periods.items():
                ic, ic_t, ic_days = daily_ic(part, horizon)
                base, trend = stats(part), stats(first_of_episode(part[part.trend_start & part.btc_above.fillna(False)], horizon))
                print(f"  {name}: Rangkorrelation Vorhersage/Ergebnis {ic:+.3f} (t {ic_t:+.1f}, {ic_days} Tage ohne Überlappung)")
                print(line("alle Coins und Tage (Vergleich)", base))
                print(line("Trendstart EMA 10/30 + BTC-Filter", trend))
                variant["periods"][name] = {"ic": ic, "ic_t": ic_t, "base": base, "trend_start": trend}

            best = None
            for share in SHARES:
                for med in MEDIANS:
                    def rule(p, share=share, med=med):
                        return p[(p.a_count >= MIN_COUNT) & (p.a_share_up >= share) & (p.a_median >= med)]
                    chosen = stats(first_of_episode(rule(periods["Auswahl 2021–2023"]), horizon))
                    if chosen["n"] >= 100 and (best is None or chosen["beat"] > best[0]["beat"]):
                        best = (chosen, share, med, rule)
            if best:
                _, share, med, rule = best
                label = f"≥{share:.0%} stiegen, Mittel ≥{med:.0%}"
                print(f"  Beste Schwelle in der Auswahl: {label}")
                variant["best"] = {"share": share, "median": med}
                for name, part in periods.items():
                    result = stats(first_of_episode(rule(part), horizon))
                    print(line(f"{name[:7]} Muster {label}", result))
                    variant["periods"][name]["signals"] = result
            summary["variants"].append(variant)
    RESULT.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nErgebnis gespeichert in {RESULT.name}. Fertig nach {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
