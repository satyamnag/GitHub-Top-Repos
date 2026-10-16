#!/usr/bin/env node
/**
 * Zero-dependency server for the GitHub Top 1000 dashboard.
 *
 * Routes:
 *   GET /                    -> static UI from ./public
 *   GET /api/datasets        -> metadata for the available datasets
 *   GET /api/repos           -> cached snapshot (default dataset)
 *   GET /api/repos?dataset=weekly[&refresh=1]
 *                            -> snapshot for a named dataset, optionally re-crawled
 *   GET /api/status          -> snapshot metadata + GitHub rate-limit state
 *
 * Uses only Node's built-in http/fs (Node 18+ for global fetch).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- datasets

/**
 * Allow-list of servable datasets. Only these fixed keys can ever be read from
 * disk, so a request value is never used to build a filesystem path.
 */
const DATASETS = {
  'all-time': {
    key: 'all-time',
    label: 'All-time top 2500',
    description: 'The 2,500 most-starred repositories on GitHub.',
    metric: 'Total stars',
    file: path.join(ROOT, 'data', 'repos.json'),
  },
  weekly: {
    key: 'weekly',
    label: 'Weekly trending 2500',
    description: 'The 2,500 most-starred repositories with commits pushed in the last 7 days.',
    metric: 'Total stars (active this week)',
    file: path.join(ROOT, 'data', 'trending.json'),
  },
};

const DEFAULT_DATASET = 'all-time';

/** Resolves a requested dataset key, falling back to the default. */
function resolveDataset(key) {
  if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(DATASETS, key)) {
    return DATASETS[key];
  }
  return null;
}

// ---------------------------------------------------------------- snapshot cache

const cache = new Map();   // dataset key -> { data, mtimeMs }
const refreshing = new Map(); // dataset key -> in-flight refresh promise

/** Reads a dataset snapshot, reusing the parsed copy while its mtime is unchanged. */
function readSnapshot(dsKey = DEFAULT_DATASET) {
  const ds = resolveDataset(dsKey);
  if (!ds) return null;
  try {
    const stat = fs.statSync(ds.file);
    const hit = cache.get(ds.key);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data; // unchanged on disk
    const data = JSON.parse(fs.readFileSync(ds.file, 'utf8'));
    cache.set(ds.key, { data, mtimeMs: stat.mtimeMs });
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Runs fetch.js as a child process so the crawl logic lives in exactly one place. */
function runFetch(dsKey) {
  const ds = resolveDataset(dsKey);
  if (!ds) return Promise.reject(new Error(`unknown dataset "${dsKey}"`));
  if (refreshing.has(ds.key)) return refreshing.get(ds.key);

  const promise = new Promise((resolve, reject) => {
    console.log(`[refresh] starting GitHub crawl for "${ds.key}"...`);
    const child = spawn(process.execPath, [path.join(ROOT, 'fetch.js'), '--dataset', ds.key], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      refreshing.delete(ds.key);
      cache.delete(ds.key); // force re-read from disk
      if (code === 0) {
        console.log(`[refresh] done: ${ds.key}`);
        resolve(readSnapshot(ds.key));
      } else {
        reject(new Error(out.trim().split('\n').slice(-3).join(' ') || `fetch.js exited ${code}`));
      }
    });
  });

  refreshing.set(ds.key, promise);
  return promise;
}

async function githubRateLimit() {
  try {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: {
        'User-Agent': 'github-top1000-dashboard',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const s = data.resources && data.resources.search;
    return s ? { limit: s.limit, remaining: s.remaining, reset: s.reset } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- http helpers

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // Prevent path traversal outside public/.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // Metadata for the dataset switcher. Reports availability per dataset so the
    // UI can disable a filter whose snapshot has not been built yet.
    if (url.pathname === '/api/datasets') {
      return sendJson(res, 200, {
        default: DEFAULT_DATASET,
        datasets: Object.values(DATASETS).map((ds) => {
          const snap = readSnapshot(ds.key);
          return {
            key: ds.key,
            label: ds.label,
            description: ds.description,
            metric: ds.metric,
            available: !!snap,
            count: snap ? snap.count : 0,
            generated_at: snap ? snap.generated_at : null,
            query: snap ? snap.query : null,
            caveats: snap ? snap.caveats || [] : [],
            window_days: snap ? snap.window_days || null : null,
          };
        }),
      });
    }

    if (url.pathname === '/api/repos') {
      const requested = url.searchParams.get('dataset') || DEFAULT_DATASET;
      const ds = resolveDataset(requested);
      if (!ds) {
        return sendJson(res, 400, {
          error: `unknown dataset "${requested}"`,
          valid: Object.keys(DATASETS),
        });
      }

      const wantRefresh = url.searchParams.get('refresh') === '1';
      if (wantRefresh) {
        const usersToken = req.headers['x-github-token'];
        if (usersToken && !process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = String(usersToken);
        await runFetch(ds.key);
      }

      const snapshot = readSnapshot(ds.key);
      if (!snapshot) {
        return sendJson(res, 503, {
          error: `No snapshot for "${ds.key}" yet. Run \`node fetch.js --dataset ${ds.key}\`.`,
        });
      }
      return sendJson(res, 200, snapshot);
    }

    if (url.pathname === '/api/status') {
      const snapshot = readSnapshot(DEFAULT_DATASET);
      return sendJson(res, 200, {
        has_snapshot: !!snapshot,
        generated_at: snapshot ? snapshot.generated_at : null,
        count: snapshot ? snapshot.count : 0,
        reported_total_count: snapshot ? snapshot.reported_total_count : 0,
        refreshing: [...refreshing.keys()],
        authenticated: !!process.env.GITHUB_TOKEN,
        datasets: Object.values(DATASETS).map((ds) => {
          const snap = readSnapshot(ds.key);
          return {
            key: ds.key,
            available: !!snap,
            count: snap ? snap.count : 0,
            generated_at: snap ? snap.generated_at : null,
          };
        }),
        rate_limit: await githubRateLimit(),
      });
    }

    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint' });

    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[error]', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GitHub Top 1000 dashboard -> http://${HOST}:${PORT}`);
  for (const ds of Object.values(DATASETS)) {
    const snap = readSnapshot(ds.key);
    console.log(snap
      ? `  [${ds.key}] ${snap.count} repos from ${snap.generated_at}`
      : `  [${ds.key}] no snapshot — run \`node fetch.js --dataset ${ds.key}\``);
  }
});
