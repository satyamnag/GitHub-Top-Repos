#!/usr/bin/env node
/**
 * Builds repository snapshots from GET /search/repositories
 * (see https://skmtc.dev/github/apis/rest/docs/search/repositories/get).
 *
 * Two datasets are supported, each 2500 repositories deep:
 *   all-time : the 2500 most-starred repositories on GitHub
 *   weekly   : the 2500 most-starred repositories with commits pushed in the
 *              last 7 days ("actively developed this week")
 *
 * ── Why star-band pagination is required ────────────────────────────────────
 * GitHub's search API hard-caps *every* query at 1000 results: page 11 returns
 * HTTP 422 regardless of total_count. So a single query can never yield 2500.
 *
 * To reach a contiguous top-N we split the result space into star bands, each
 * holding <= 1000 repositories, and page inside each band. Bands are chosen by
 * star value and stitched in descending star order, giving the same list a
 * single unbounded query would have produced.
 *
 * ── What "weekly" does and does not mean ────────────────────────────────────
 * GitHub's REST API has NO trending endpoint and does NOT expose "stars gained
 * in a period". The weekly dataset measures RECENT ACTIVITY (pushed_at within
 * 7 days), ranked by TOTAL stars. It is not a weekly star-velocity measure.
 *
 * Usage:  node fetch.js [--dataset all-time|weekly|both] [--depth 2500] [--pages N]
 * Token:  set GITHUB_TOKEN to raise the search limit from 10 to 30 req/min.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.github.com/search/repositories';
const PER_PAGE = 100;
const SEARCH_CAP = 1000; // GitHub never returns more than this per query.

/** Days of recent activity that define the "weekly" dataset. */
const RECENT_DAYS = 7;

