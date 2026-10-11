"""Tägliche Auswertung für die App: Coinliste, Strategie-Status, Muster und Benachrichtigungen über ntfy.

Läuft in der Cloud (GitHub Actions) nach jedem Tagesschluss; lokal zum Testen aus dem Ordner krypto-radar:
    python -m radar.scan
Umgebung: RADAR_DATA (Ordner für Kursdaten), NTFY_TOPIC (geheimes ntfy-Thema, ohne: keine Benachrichtigungen),
APP_URL (Adresse der App für Links in den Nachrichten, sonst aus einstellungen.json).
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

from radar import muster, strategie
from radar.binance import Binance, continuous

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "daten"
SETTINGS = json.loads((ROOT / "einstellungen.json").read_text(encoding="utf-8"))
RESULT = ROOT / "analyse" / "muster_ergebnis.json"
RESULT_BTC = ROOT / "analyse" / "muster_btc_ergebnis.json"
DATA = Path(os.getenv("RADAR_DATA") or Path(os.getenv("LOCALAPPDATA", ROOT)) / "KryptoRadar" / "daten" / "1d")
NTFY_URL = "https://ntfy.sh"
HISTORY_DAYS = 120
MAX_SINGLE_MESSAGES = 5  # mehr Meldungen auf einmal: eine Sammelnachricht


def rounded(values, digits: int = 4) -> list[float]:
    return [round(float(value), digits) for value in values]


def pct(fraction: float, digits: int = 0, sign: bool = False) -> str:
    """Prozent in deutscher Schreibweise, z. B. pct(0.123, 1, True) -> '+12,3 %'."""
    return f"{fraction * 100:{'+' if sign else ''}.{digits}f} %".replace(".", ",")


def pattern(coin: str, frame: pd.DataFrame, config: dict) -> dict:
    """Ähnliche frühere Phasen für den letzten Tagesschluss, mit Kennzahlen wie in der Prüfung (muster_test.py)."""
    length, horizon = config["length"], config["horizon"]
    close = frame.close.to_numpy()
    found = muster.latest(close, length, horizon)
    dates = frame.index.strftime("%Y-%m-%d")
    analogs = [{
        "date": dates[item["day"]], "corr": round(item["corr"], 3), "change": round(item["change"], 4),
        "peak": round(item["peak"], 4), "peak_day": item["peak_day"], "path": rounded(item["path"]),
        "before": rounded(close[item["day"] - length + 1:item["day"] + 1] / close[item["day"]] - 1),
    } for item in found]
    changes = np.array([item["change"] for item in analogs])
    summary = {"count": len(analogs)}
    if analogs:
        summary.update(share_up=round(float((changes > 0).mean()), 3), median=round(float(np.median(changes)), 4),
                       peak=round(float(np.median([a["peak"] for a in analogs])), 4),
                       peak_day=float(np.median([a["peak_day"] for a in analogs])),
                       corr=round(float(np.mean([a["corr"] for a in analogs])), 3))
    return {"coin": coin, "as_of": dates[-1], "length": length, "horizon": horizon, "min_corr": muster.MIN_CORR,
            "recent": rounded(close[-length:] / close[-1] - 1), "summary": summary, "analogs": analogs}


def is_signal(summary: dict, config: dict) -> bool:
    return (summary["count"] >= config["min_count"] and summary["share_up"] >= config["share"]
            and summary["median"] >= config["median"])


def reliability(config: dict) -> dict | None:
    """Ergebnis der Prüfung für die gewählte Einstellung, als Satz für die App."""
    if config.get("nur_wenn_bitcoin_ueber_linie"):
        return reliability_btc(config)
    try:
        result = json.loads(RESULT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for variant in result["variants"]:
        if variant["length"] == config["length"] and variant["horizon"] == config["horizon"]:
            test = variant["periods"].get("Prüfung 2024–2026", {})
            signals, base = test.get("signals"), test.get("base")
            if not signals or not base or variant.get("best") != {"share": config["share"], "median": config["median"]}:
                return None
            text = (f"Geprüft an {result['coins']} Binance-Coins: Ausgewählt wurde mit Daten von 2021–2023, unabhängig geprüft "
                    f"2024–2026. In der Prüfung lag ein gemeldeter Coin {config['horizon']} Tage später in "
                    f"{pct(signals['beat'])} der Fälle vor dem mittleren Coin (Zufall: 50 %). Gestiegen ist er in "
                    f"{pct(signals['hit'])} der Fälle, alle Coins zusammen in {pct(base['hit'])}. Ein kleiner Vorsprung, "
                    f"keine Garantie.")
            return {"text": text, "beat": signals["beat"], "hit": signals["hit"], "base_hit": base["hit"], "n": signals["n"]}
    return None


def reliability_btc(config: dict) -> dict | None:
    """Wie reliability(), aber für Meldungen nur bei Bitcoin über seiner 200-Tage-Linie (muster_btc_filter.py)."""
    try:
        result = json.loads(RESULT_BTC.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for variant in result["variants"]:
        if [variant[k] for k in ("length", "horizon", "share", "median")] != [config[k] for k in ("length", "horizon", "share", "median")]:
            continue
        test = variant["periods"]["Prüfung 2024–2026 | Bitcoin über Linie"]
        signals, base = test["signals"], test["base"]
        text = (f"Geprüft an {result['coins']} Binance-Coins: Die Schwellen stammen aus den Jahren 2021–2023, geprüft wurde "
                f"unabhängig mit 2024–2026, jeweils in Zeiten mit Bitcoin über der 200-Tage-Linie. Nach einer Meldung lag "
                f"der Coin {config['horizon']} Tage später in {pct(signals['beat'])} der Fälle vor dem mittleren Coin "
                f"(Zufall: 50 %). Gestiegen ist er in {pct(signals['hit'])} der Fälle, alle Coins zur selben Zeit in "
                f"{pct(base['hit'])}. Im Mittel brachte eine Meldung {pct(signals['after_cost'], 1, True)} nach Kosten, "
                f"vor allem durch wenige große Gewinner – der typische Fall lag bei {pct(signals['median'], 1, True)}. "
                f"Ein kleiner Vorsprung, keine Garantie.")
        return {"text": text, "beat": signals["beat"], "hit": signals["hit"], "base_hit": base["hit"],
                "n": signals["n"], "per_week": round(test["per_week"], 1)}
    return None


def load_previous() -> dict:
    try:
        return json.loads((OUT / "signale.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


async def notify(client: httpx.AsyncClient, messages: list[dict]) -> bool:
    """Sendet die Nachrichten an das ntfy-Thema. Liefert False, wenn nichts gesendet wurde."""
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic:
        print(f"Kein NTFY_TOPIC gesetzt: {len(messages)} Nachrichten nicht gesendet")
        for message in messages:
            print(f"  {message['title']}: {message['message']}")
        return False
    if len(messages) > MAX_SINGLE_MESSAGES:
        messages = [{"title": f"Krypto-Radar: {len(messages)} Meldungen",
                     "message": "\n".join(f"• {m['title']}" for m in messages),
                     "click": SETTINGS_APP_URL, "tags": ["chart_with_upwards_trend"]}]
    for message in messages:
        payload = {"topic": topic, "priority": 3, **{k: v for k, v in message.items() if v}}
        response = await client.post(NTFY_URL, json=payload)
        response.raise_for_status()
    print(f"{len(messages)} Nachrichten über ntfy gesendet")
    return True


SETTINGS_APP_URL = (os.getenv("APP_URL") or SETTINGS.get("app_url") or "").rstrip("/") + "/"


def app_link(coin: str) -> str:
    return f"{SETTINGS_APP_URL}#/coin/{coin}" if SETTINGS_APP_URL != "/" else ""


async def main() -> None:
    config = SETTINGS["muster"]
    min_volume, min_days = SETTINGS["min_volume_usdt"], SETTINGS["min_days"]
    async with httpx.AsyncClient(timeout=30, headers={"User-Agent": "KryptoRadar/1.0"}) as client:
        api = Binance(client, DATA)
        coins = await api.coins()
        frames = dict(zip(coins, await asyncio.gather(*(api.daily(coin) for coin in coins))))
        frames = {coin: continuous(frame) for coin, frame in frames.items() if len(frame)}
        btc = frames["BTC"].close
        as_of = btc.index[-1].strftime("%Y-%m-%d")
        btc_now, btc_before = strategie.btc_filter(btc), strategie.btc_filter(btc.iloc[:-1])

        items, signals, messages = [], [], []
        allowed = bool(btc_now and btc_now["above"]) or not config.get("nur_wenn_bitcoin_ueber_linie")
        (OUT / "muster").mkdir(parents=True, exist_ok=True)
        for old in (OUT / "muster").glob("*.json"):
            old.unlink()
        for coin, frame in sorted(frames.items()):
            if frame.index[-1].strftime("%Y-%m-%d") != as_of:
                continue  # Coin wird gerade nicht gehandelt
            volume = float(frame.quote_volume.tail(30).median())
            item = {"coin": coin, "days": len(frame), "volume": round(volume), "trend": strategie.trend(frame.close)}
            if volume >= min_volume and len(frame) >= min_days:
                data = pattern(coin, frame, config)
                write(OUT / "muster" / f"{coin}.json", data)
                if data["summary"]["count"]:
                    item["muster"] = data["summary"]
                    item["deutlich"] = is_signal(data["summary"], config)
                    if item["deutlich"] and allowed:  # deutliches Muster und Bitcoin-Filter erfüllt
                        item["signal"] = True
                        signals.append({"coin": coin, "date": as_of, "close": float(frame.close.iloc[-1]),
                                        "horizon": config["horizon"], **data["summary"]})
            items.append(item)

        # Verlauf: frühere Meldungen mit Ergebnis nach `horizon` Tagen, dieselbe Meldung nicht doppelt
        previous = load_previous()
        already_sent = set(previous.get("sent", [])) if previous.get("as_of") == as_of else set()
        history = [entry for entry in previous.get("history", []) if entry["date"] != as_of]
        recent = {entry["coin"] for entry in history
                  if (pd.Timestamp(as_of) - pd.Timestamp(entry["date"])).days <= config["horizon"]}
        new_signals = [signal for signal in signals if signal["coin"] not in recent]
        cutoff = pd.Timestamp(as_of) - pd.Timedelta(days=HISTORY_DAYS)
        history = [entry for entry in history if pd.Timestamp(entry["date"]) >= cutoff]
        for entry in history:
            frame = frames.get(entry["coin"])
            target = pd.Timestamp(entry["date"]) + pd.Timedelta(days=entry["horizon"])
            if entry.get("result") is None and frame is not None and target in frame.index:
                entry["result"] = round(float(frame.close.loc[target] / entry["close"] - 1), 4)
        history = sorted(new_signals + history, key=lambda entry: entry["date"], reverse=True)

        if config.get("melden"):
            for signal in new_signals:
                up = round(signal["share_up"] * signal["count"])
                messages.append({
                    "title": f"Muster: {signal['coin']}",
                    "message": (f"Ähnlich wie {signal['count']} frühere Phasen von {signal['coin']}. Danach stieg der Kurs "
                                f"in {up} von {signal['count']} Fällen, im Mittel {pct(signal['median'], 1, True)} in "
                                f"{signal['horizon']} Tagen."),
                    "click": app_link(signal["coin"]), "tags": ["mag"]})

        strategy = SETTINGS["strategie"]
        if strategy.get("melden") and btc_now and btc_before:
            if btc_now["above"] != btc_before["above"]:
                messages.append({
                    "title": "Bitcoin-Filter: " + ("über der 200-Tage-Linie" if btc_now["above"] else "unter der 200-Tage-Linie"),
                    "message": ("Die Strategie darf wieder kaufen." if btc_now["above"]
                                else "Laut Strategie werden alle Coins verkauft."),
                    "click": app_link("BTC"), "tags": ["warning"]})
            for coin in strategy["coins"]:
                frame = frames.get(coin)
                if frame is None or len(frame) < 2 * strategie.SLOW + 1:
                    continue
                now, before = strategie.trend(frame.close), strategie.trend(frame.close.iloc[:-1])
                if now["in_trend"] != before["in_trend"]:
                    action = ("kaufen" if btc_now["above"] else "noch nicht kaufen (Bitcoin-Filter)") if now["in_trend"] else "verkaufen"
                    messages.append({
                        "title": f"Strategie {coin}: {'Trend beginnt' if now['in_trend'] else 'Trend endet'}",
                        "message": f"EMA 10 jetzt {'über' if now['in_trend'] else 'unter'} EMA 30. Laut Strategie: {action}.",
                        "click": app_link(coin), "tags": ["chart_with_upwards_trend" if now["in_trend"] else "chart_with_downwards_trend"]})

        messages = [message for message in messages if message["title"] not in already_sent]  # schon gemeldet
        sent = []
        if messages:
            try:
                if await notify(client, messages):
                    sent = [message["title"] for message in messages]
            except httpx.HTTPError as exc:
                print(f"ntfy nicht erreichbar ({type(exc).__name__}): Nachrichten folgen beim nächsten Lauf")
        updated = datetime.now(timezone.utc).isoformat(timespec="seconds")
        write(OUT / "stand.json", {
            "updated": updated, "as_of": as_of, "btc": btc_now,
            "muster": {**{k: config[k] for k in ("length", "horizon", "min_count", "share", "median")},
                       "btc_filter": bool(config.get("nur_wenn_bitcoin_ueber_linie")), "melden": bool(config.get("melden")),
                       "pruefung": reliability(config)},
            "coins": items})
        write(OUT / "signale.json", {"updated": updated, "as_of": as_of, "signals": signals, "history": history,
                                     "sent": sorted(already_sent | set(sent))})
        print(f"Stand {as_of}: {len(items)} Coins, {sum('muster' in i for i in items)} mit Musterauswertung, "
              f"{len(signals)} Muster ({len(new_signals)} neu), {len(sent)} von {len(messages)} Nachrichten gesendet")


if __name__ == "__main__":
    asyncio.run(main())
