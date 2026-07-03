# Wegovy Pill UK Launch — Press Monitor

Standalone monitor that tracks press and social mentions of the **Wegovy pill
(oral semaglutide)** around its UK launch. Runs entirely on GitHub Actions —
no server, database, or hosting needed.

## 📊 Where to look

**The live report** (updates every 30 minutes):
[`monitor-data/REPORT.md` on the `press-monitor-data` branch](../../blob/press-monitor-data/monitor-data/REPORT.md)

Raw data sits next to it as `mentions.json`. Scan runs are visible in the
[Actions tab](../../actions), where **Run workflow** triggers an immediate scan.

## What it scans

| Source | How | Notes |
| --- | --- | --- |
| 📰 News | Google News UK RSS searches | Covers national press and TV broadcasters' sites (BBC, Sky, ITV, C4) |
| 📺 TV / YouTube | BBC News, Sky News, Channel 4 News, ITV News channel feeds | Broadcast segments about the launch |
| 💬 Reddit | Site-wide searches + r/WegovyWeightLoss, r/Semaglutide, r/Mounjaro, r/loseit, r/ukhealth | ⚠️ Reddit blocks GitHub-runner IPs (403) — needs authenticated API credentials to work from Actions |
| 🐦 X / Twitter | v2 recent search | Requires a `TWITTER_BEARER_TOKEN` repo secret (X has no free API); skipped otherwise |

Keyword matching: exact phrases ("wegovy pill", "oral wegovy", "oral
semaglutide", "wegovy tablet", …) plus "wegovy" combined with a
pill/tablet/oral/launch context word. Mentions are deduplicated by URL across
scans.

## Configuration

- **Keywords / sources** — edit the constant blocks at the top of `monitor.ts`.
- **Cadence** — edit the cron in `.github/workflows/press-monitor.yml`
  (every 30 min during launch week; relax afterwards).
- **X/Twitter** — add `TWITTER_BEARER_TOKEN` under Settings → Secrets →
  Actions.

## Run locally

```bash
npm install
npm run scan          # writes monitor-data/REPORT.md + mentions.json
```
