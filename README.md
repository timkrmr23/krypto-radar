# Krypto-Radar

Web-App fürs iPhone: alle Coins, die bei Binance handelbar sind, Ihre Käufe mit aktuellem Kurs, der Stand nach der Strategie **EMA 10/30 mit Bitcoin-Filter** und Muster aus der Vergangenheit mit Benachrichtigung.

## Was die App kann

- **Start:** Ihre Käufe mit aktuellem Wert, Gewinn/Verlust und dem Stand nach der Strategie (halten, verkaufen), dazu Ihre Marker und neue Muster.
- **Coins:** alle Binance-Coins gegen USDT (rund 490), Kurse live in Euro, Suche und Sortierung nach Umsatz, 24 h, Trend oder Name.
- **Coin-Details:** Kurschart mit EMA 10 und EMA 30, Strategie-Status, ähnliche frühere Verläufe mit Datum und Ausgang, „Kauf eintragen“ und „Marker setzen“.
- **Marker:** als hätten Sie gekauft. Die App vergleicht die folgenden Tage mit den früheren ähnlichen Phasen.
- **Muster:** heutige Meldungen, frühere Meldungen mit tatsächlichem Ergebnis und die Testergebnisse.
- **Benachrichtigungen** über die App ntfy: deutliche Muster sowie Trendbeginn und -ende der Strategie für die 15 getesteten Coins.

Käufe und Marker bleiben nur auf dem iPhone (im Speicher der Web-App). Unter „Mehr“ lassen sie sich als Datei sichern.

## So funktioniert es

| Teil | Wo | Was |
|---|---|---|
| Web-App (`web/`) | GitHub Pages | Oberfläche; Kurse holt sie direkt von Binance |
| Cloud-Lauf (`radar/scan.py`) | GitHub Actions, täglich 07:05 UTC | lädt die Tageskerzen aller Coins, wertet Strategie und Muster aus, schreibt `web/daten/` und sendet Benachrichtigungen |
| Benachrichtigungen | ntfy.sh | Nachricht aufs iPhone; ein Tippen öffnet den Coin in der App |

Die Mustersuche (`radar/muster.py`) vergleicht den Verlauf der letzten 20 Tage eines Coins mit seiner eigenen Vergangenheit, und zwar mit der Form: Lage und Schwankungsbreite sind herausgerechnet. Jede frühere Phase zählt einmal, und nur Phasen, deren Ausgang feststand. Dieselben Bausteine nutzt die Prüfung in `analyse/`.

## Was die Prüfung ergeben hat

Geprüft an 340 Binance-Coins mit mindestens 400 Tagen Kursgeschichte, nur Tage mit mindestens 1 Mio. USDT Umsatz. Die Schwellen wurden mit 2021–2023 ausgewählt, unabhängig geprüft wurde mit 2024–2026 (`analyse/muster_test.py`, `analyse/muster_btc_filter.py`).

- Ohne Filter sagen die Muster kaum etwas voraus (Rangkorrelation 0,00–0,05).
- **Deutliches Muster** (mindestens 6 ähnliche Phasen, davon mindestens 90 % gestiegen, im Mittel mindestens +10 % in 10 Tagen) **bei Bitcoin über seiner 200-Tage-Linie**:

| | Auswahl 2021–2023 | Prüfung 2024–2026 |
|---|---|---|
| Vor dem mittleren Coin nach 10 Tagen (Zufall: 50 %) | 60 % | 57 % |
| Gestiegen (alle Coins zur selben Zeit) | 51 % (49 %) | 49 % (39 %) |
| Ø nach Kosten / typischer Fall (Median) | +2,1 % / +0,4 % | +1,8 % / −0,4 % |
| Meldungen | 0,7 pro Woche | 1,4 pro Woche |

- Bei Bitcoin unter der Linie lagen gemeldete Coins in der Prüfung nur in 45 % der Fälle vorn. Deshalb meldet die App dann nichts.

Fazit: ein kleiner, in beiden Zeiträumen sichtbarer Vorsprung gegenüber anderen Coins, aber keine Garantie, dass ein Coin steigt. Der Durchschnitt lebt von wenigen großen Gewinnern. Nur heute gelistete Coins sind enthalten; Coins, die Binance entfernt hat, fehlen.

## Einrichtung

1. **GitHub-Konto** anlegen (kostenlos) und ein neues, öffentliches Repository `krypto-radar` erstellen.
2. Den Ordner `krypto-radar` dorthin hochladen (`git push`).
3. Im Repository: **Settings → Pages → Source: GitHub Actions**.
4. **Settings → Secrets and variables → Actions → New repository secret:** Name `NTFY_TOPIC`, Wert: Ihr geheimes ntfy-Thema.
5. **Actions → Krypto-Radar → Run workflow** (danach läuft es täglich von selbst).
6. Auf dem iPhone: App **ntfy** aus dem App Store installieren, Thema abonnieren (Server `ntfy.sh`).
7. In Safari `https://<Ihr-Name>.github.io/krypto-radar/` öffnen → Teilen → **Zum Home-Bildschirm**.

Das Repository ist öffentlich, also sind der Code und die täglichen Marktauswertungen für alle sichtbar. Ihre Käufe sind nicht darin. Das ntfy-Thema steht nur im GitHub-Secret und darf nicht in eine Datei des Repositorys.

## Einstellungen (`einstellungen.json`)

| Schlüssel | Bedeutung |
|---|---|
| `muster.length`, `muster.horizon` | Musterlänge und Zeitraum für den Ausgang in Tagen |
| `muster.min_count`, `share`, `median` | Bedingungen für ein deutliches Muster |
| `muster.nur_wenn_bitcoin_ueber_linie` | Meldungen nur bei Bitcoin über seiner 200-Tage-Linie |
| `muster.melden` | Muster per ntfy melden (true/false) |
| `strategie.melden`, `strategie.coins` | Trendbeginn/-ende der Strategie für diese Coins melden |
| `min_volume_usdt`, `min_days` | Mindestumsatz und Mindestgeschichte für die Mustersuche |

Werden Schwellen geändert, passen die Testergebnisse in der App nicht mehr. Dann `analyse/muster_btc_filter.py` mit den neuen Werten neu rechnen.

## Dateien

| Datei | Zweck |
|---|---|
| `web/` | Die Web-App: `index.html`, `app.js`, `style.css`, `sw.js` (offline), `manifest.webmanifest`, `icons/` |
| `radar/binance.py` | Öffentliche Binance-Daten mit Zwischenspeicher, Bereinigung von Kursbrüchen |
| `radar/muster.py` | Suche nach ähnlichen früheren Verläufen |
| `radar/strategie.py` | EMA 10/30 mit Bitcoin-Filter (wie in der Trading-Desk-App) |
| `radar/scan.py` | Täglicher Cloud-Lauf |
| `analyse/` | Prüfung an der Vergangenheit und gespeicherte Ergebnisse |
| `werkzeuge/symbole.py` | Zeichnet die App-Symbole |
| `.github/workflows/radar.yml` | Zeitplan und Ablauf bei GitHub |
| `verlauf/signale.json` | Frühere Meldungen (vom Cloud-Lauf gepflegt) |

## Lokal testen

Aus dem Ordner `krypto-radar` (Python mit `httpx`, `numpy`, `pandas`):

```bash
python -m radar.scan
python -m http.server 8790 --directory web
```

Dann http://localhost:8790 öffnen. Ohne `NTFY_TOPIC` werden Benachrichtigungen nur angezeigt, nicht gesendet.

Die App zeigt Regeln und Auswertungen der Vergangenheit. Das ist keine Anlageberatung und keine Prognose.
