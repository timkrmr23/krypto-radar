"""Ergänzung zu muster_test.py: Wie liefen die Muster-Signale je nach Bitcoin-Filter (Bitcoin über/unter seiner
200-Tage-Linie) und wie viele Meldungen gäbe es pro Woche? Die Schwellen stammen aus der Auswahl 2021–2023.

Aufruf aus dem Ordner krypto-radar:
    %LOCALAPPDATA%\\TradingDesk\\venv\\Scripts\\python.exe -u analyse\\muster_btc_filter.py
"""

import asyncio
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import muster_test as base  # noqa: E402

RESULT = Path(__file__).resolve().parent / "muster_btc_ergebnis.json"  # liest der tägliche Lauf (radar/scan.py)

# (Musterlänge, Horizont, Anteil gestiegen, Mittel) – je Variante die beste Schwelle aus der Auswahl
CANDIDATES = [(20, 5, 0.9, 0.0), (20, 10, 0.9, 0.10), (30, 10, 0.8, 0.0), (30, 20, 0.8, 0.10)]


def main() -> None:
    frames = asyncio.run(base.load())
    btc = frames["BTC"].close
    btc_above = (btc > btc.rolling(200).mean()).rename("btc_above")
    summary = {"coins": len(frames), "variants": []}
    with ProcessPoolExecutor() as pool:
        for length, horizon, share, med in CANDIDATES:
            rows = pd.concat(pool.map(base.coin_rows, [(c, f, length, horizon) for c, f in frames.items()], chunksize=4),
                             ignore_index=True)
            rows = rows.join(btc_above, on="date")
            rows["market"] = rows.groupby("date").actual.transform("median")
            rows["excess"] = rows.actual.clip(*base.WINSOR) - rows.market
            signals = rows[(rows.a_count >= base.MIN_COUNT) & (rows.a_share_up >= share) & (rows.a_median >= med)]
            print(f"\n=== Muster {length} T., Ausgang nach {horizon} T., ≥{share:.0%} stiegen, Mittel ≥{med:.0%} ===")
            variant = {"length": length, "horizon": horizon, "share": share, "median": med, "periods": {}}
            for name, later in (("Auswahl 2021–2023", False), ("Prüfung 2024–2026", True)):
                period = (rows.date >= base.SPLIT) == later
                weeks = (rows[period].date.max() - rows[period].date.min()).days / 7
                for label, regime in (("Bitcoin über Linie", True), ("Bitcoin unter Linie", False)):
                    part = rows[period & (rows.btc_above == regime)]
                    chosen = signals[((signals.date >= base.SPLIT) == later) & (signals.btc_above == regime)]
                    found = base.first_of_episode(chosen, horizon)
                    all_stats, signal_stats = base.stats(part), base.stats(found)
                    print(base.line(f"{name[:7]} {label}: alle", all_stats))
                    print(base.line(f"{name[:7]} {label}: Signale", signal_stats) + f"  ({len(found) / weeks:.1f} je Woche)")
                    variant["periods"][f"{name} | {label}"] = {"base": all_stats, "signals": signal_stats,
                                                                "per_week": len(found) / weeks}
            summary["variants"].append(variant)
    RESULT.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nErgebnis gespeichert in {RESULT.name}")


if __name__ == "__main__":
    main()
