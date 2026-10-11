"""Trendfolge EMA 10/30 mit Bitcoin-Filter – dieselben Regeln wie in der Trading-Desk-App (trend_strategy.py).

- Ein Coin ist im Trend, solange seine EMA 10 über seiner EMA 30 liegt (Tagesschlusskurse, UTC).
- Gehalten wird nur, solange Bitcoin über seiner 200-Tage-Linie schließt.
"""

import pandas as pd

FAST, SLOW = 10, 30
BTC_DAYS = 200


def _since(flags: pd.Series) -> pd.Timestamp:
    changes = flags.ne(flags.shift())
    return changes[changes].index[-1]  # erster Tag des aktuellen Zustands


def trend(close: pd.Series) -> dict | None:
    """Trendstatus am letzten Tagesschluss. close: abgeschlossene Tageskerzen, Index = Datum."""
    if len(close) < 2 * SLOW:
        return None
    fast = close.ewm(span=FAST, adjust=False).mean()
    slow = close.ewm(span=SLOW, adjust=False).mean()
    flags = fast > slow
    return {
        "in_trend": bool(flags.iloc[-1]),
        "since": _since(flags).strftime("%Y-%m-%d"),
        "gap_pct": round(float((fast.iloc[-1] / slow.iloc[-1] - 1) * 100), 2),
    }


def btc_filter(btc_close: pd.Series) -> dict | None:
    """Liegt Bitcoin am letzten Tagesschluss über seiner 200-Tage-Linie?"""
    if len(btc_close) < BTC_DAYS + 10:
        return None
    average = btc_close.rolling(BTC_DAYS).mean()
    above = btc_close > average
    return {
        "above": bool(above.iloc[-1]),
        "since": _since(above).strftime("%Y-%m-%d"),
        "close": float(btc_close.iloc[-1]),
        "average": round(float(average.iloc[-1]), 2),
    }
