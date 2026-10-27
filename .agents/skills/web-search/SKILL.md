---
name: web-search
description: Websuche und Ergebnisabruf über firecrawl-cli und playwright-cli. Nutze diesen Skill, wenn aktuelle Web-Daten, Suchergebnisse, Scraping, Crawling oder JavaScript-gerenderte Seiten benötigt werden.
---

# Web-Suche und Ergebnisabruf

Dieser Skill bündelt die beiden installierten CLI-Tools für Websuche und Abruf
von Web-Ergebnissen:

- **`firecrawl`** (firecrawl-cli): Suche, Scraping, Crawling und Parsen von
  Seiten. Schnell und token-effizient.
- **`playwright-cli`** (@playwright/cli): Headless-Browser-Automatisierung für
  Seiten, die JavaScript rendern, Interaktionen oder Login erfordern.

## Werkzeugwahl

| Situation | Werkzeug |
| --- | --- |
| Websuche (Snippets/Highlights) | `firecrawl search` |
| Statische Seite / Markdown-Abruf | `firecrawl scrape` |
| Lokale Datei parsen (HTML/PDF/DOCX/XLSX) | `firecrawl parse` |
| JS-gerenderte Seite, Paywall, Login, Interaktion | `playwright-cli` |
| `firecrawl` schlägt fehl oder liefert leeren Inhalt | Fallback auf `playwright-cli` |

## 1. Websuche mit firecrawl

```bash
firecrawl search "Suchbegriff"
firecrawl search "Suchbegriff" --limit 10 --sources web,news
firecrawl search "Suchbegriff" --tbs qdr:w --location "Deutschland"
```

- `--limit`: Anzahl der Ergebnisse (Standard 5, max 100).
- `--sources`: `web, images, news, alexandria`.
- `--tbs`: Zeitbasierte Suche: `qdr:h` (Stunde), `qdr:d` (Tag), `qdr:w`
  (Woche), `qdr:m` (Monat), `qdr:y` (Jahr).
- `--location`/`--country`: Geo-Targeting.
- `--scrape`: Suchergebnisse direkt mitscrapen (`--scrape-formats markdown`).

## 2. Ergebnisabruf mit firecrawl

```bash
firecrawl scrape "https://example.com"
firecrawl scrape -u "https://example.com" -f markdown
firecrawl scrape "https://a.com" "https://b.com"    # mehrere URLs -> .firecrawl/
firecrawl scrape -f markdown,links,summary "https://example.com"
firecrawl parse ./seite.html -f markdown
firecrawl parse ./dokument.pdf -Q "Fasse den Inhalt zusammen"
```

- `-f/--format`: `markdown, html, rawHtml, links, images, screenshot, summary,
  json, attributes, branding`.
- `-o/--output`: Ausgabe in Datei statt stdout.
- `-Q/--query`: Frage an den Inhalt stellen (bei `parse`).
- `firecrawl map <url>`: URLs einer Website auflisten; `firecrawl crawl <url>`:
  Website crawlen.

## 3. Browser-Automatisierung mit playwright-cli

Wichtig: Browser immer mit `--browser=chromium` starten. Der Default-Channel
`chrome` ist in dieser Umgebung nicht installiert (Root-Zugriff fehlt).

```bash
playwright-cli open --browser=chromium "https://example.com"   # oder: open --browser=chromium
playwright-cli goto "https://example.com"
playwright-cli snapshot          # Seitenstruktur + refs ansehen
playwright-cli click e15
playwright-cli fill e5 "Suchbegriff" --submit
playwright-cli find "Text"       # nach Text auf der Seite suchen
playwright-cli screenshot
playwright-cli close
```

- `snapshot` liefert die Seitenstruktur mit `ref=`-Elementen, die für
  `click`/`fill`/`hover`/`select` genutzt werden.
- `--raw`/`--json` für maschinenlesbare Ausgabe.
- Sessions: `-s=<name>`, `list`, `close-all`, `kill-all`.

## Voraussetzungen / Setup

- `firecrawl` funktioniert in dieser Umgebung **ohne API-Key**: `search`,
  `scrape` und `parse` liefern Ergebnisse über den Standard-Endpoint
  `https://api.firecrawl.dev` (kein lokaler Server nötig). Ein API-Key via
  `firecrawl login` oder `FIRECRAWL_API_KEY` ist nur für zusätzliche Features
  (z. B. `alexandria`-Tools, höhere Limits) nötig. `firecrawl status` zeigt
  trotzdem „Not authenticated“ – das ist ein Anzeige-Hinweis, keine Blockerin.
- `playwright-cli` benötigt einen installierten Browser:
  `playwright-cli install-browser chromium` (Headless Shell + Chromium) und
  Start mit `--browser=chromium`. Volles Chrome erfordert Root und ist hier
  nicht möglich.
- Beide CLIs liegen unter `/home/node/.local/bin`.

## Hinweise

- `firecrawl status` zeigt „Not authenticated“ – das blockiert `search`/`scrape`
  in dieser Umgebung nicht; trotzdem liefern sie Ergebnisse. Bei Fehlern hilft
  `firecrawl doctor`.
- Behalte Quellen und URLs im Ergebnis bei.
- Wenn ein Browser fehlt: `playwright-cli install-browser chromium` und mit
  `--browser=chromium` starten. Statt Ergebnisse zu erfinden, auf fehlende
  Komponenten hinweisen.