/** Requests/second budget. Unauthenticated search allows 10/min -> ~6.5s apart. */
function paceMs() {
  return process.env.GITHUB_TOKEN ? 2200 : 6500;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function buildDatasets(now = new Date()) {
  const since = new Date(now.getTime() - RECENT_DAYS * 86400000);

  return {
    'all-time': {
      key: 'all-time',
      label: 'All-time top 2500',
      short_label: 'All-time',
      description: 'The 2,500 most-starred repositories on GitHub.',
      metric: 'Total stars',
      metric_note: "Ranked by total stars accumulated over the repository's lifetime.",
      // No stars qualifier here — the band supplies it. Appending a second
      // `stars:` qualifier makes GitHub ignore one of them.
      base: '',
      minStars: 1000,
      out: path.join(__dirname, 'data', 'repos.json'),
      caveats: [],
    },

    weekly: {
      key: 'weekly',
      label: 'Weekly trending 2500',
      short_label: 'Weekly',
      description:
        'The 2,500 most-starred repositories with commits pushed in the last 7 days.',
      metric: 'Total stars (active this week)',
      metric_note: 'Active = commits pushed within the last 7 days.',
      base: `pushed:>${ymd(since)} archived:false fork:false`,
      minStars: 1000,
      out: path.join(__dirname, 'data', 'trending.json'),
      since: since.toISOString(),
      window_days: RECENT_DAYS,
      caveats: [
        'GitHub exposes no "stars gained this week" metric. This list ranks by TOTAL stars among repositories that received commits in the last 7 days — it measures recent activity, not weekly star growth.',
        'Repositories that gained many stars this week but had no commits are excluded.',
      ],
    },
  };
}

function parseArgs(argv) {
  const args = { dataset: 'all-time', depth: 2500, pages: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--depth') args.depth = Math.max(1, Number(argv[++i]) || 2500);
    else if (argv[i] === '--pages') args.pages = Math.min(Number(argv[++i]) || 10, 10);
    else if (argv[i] === '--dataset') args.dataset = String(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-top1000-dashboard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

const searchUrl = (q, page) =>
  `${API}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`;

/**
 * Joins query parts, dropping empty ones.
 *
 * IMPORTANT: never emit two `stars:` qualifiers — GitHub silently ignores one
 * of them, which would make a banded query return the whole result set.
 */
function buildQuery(...parts) {
  const kept = parts.filter((p) => p && String(p).trim()).map((p) => String(p).trim());
  const starsCount = kept.filter((p) => /(^|\s)stars:/.test(p)).length;
  if (starsCount > 1) throw new Error(`duplicate stars: qualifier in "${kept.join(' ')}"`);
  return kept.join(' ');
}

/** Maps a non-OK search response to a typed error so callers can react. */
class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}${body ? ' ' + body.slice(0, 160) : ''}`);
    this.status = status;
  }
}

/** One search request with retry/backoff. `accept422` returns null instead of throwing. */
async function request(q, page = 1, { accept422 = false, attempt = 1 } = {}) {
  let res;
  try {
    res = await fetch(searchUrl(q, page), { headers: headers() });
  } catch (err) {
    // Network-level failure (DNS, reset, timeout). Long crawls must survive these.
    if (attempt <= 6) {
      const waitMs = Math.min(3000 * 2 ** (attempt - 1), 60000);
      console.log(`    network error (${err.message}) — retrying in ${Math.round(waitMs / 1000)}s (${attempt}/6)`);
      await sleep(waitMs);
      return request(q, page, { accept422, attempt: attempt + 1 });
    }
    throw err;
  }

  if (res.ok) return res.json();
  if (res.status === 422 && accept422) return null;

  const body = await res.text().catch(() => '');
  const rateLimited = res.status === 403 || res.status === 429;
  if ((rateLimited || res.status >= 500) && attempt <= 6) {
    let waitMs = Math.min(3000 * 2 ** (attempt - 1), 90000);
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (rateLimited && reset) waitMs = Math.max(reset * 1000 - Date.now() + 2000, 3000);
    console.log(`    HTTP ${res.status} — waiting ${Math.round(waitMs / 1000)}s (retry ${attempt}/6)`);
    await sleep(waitMs);
    return request(q, page, { accept422, attempt: attempt + 1 });
  }
  throw new ApiError(res.status, body);
}

/** total_count for a query, or null when it exceeds the API's reachable range. */
async function countFor(ds, starsClause) {
  const q = buildQuery(ds.base, `stars:${starsClause}`);
  const data = await request(q, 1, { accept422: true });
  if (!data) return null;
  return data.total_count;
}

/**
 * Finds the star floor for a crawl of `depth` repositories.
 *
 * We want the HIGHEST star value S such that count(stars >= S) >= depth.
 * The head band `stars:>=S` then contains at least `depth` repos, and we take
 * the top `depth` of them. count() decreases monotonically as S grows.
 *
 * Guards:
 *  - result is verified to actually cover `depth`
 *  - refuses to return a value at the search's upper bound (non-convergence)
 */
async function findTopEdge(ds, depth) {
  const MAX_STARS = 900000;

  // Fast path: if the whole query already fits under the 1000 cap, no bands needed.
  const totalAll = await countFor(ds, `>=${ds.minStars}`);
  await sleep(paceMs());
  if (totalAll === null) throw new Error('baseline count returned 422');
  if (totalAll <= SEARCH_CAP) return ds.minStars;

  let lo = ds.minStars;
  let hi = MAX_STARS;
  let edge = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const c = await countFor(ds, `>=${mid}`);
    await sleep(paceMs());

    if (c !== null && c >= depth) {
      edge = mid;      // still covers the depth — try a higher floor
      lo = mid + 1;
    } else {
      hi = mid - 1;    // too few repos — lower the floor
    }
  }

  if (edge === null) {
    // Even stars:>=minStars cannot cover depth; crawl everything available.
    console.log(`    note: only ${totalAll} repos reachable, less than ${depth}`);
    return ds.minStars;
  }
  if (edge >= MAX_STARS) throw new Error(`star floor failed to converge (hit ${MAX_STARS})`);

  const verify = await countFor(ds, `>=${edge}`);
  await sleep(paceMs());
  if (verify === null || verify < depth) {
    throw new Error(`star floor ${edge} covers only ${verify} repos (< ${depth})`);
  }
  return edge;
}

/**
 * Splits [minStars, topEdge) into bands of <=1000 repos each, walking downward.
 * Returns a list of { lower, upper } star ranges in descending order.
 */
async function planBands(ds, topEdge, depth, neededBelow) {
  const bands = [];
  // Head band: everything at or above topEdge.
  const headCount = await countFor(ds, `>=${topEdge}`);
  await sleep(paceMs());
  bands.push({ lower: topEdge, upper: null, declared: headCount });

  let upper = topEdge - 1;
  let remaining = neededBelow;

  while (remaining > 0 && upper >= ds.minStars) {
    // Find the lowest star value such that stars:lo..upper holds <= 1000.
    let lo = ds.minStars;
    let hi = upper;
    let best = null;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const c = await countFor(ds, `${mid}..${upper}`);
      await sleep(paceMs());
      if (c !== null && c <= SEARCH_CAP) { best = { lower: mid, count: c }; lo = mid + 1; }
      else hi = mid - 1;
    }

    if (!best) break;
    bands.push({ lower: best.lower, upper, declared: best.count });
    remaining -= best.count;
    upper = best.lower - 1;
  }

  return bands;
}

/** Keep only the fields the dashboard actually uses, so snapshots stay small. */
function slim(repo, rank) {
  return {
    rank,
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner ? repo.owner.login : null,
    owner_avatar: repo.owner ? repo.owner.avatar_url : null,
    owner_type: repo.owner ? repo.owner.type : null,
    html_url: repo.html_url,
    description: repo.description,
    language: repo.language,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    open_issues: repo.open_issues_count,
    watchers: repo.watchers_count,
    size_kb: repo.size,
    topics: repo.topics || [],
    license: repo.license ? repo.license.spdx_id || repo.license.key : null,
    archived: !!repo.archived,
    fork: !!repo.fork,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
  };
}

/** Pages through one band, returning up to `limit` repos (<=1000 by construction). */
async function crawlBand(ds, band, limit) {
  const clause = band.upper === null ? `>=${band.lower}` : `${band.lower}..${band.upper}`;
  const q = buildQuery(ds.base, `stars:${clause}`);
  const label = band.upper === null ? `stars>=${band.lower}` : `stars:${band.lower}..${band.upper}`;

  const out = [];
  const pages = Math.min(Math.ceil(limit / PER_PAGE), SEARCH_CAP / PER_PAGE);

  for (let page = 1; page <= pages && out.length < limit; page++) {
    const data = await request(q, page, { accept422: true });
    if (!data || !data.items || data.items.length === 0) break;
    out.push(...data.items);
    process.stdout.write(`    ${label} p${page}: +${data.items.length} (${out.length})\n`);
    if (data.items.length < PER_PAGE) break;
    if (out.length < limit) await sleep(paceMs());
  }
  return out;
}

/**
 * Builds a descending list of star bands covering at least `depth` repos.
 *
 * Walking down from the top: for the current `upper` edge we want the LOWEST
 * `lower` such that (lower..upper) still holds <= SEARCH_CAP repos. That is the
 * widest band that can be paged within GitHub's 1000-result cap. Then the next
 * band starts just below it.
 */
async function planBands(ds, topStar, depth) {
  const bands = [];
  let upper = null;        // null = unbounded (top of the star range)
  let covered = 0;
  let guard = 0;

  while (covered < depth && guard++ < 40) {
    const hiEdge = upper === null ? topStar : upper;
    let lo = ds.minStars;
    let hi = hiEdge;
    let best = null;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const clause = upper === null ? `>=${mid}` : `${mid}..${upper}`;
      const c = await countFor(ds, clause);
      await sleep(paceMs());

      if (c !== null && c <= SEARCH_CAP) {
        // Fits the cap at this lower edge; try going LOWER for a wider band.
        best = { lower: mid, count: c };
        hi = mid - 1;
      } else {
        // Too many repos; the band must start higher, so raise the lower edge.
        lo = mid + 1;
      }
    }

    if (!best) {
      // Even the single-star slice at hiEdge exceeds the cap: take the top
      // 1000 paginated pages of it and step down one star value.
      bands.push({ lower: hiEdge, upper: null, count: SEARCH_CAP });
      covered += SEARCH_CAP;
      if (hiEdge <= ds.minStars) break;
      upper = hiEdge - 1;
      continue;
    }

    bands.push({ lower: best.lower, upper, count: best.count });
    covered += best.count;
    if (best.lower <= ds.minStars) break;   // reached the bottom of the range
    upper = best.lower - 1;
  }

  return bands;
}

async function crawl(ds, depth, pageOverride) {
  console.log(`\n[${ds.key}] ${ds.label} (target ${depth})`);
  console.log(`  base query: ${ds.base || '(none)'}`);

  if (pageOverride) {
    // Simple mode: a single query, <=1000 results. Used for smoke tests.
    const q = buildQuery(ds.base, `stars:>=${ds.minStars}`);
    const items = [];
    for (let page = 1; page <= pageOverride; page++) {
      const data = await request(q, page, { accept422: true });
      if (!data || !data.items || data.items.length === 0) break;
      items.push(...data.items);
      console.log(`  page ${page}/${pageOverride}: +${data.items.length}`);
      if (data.items.length < PER_PAGE) break;
      if (page < pageOverride) await sleep(paceMs());
    }
    return finish(ds, items, depth, { total: null, bands: null });
  }

  console.log('  step 1/3: locating the star floor for this depth...');
  const topEdge = await findTopEdge(ds, depth);
  console.log(`    star floor: ${topEdge} (head band starts here)`);

  const headCount = await countFor(ds, `>=${topEdge}`);
  await sleep(paceMs());
  console.log(`  step 2/3: planning star bands (<= ${SEARCH_CAP} repos each)...`);

  // Bands covering the top `depth` repos, each individually pageable.
  const bands = await planBands(ds, topEdge, depth);
  console.log(`    ${bands.length} band(s):`);
  bands.forEach((b) => {
    const label = b.upper === null ? `stars>=${b.lower}` : `stars:${b.lower}..${b.upper}`;
    console.log(`      ${label}  (~${b.count} repos)`);
  });

  console.log('  step 3/3: crawling bands...');
  if (global.__DRY_RUN__) {
    console.log('    [dry run] skipping the actual page crawl');
    const planned = bands.reduce((s, b) => s + b.count, 0);
    console.log(`    bands cover ~${planned} repos (depth ${depth})`);
    return null;
  }
  const items = [];
  for (const band of bands) {
    if (items.length >= depth) break;
    await sleep(paceMs());
    const got = await crawlBand(ds, band, depth - items.length);
    items.push(...got);
  }

  return finish(ds, items, depth, { total: headCount, topEdge, bands });
}

function finish(ds, raw, depth, extra) {
  // Dedupe by id — star counts shift mid-crawl and bands can overlap by one.
  const seen = new Set();
  const unique = [];
  for (const r of raw) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    unique.push(r);
  }

  unique.sort((a, b) => b.stargazers_count - a.stargazers_count);
  const items = unique.slice(0, depth).map((r, i) => slim(r, i + 1));

  const payload = {
    dataset: ds.key,
    label: ds.label,
    description: ds.description,
    metric: ds.metric,
    metric_note: ds.metric_note,
    caveats: ds.caveats,
    window_days: ds.window_days || null,
    since: ds.since || null,
    depth_requested: depth,
    generated_at: new Date().toISOString(),
    source: API,
    query: extra.topEdge
      ? buildQuery(ds.base, `stars:>=${extra.topEdge}`) + '&sort=stars&order=desc'
      : buildQuery(ds.base, `stars:>=${ds.minStars}`) + '&sort=stars&order=desc',
    base_query: ds.base,
    // True when more than one star band was crawled (required above 1000).
    banded: !!(extra.bands && extra.bands.length),
    reported_total_count: extra.total,
    count: items.length,
    items,
  };

  fs.mkdirSync(path.dirname(ds.out), { recursive: true });
  fs.writeFileSync(ds.out, JSON.stringify(payload), 'utf8');

  const mb = (fs.statSync(ds.out).size / 1024 / 1024).toFixed(2);
  console.log(`  wrote ${items.length} repos -> ${ds.out} (${mb} MB)`);
  if (items.length) {
    console.log(`  top:    #1 ${items[0].full_name} (${items[0].stars.toLocaleString()} stars)`);
    const last = items[items.length - 1];
    console.log(`  bottom: #${last.rank} ${last.full_name} (${last.stars.toLocaleString()} stars)`);
  }
  if (items.length < depth) {
    console.log(`  WARNING: reached only ${items.length} of ${depth} requested.`);
  }
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasets = buildDatasets();

  if (!process.env.GITHUB_TOKEN) {
    console.log('(no GITHUB_TOKEN — unauthenticated search allows 10 requests/minute;');
    console.log(` this crawl needs many requests and will take several minutes)`);
  }

  const wanted = args.dataset === 'both' ? ['all-time', 'weekly'] : [args.dataset];
  global.__DRY_RUN__ = args.dryRun;

  for (let i = 0; i < wanted.length; i++) {
    const ds = datasets[wanted[i]];
    if (!ds) throw new Error(`unknown dataset "${wanted[i]}" (use all-time, weekly, or both)`);
    if (args.out && wanted.length === 1) ds.out = args.out;
    const result = await crawl(ds, args.depth, args.pages);
    if (result) ds._lastCount = result.count;
    if (i < wanted.length - 1 && !args.dryRun) {
      console.log('\n  cooling down 25s before the next dataset...');
      await sleep(25000);
    }
  }
}

main().catch((err) => {
  console.error('\nFetch failed:', err.message);
  process.exit(1);
});
