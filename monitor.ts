/**
 * Wegovy Pill UK Launch — Press Monitor
 *
 * Self-contained scanner, run every 30 minutes by GitHub Actions
 * (.github/workflows/press-monitor.yml). Sources:
 *   1. news    — Google News UK RSS search (national press + TV broadcaster sites)
 *   2. youtube — broadcaster YouTube channel feeds (TV news segments)
 *   3. reddit  — site-wide keyword search + high-signal subreddit new-post streams
 *                (note: Reddit rejects GitHub-runner IPs with 403 unless you add
 *                 authenticated API credentials)
 *   4. twitter — X/Twitter v2 recent search (needs TWITTER_BEARER_TOKEN; X has
 *                no free API, so this source is skipped otherwise)
 *
 * State + report are written to monitor-data/ and published to the
 * `press-monitor-data` branch by the workflow.
 *
 * Run locally: npm run scan
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import RSSParser from "rss-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "monitor-data");
const STATE_FILE = path.join(DATA_DIR, "mentions.json");
const REPORT_FILE = path.join(DATA_DIR, "REPORT.md");
const MAX_STORED = 2000;

// ── Keywords ─────────────────────────────────────────────────────────────────
// A mention must contain at least one exact phrase, OR "wegovy" plus a
// pill/launch context word (catches "Wegovy's new pill launches in the UK").
const EXACT_KEYWORDS = [
  "wegovy pill",
  "wegovy pills",
  "oral wegovy",
  "wegovy tablet",
  "wegovy tablets",
  "wegovy oral",
  "oral semaglutide",
  "semaglutide pill",
  "semaglutide pills",
  "semaglutide tablet",
  "semaglutide tablets",
];
const CONTEXT_WORDS = ["pill", "pills", "tablet", "tablets", "oral", "launch", "launches", "launching"];

function matchKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const matched = EXACT_KEYWORDS.filter(kw => lower.includes(kw));
  if (matched.length === 0 && lower.includes("wegovy")) {
    const context = CONTEXT_WORDS.filter(w => new RegExp(`\\b${w}\\b`).test(lower));
    if (context.length > 0) matched.push(...context.map(w => `wegovy+${w}`));
  }
  return matched;
}

// ── Sources ──────────────────────────────────────────────────────────────────
const GOOGLE_NEWS_QUERIES = [
  `"wegovy pill" when:7d`,
  `"oral wegovy" when:7d`,
  `"wegovy tablet" when:7d`,
  `"oral semaglutide" when:7d`,
  `wegovy pill uk launch when:7d`,
];

const YOUTUBE_CHANNELS = [
  { name: "BBC News", channelId: "UC16niRr50-MSBwiO3YDb3RA" },
  { name: "Sky News", channelId: "UCoMdktPbSTixAyNGwb-UYkQ" },
  { name: "Channel 4 News", channelId: "UCTrQ7HXWRRxr7OsOtodr2_w" },
  { name: "ITV News", channelId: "UCFQgi22Ht00CpaOQLtvZx2A" },
];

const REDDIT_QUERIES = [
  `"wegovy pill"`,
  `"oral wegovy"`,
  `"oral semaglutide"`,
  `"wegovy tablet"`,
  `wegovy pill uk`,
];

const REDDIT_SUBREDDITS = ["WegovyWeightLoss", "Semaglutide", "Mounjaro", "loseit", "ukhealth"];

const TWITTER_QUERY =
  `("wegovy pill" OR "oral wegovy" OR "wegovy tablet" OR "oral semaglutide") -is:retweet lang:en`;

const USER_AGENT = "WegovyPressMonitor/1.0 (+https://github.com/scottlawrieai/wegovy-press-monitor)";
const parser = new RSSParser({ timeout: 10000, headers: { "User-Agent": USER_AGENT } });

interface Mention {
  sourceType: "news" | "reddit" | "youtube" | "twitter";
  sourceName: string;
  title: string;
  snippet: string;
  url: string;
  author: string | null;
  matchedKeywords: string[];
  publishedAt: string | null;
  fetchedAt: string;
}

const NOW_ISO = new Date().toISOString();

// ── Fetchers (each is best-effort: failures are logged and skipped) ──────────
async function fetchGoogleNews(errors: string[]): Promise<Mention[]> {
  const mentions: Mention[] = [];
  for (const query of GOOGLE_NEWS_QUERIES) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
      const feed = await parser.parseURL(url);
      for (const item of feed.items.slice(0, 30)) {
        const title = item.title || "";
        const snippet = item.contentSnippet || item.content || "";
        const matched = matchKeywords(`${title} ${snippet}`);
        if (matched.length === 0) continue;
        mentions.push({
          sourceType: "news",
          sourceName: (item as { source?: string }).source || "Google News UK",
          title,
          snippet: snippet.slice(0, 500),
          url: item.link || "",
          author: null,
          matchedKeywords: matched,
          publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
          fetchedAt: NOW_ISO,
        });
      }
    } catch (err) {
      errors.push(`google-news(${query}): ${err}`);
    }
  }
  return mentions;
}

async function fetchYouTube(errors: string[]): Promise<Mention[]> {
  const mentions: Mention[] = [];
  for (const channel of YOUTUBE_CHANNELS) {
    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`;
      const feed = await parser.parseURL(url);
      for (const item of feed.items.slice(0, 25)) {
        const title = item.title || "";
        const snippet = item.contentSnippet || item.content || "";
        const matched = matchKeywords(`${title} ${snippet}`);
        if (matched.length === 0) continue;
        mentions.push({
          sourceType: "youtube",
          sourceName: `${channel.name} (YouTube)`,
          title,
          snippet: snippet.slice(0, 500),
          url: item.link || "",
          author: channel.name,
          matchedKeywords: matched,
          publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
          fetchedAt: NOW_ISO,
        });
      }
    } catch (err) {
      errors.push(`youtube(${channel.name}): ${err}`);
    }
  }
  return mentions;
}

interface RedditChild {
  data: {
    title?: string;
    selftext?: string;
    permalink?: string;
    author?: string;
    subreddit?: string;
    created_utc?: number;
  };
}

async function fetchRedditListing(url: string, sourceLabel: string | null, errors: string[]): Promise<Mention[]> {
  const mentions: Mention[] = [];
  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as { data?: { children?: RedditChild[] } };
    for (const child of json.data?.children ?? []) {
      const post = child.data;
      const title = post.title || "";
      const body = post.selftext || "";
      const matched = matchKeywords(`${title} ${body}`);
      if (matched.length === 0) continue;
      mentions.push({
        sourceType: "reddit",
        sourceName: sourceLabel || `r/${post.subreddit ?? "reddit"}`,
        title,
        snippet: body.slice(0, 500),
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : "",
        author: post.author ? `u/${post.author}` : null,
        matchedKeywords: matched,
        publishedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        fetchedAt: NOW_ISO,
      });
    }
  } catch (err) {
    errors.push(`reddit(${sourceLabel || url}): ${err}`);
  }
  return mentions;
}

async function fetchReddit(errors: string[]): Promise<Mention[]> {
  const mentions: Mention[] = [];
  for (const query of REDDIT_QUERIES) {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=50`;
    mentions.push(...(await fetchRedditListing(url, null, errors)));
  }
  for (const sub of REDDIT_SUBREDDITS) {
    const url = `https://www.reddit.com/r/${sub}/new.json?limit=50`;
    mentions.push(...(await fetchRedditListing(url, `r/${sub}`, errors)));
  }
  return mentions;
}

interface TweetData {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
}

async function fetchTwitter(errors: string[]): Promise<Mention[]> {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) {
    console.log("TWITTER_BEARER_TOKEN not set — skipping X/Twitter source");
    return [];
  }
  const mentions: Mention[] = [];
  try {
    const url =
      `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(TWITTER_QUERY)}` +
      `&max_results=50&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as {
      data?: TweetData[];
      includes?: { users?: { id: string; username: string }[] };
    };
    const users = new Map((json.includes?.users ?? []).map(u => [u.id, u.username]));
    for (const tweet of json.data ?? []) {
      const matched = matchKeywords(tweet.text);
      if (matched.length === 0) continue;
      const username = tweet.author_id ? users.get(tweet.author_id) : undefined;
      mentions.push({
        sourceType: "twitter",
        sourceName: "X / Twitter",
        title: tweet.text.slice(0, 200),
        snippet: tweet.text,
        url: `https://x.com/${username ?? "i"}/status/${tweet.id}`,
        author: username ? `@${username}` : null,
        matchedKeywords: matched,
        publishedAt: tweet.created_at ? new Date(tweet.created_at).toISOString() : null,
        fetchedAt: NOW_ISO,
      });
    }
  } catch (err) {
    errors.push(`twitter: ${err}`);
  }
  return mentions;
}

// ── Report ───────────────────────────────────────────────────────────────────
const SOURCE_LABELS: Record<string, string> = {
  news: "📰 News (Google News UK)",
  youtube: "📺 TV / YouTube",
  reddit: "💬 Reddit",
  twitter: "🐦 X / Twitter",
};

function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function buildReport(mentions: Mention[], added: number, sourceErrors: string[]): string {
  const now = new Date();
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const last24h = mentions.filter(m => new Date(m.fetchedAt).getTime() >= dayAgo).length;

  const lines: string[] = [
    "# Wegovy Pill UK Launch — Press Monitor Report",
    "",
    `_Last scan: ${now.toISOString().replace("T", " ").slice(0, 16)} UTC · runs every 30 min via GitHub Actions_`,
    "",
    `| Total mentions | New in last 24h | Added this scan |`,
    `| --- | --- | --- |`,
    `| ${mentions.length} | ${last24h} | ${added} |`,
    "",
  ];

  if (sourceErrors.length > 0) {
    lines.push("> ⚠️ Source errors this scan:", "");
    sourceErrors.forEach(e => lines.push(`> - ${mdEscape(e).slice(0, 200)}`));
    lines.push("");
  }

  for (const [type, label] of Object.entries(SOURCE_LABELS)) {
    const group = mentions.filter(m => m.sourceType === type);
    lines.push(`## ${label} (${group.length})`, "");
    if (group.length === 0) {
      const note =
        type === "twitter"
          ? "_No mentions captured. (This source needs a TWITTER_BEARER_TOKEN repo secret — X has no free API.)_"
          : type === "reddit"
            ? "_No mentions captured. (Reddit blocks GitHub-runner IPs; needs authenticated API credentials.)_"
            : "_No mentions captured yet._";
      lines.push(note, "");
      continue;
    }
    lines.push("| Published | Source | Mention | Keywords |", "| --- | --- | --- | --- |");
    for (const m of group.slice(0, 100)) {
      const date = m.publishedAt ? m.publishedAt.slice(0, 16).replace("T", " ") : "—";
      const title = mdEscape(m.title).slice(0, 140) || "(untitled)";
      lines.push(`| ${date} | ${mdEscape(m.sourceName)} | [${title}](${m.url}) | ${m.matchedKeywords.join(", ")} |`);
    }
    if (group.length > 100) lines.push("", `_…and ${group.length - 100} older mentions (see mentions.json)._`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  let existing: Mention[] = [];
  try {
    existing = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Mention[];
  } catch {
    // first run — no state yet
  }
  const known = new Set(existing.map(m => m.url));

  const sourceErrors: string[] = [];
  const [news, youtube, reddit, twitter] = await Promise.all([
    fetchGoogleNews(sourceErrors),
    fetchYouTube(sourceErrors),
    fetchReddit(sourceErrors),
    fetchTwitter(sourceErrors),
  ]);
  const all = [...news, ...youtube, ...reddit, ...twitter].filter(m => m.url);

  const byUrl = new Map<string, Mention>();
  for (const m of all) if (!byUrl.has(m.url)) byUrl.set(m.url, m);
  const added = Array.from(byUrl.values()).filter(m => !known.has(m.url));

  const merged = [...added, ...existing]
    .sort((a, b) => (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt))
    .slice(0, MAX_STORED);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2));
  fs.writeFileSync(REPORT_FILE, buildReport(merged, added.length, sourceErrors));

  console.log(`fetched=${all.length} new=${added.length} total=${merged.length} sourceErrors=${sourceErrors.length}`);
  sourceErrors.forEach(e => console.log(`  ! ${e}`));
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
