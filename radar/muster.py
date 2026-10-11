"""Mustersuche: Wie ging es nach früheren, ähnlichen Kursverläufen desselben Coins weiter?

- Muster: die letzten `length` Tagesschlusskurse, auf ihre Form normiert. Lage und Schwankungsbreite sind
  herausgerechnet, ein Anstieg von 100 auf 110 gleicht also einem von 2 auf 2,20.
- Ähnlich heißt: hohe Korrelation der Formen (1 = gleiche Form). Jede frühere Phase zählt nur einmal: Von ähnlichen
  Fenstern, deren Enddaten weniger als `horizon` Tage auseinanderliegen, zählt nur das ähnlichste.
- Es zählen nur Phasen, deren Ausgang an dem Tag schon feststand: Ihr Ende liegt mindestens 2 × `horizon` Tage zurück.
"""

import warnings

import numpy as np

TOP = 10         # so viele frühere Phasen werden höchstens verglichen
MIN_CORR = 0.8   # Mindestähnlichkeit einer früheren Phase


def shapes(close: np.ndarray, length: int) -> np.ndarray:
    """Form aller Fenster: z-normierte Log-Kurse. Zeile i endet am Tag i + length - 1."""
    windows = np.lib.stride_tricks.sliding_window_view(np.log(close), length)
    centered = windows - windows.mean(axis=1, keepdims=True)
    scale = centered.std(axis=1, keepdims=True)
    return np.divide(centered, scale, out=np.zeros_like(centered), where=scale > 1e-12)


def outcomes(close: np.ndarray, horizon: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Je Tag: Veränderung nach `horizon` Tagen, bester Stand innerhalb von 2 × horizon Tagen und nach wie vielen
    Tagen er erreicht war. NaN, wo die Zukunft noch nicht bekannt ist."""
    n = len(close)
    reach = 2 * horizon
    fwd = np.full(n, np.nan)
    if n > horizon:
        fwd[:n - horizon] = close[horizon:] / close[:n - horizon] - 1
    peak = np.full(n, np.nan)
    peak_day = np.full(n, np.nan)
    if n > reach:
        future = np.lib.stride_tricks.sliding_window_view(close[1:], reach)[:n - reach]  # Tage 1 … reach danach
        best = future.argmax(axis=1)
        peak[:n - reach] = future[np.arange(n - reach), best] / close[:n - reach] - 1
        peak_day[:n - reach] = best + 1
    return fwd, peak, peak_day


def similar(z: np.ndarray, rows: np.ndarray, horizon: int, top: int = TOP,
            min_corr: float = MIN_CORR) -> tuple[np.ndarray, np.ndarray]:
    """Für die Fenster `rows`: die ähnlichsten früheren Phasen, ähnlichste zuerst.
    Liefert Fenster-Indizes und Ähnlichkeit; -inf heißt: keine weitere Phase gefunden."""
    w, length = z.shape
    gap, sep = 2 * horizon, horizon
    corr = (z[rows] @ z.T) / length
    corr[np.arange(w)[None, :] > (rows[:, None] - gap)] = -np.inf  # Ausgang noch offen: zählt nicht
    padded = np.pad(corr, ((0, 0), (sep, sep)), constant_values=-np.inf)
    local = np.lib.stride_tricks.sliding_window_view(padded, 2 * sep + 1, axis=1).max(axis=2)
    corr[(corr < local) | (corr < min_corr)] = -np.inf  # je Phase nur das ähnlichste Fenster
    take = min(top, w)
    best = np.argpartition(-corr, take - 1, axis=1)[:, :take]
    chosen = np.take_along_axis(corr, best, axis=1)
    order = np.argsort(-chosen, axis=1)
    return np.take_along_axis(best, order, axis=1), np.take_along_axis(chosen, order, axis=1)


def analog_table(close: np.ndarray, length: int, horizon: int, from_day: int = 0, top: int = TOP,
                 min_corr: float = MIN_CORR, chunk: int = 400) -> dict[str, np.ndarray]:
    """Für jeden Tag ab `from_day`: Kennzahlen der ähnlichsten früheren Phasen, nur aus damals bekannten Daten.
    Alle Arrays haben die Länge von `close`; Tage ohne Auswertung sind NaN."""
    n = len(close)
    keys = ("count", "corr", "share_up", "median", "peak", "peak_day")
    result = {key: np.full(n, np.nan) for key in keys}
    if n < length + 2 * horizon + 1:
        return result
    z = shapes(close, length).astype(np.float32)
    end = np.arange(len(z)) + length - 1
    fwd, peak, peak_day = outcomes(close, horizon)
    for first in range(max(0, from_day - length + 1), len(z), chunk):
        rows = np.arange(first, min(first + chunk, len(z)))
        best, corr = similar(z, rows, horizon, top, min_corr)
        valid = np.isfinite(corr)
        days = end[best]
        count = valid.sum(axis=1)
        gains = np.where(valid, fwd[days], np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # Tage ohne frühere Phase: NaN
            result["count"][end[rows]] = count
            result["corr"][end[rows]] = np.nanmean(np.where(valid, corr, np.nan), axis=1)
            result["share_up"][end[rows]] = np.where(count > 0, ((gains > 0) & valid).sum(axis=1) / np.maximum(count, 1), np.nan)
            result["median"][end[rows]] = np.nanmedian(gains, axis=1)
            result["peak"][end[rows]] = np.nanmedian(np.where(valid, peak[days], np.nan), axis=1)
            result["peak_day"][end[rows]] = np.nanmedian(np.where(valid, peak_day[days], np.nan), axis=1)
    return result


def latest(close: np.ndarray, length: int, horizon: int, top: int = TOP, min_corr: float = MIN_CORR) -> list[dict]:
    """Die ähnlichsten früheren Phasen für den letzten Tag: Endtag, Ähnlichkeit und wie es danach weiterging."""
    if len(close) < length + 2 * horizon + 1:
        return []
    z = shapes(close, length).astype(np.float32)
    best, corr = similar(z, np.array([len(z) - 1]), horizon, top, min_corr)
    fwd, peak, peak_day = outcomes(close, horizon)
    found = []
    for index, value in zip(best[0], corr[0]):
        if not np.isfinite(value):
            break
        day = int(index) + length - 1
        found.append({"day": day, "corr": float(value), "change": float(fwd[day]), "peak": float(peak[day]),
                      "peak_day": int(peak_day[day]),
                      "path": (close[day:day + 2 * horizon + 1] / close[day] - 1).tolist()})
    return found
