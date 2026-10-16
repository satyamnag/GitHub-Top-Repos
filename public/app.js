/* GitHub Top 1000 dashboard — client logic (no dependencies). */

const state = {
  dataset: 'all-time',  // active dataset key
  meta: null,           // active snapshot metadata
  datasets: [],         // available datasets from /api/datasets
  all: [],              // full snapshot items
  view: [],             // sorted items
  filtered: [],         // filtered before pagination
  page: 1,
  pageSize: 50,
  sortKey: 'stars',
  sortDir: 'desc',
  query: '',
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat('en-US');

function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function relTime(iso) {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 0) return 'today';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const y = Math.floor(days / 365);
  return `${y}y ago`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Stable, readable color per language — hashed into a fixed hue set. */
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219',
  Go: '#00ADD8', Rust: '#dea584', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600',
  Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF', Shell: '#89e051',
  HTML: '#e34c26', CSS: '#563d7c', Dart: '#00B4AB', Vue: '#41b883', Lua: '#000080',
  Zig: '#ec915c', Haskell: '#5e5086', Elixir: '#6e4a7e', Scala: '#c22d40',
  Jupyter: '#DA5B0B', 'Jupyter Notebook': '#DA5B0B', Clojure: '#db5855', Perl: '#0298c3',
  Julia: '#a270ba', R: '#198CE7', OCaml: '#ef7a08', Nix: '#7e7eff', Svelte: '#ff3e00',
  MDX: '#fcb32c', 'Objective-C': '#438eff', Assembly: '#6E4C13', Solidity: '#AA6746',
};

function langColor(lang) {
  if (!lang) return '#8b949e';
  if (LANG_COLORS[lang]) return LANG_COLORS[lang];
  let h = 0;
  for (let i = 0; i < lang.length; i++) h = (h * 31 + lang.charCodeAt(i)) % 360;
  return `hsl(${h} 60% 62%)`;
}

// ---------------------------------------------------------------- data load

/** Loads dataset metadata and enables/disables the filter buttons accordingly. */
async function loadDatasets() {
  const res = await fetch('/api/datasets');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.datasets = data.datasets || [];

  for (const btn of document.querySelectorAll('.filter')) {
    const meta = state.datasets.find((d) => d.key === btn.dataset.dataset);
    if (!meta) continue;
    btn.disabled = !meta.available;
    btn.title = meta.available
      ? `${meta.description}\nQuery: ${meta.query}`
      : `Snapshot not built yet — run: node fetch.js --dataset ${meta.key}`;
    if (!meta.available) btn.querySelector('.filter-sub').textContent = 'snapshot not built';
  }
}

async function loadDataset(key) {
  const res = await fetch(`/api/repos?dataset=${encodeURIComponent(key)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  state.dataset = data.dataset || key;
  state.meta = data;
  state.all = data.items || [];

  // Reflect the active dataset in the tab styling.
  for (const btn of document.querySelectorAll('.filter')) {
    const on = btn.dataset.dataset === state.dataset;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }

  $('meta-badge').textContent = `${nf.format(data.count)} repos · ${new Date(data.generated_at).toLocaleString()}`;
  $('subtitle').textContent = data.description || '';
  renderNote();
  renderStats();
  applyFilters();
}

/**
 * Discloses exactly what the active dataset measures. The weekly dataset is
 * deliberately explicit that it is NOT a stars-gained-this-week metric.
 */
function renderNote() {
  const meta = state.meta;
  const el = $('note');
  if (!meta) { el.hidden = true; return; }

  // Older snapshots predate the metric fields, so fall back to the
  // dataset metadata from /api/datasets.
  const info = state.datasets.find((d) => d.key === state.dataset) || {};
  const metric = meta.metric || info.metric || 'Total stars';
  const metricNote = meta.metric_note
    || (state.dataset === 'weekly' ? 'Active = commits pushed within the last 7 days.' : '');
  const query = meta.query || info.query || '';

  const rows = [
    `<div><strong>Metric:</strong> ${esc(metric)}${metricNote ? ' — ' + esc(metricNote) : ''}</div>`,
  ];
  if (query) rows.push(`<div><strong>Query:</strong> <code>${esc(query)}</code></div>`);
  if (meta.reported_total_count) {
    rows.push(`<div><strong>Matching repos on GitHub:</strong> ${nf.format(meta.reported_total_count)} — showing the top ${nf.format(meta.count)}.</div>`);
  }
  const caveats = (meta.caveats && meta.caveats.length) ? meta.caveats : (info.caveats || []);
  if (caveats.length) {
    rows.push(`<ul>${caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`);
  }

  el.innerHTML = rows.join('');
  el.hidden = false;
}

function renderStats() {
  const all = state.all;
  if (!all.length) return;

  const totalStars = all.reduce((s, r) => s + r.stars, 0);
  const totalForks = all.reduce((s, r) => s + r.forks, 0);
  const langs = new Map();
  for (const r of all) {
    const k = r.language || 'Unknown';
    langs.set(k, (langs.get(k) || 0) + 1);
  }
  const topLang = [...langs.entries()].sort((a, b) => b[1] - a[1])[0];

  // Star figure is labelled by dataset so "Total stars" is never mistaken
  // for stars gained within the window.
  const starLabel = state.dataset === 'weekly' ? 'Total stars (all-time)' : 'Total stars';

  const cards = [
    ['Repositories', nf.format(all.length)],
    ['Top repo', all[0].full_name, 'small'],
    [starLabel, compact(totalStars)],
    ['Total forks', compact(totalForks)],
    ['Most common language', `${topLang[0]} (${topLang[1]})`, 'small'],
    ['Star range', `${compact(all[all.length - 1].stars)} – ${compact(all[0].stars)}`],
  ];

  $('stats').innerHTML = cards.map(([label, value, cls]) =>
    `<div class="stat"><div class="label">${esc(label)}</div>
     <div class="value ${cls || ''}" title="${esc(value)}">${esc(value)}</div></div>`).join('');
}

// ---------------------------------------------------------------- filter + sort

function applyFilters() {
  const q = state.query.trim().toLowerCase();
  state.filtered = !q ? state.all : state.all.filter((r) =>
    (r.full_name || '').toLowerCase().includes(q) ||
    (r.description || '').toLowerCase().includes(q) ||
    (r.language || '').toLowerCase().includes(q) ||
    (r.topics || []).some((t) => t.toLowerCase().includes(q))
  );
  state.page = 1;
  sortAndRender();
}

function sortAndRender() {
  const { sortKey, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;

  state.view = [...state.filtered].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === 'full_name') {
      av = String(av || '').toLowerCase();
      bv = String(bv || '').toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    if (sortKey === 'language') {
      av = av || '\uffff'; // push nulls last
      bv = bv || '\uffff';
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    if (sortKey === 'pushed_at') {
      return (new Date(av || 0) - new Date(bv || 0)) * dir;
    }
    return ((av || 0) - (bv || 0)) * dir;
  });

  render();
}

// ---------------------------------------------------------------- render

function render() {
  const total = state.view.length;
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pageCount) state.page = pageCount;

  const start = (state.page - 1) * state.pageSize;
  const rows = state.view.slice(start, start + state.pageSize);

  $('tbody').innerHTML = rows.map((r) => {
    const tags = [
      r.archived ? '<span class="tag">archived</span>' : '',
      r.fork ? '<span class="tag">fork</span>' : '',
    ].join('');
    return `<tr data-url="${esc(r.html_url)}">
      <td class="num rank">${r.rank}</td>
      <td>
        <div class="repo">
          <img src="${esc(r.owner_avatar || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div style="min-width:0">
            <div><span class="owner">${esc(r.owner)}/</span><span class="name">${esc(r.name)}</span>${tags}</div>
            <div class="desc" title="${esc(r.description || '')}">${esc(r.description || 'No description')}</div>
          </div>
        </div>
      </td>
      <td>${r.language
        ? `<span class="lang"><span class="dot" style="background:${langColor(r.language)}"></span>${esc(r.language)}</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="num stars" title="${nf.format(r.stars)}">${nf.format(r.stars)}</td>
      <td class="num" title="${nf.format(r.forks)}">${nf.format(r.forks)}</td>
      <td class="num muted" title="${nf.format(r.open_issues)}">${nf.format(r.open_issues)}</td>
      <td class="num muted" title="${esc(r.pushed_at || '')}">${relTime(r.pushed_at)}</td>
    </tr>`;
  }).join('');

  $('empty').hidden = total !== 0;
  $('page-info').textContent = total === 0
    ? 'No results'
    : `${nf.format(start + 1)}–${nf.format(Math.min(start + state.pageSize, total))} of ${nf.format(total)}`;
  $('prev').disabled = state.page <= 1;
  $('next').disabled = state.page >= pageCount;
}

// ---------------------------------------------------------------- events

function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 6000);
}

/** Syncs the header arrow markers with the current sort state. */
function setSortIndicator(key, dir) {
  document.querySelectorAll('th.sortable').forEach((o) => o.removeAttribute('data-dir'));
  const th = document.querySelector(`th[data-key="${key}"]`);
  if (th) th.setAttribute('data-dir', dir);
}

function bind() {
  // Keep the sticky table header aligned to the real topbar height
  // (it wraps on narrow screens, so measure instead of hard-coding).
  const topbar = document.querySelector('.topbar');
  const syncTopbar = () =>
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  syncTopbar();
  window.addEventListener('resize', syncTopbar);

  // Column sorting.
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        // Numeric/date columns feel natural descending-first; text ascending-first.
        state.sortDir = th.dataset.type === 'text' ? 'asc' : 'desc';
      }
      document.querySelectorAll('th.sortable').forEach((o) => o.removeAttribute('data-dir'));
      setSortIndicator(state.sortKey, state.sortDir);
      sortAndRender();
    });
  });
  setSortIndicator('stars', 'desc');

  // Filter (debounced).
  let t;
  $('search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.query = e.target.value;
      applyFilters();
    }, 120);
  });

  // Focus filter with "/".
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('search')) {
      e.preventDefault();
      $('search').focus();
    }
    if (e.key === 'Escape' && document.activeElement === $('search')) {
      $('search').value = '';
      state.query = '';
      applyFilters();
    }
  });

  $('page-size').addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value);
    state.page = 1;
    render();
  });

  $('prev').addEventListener('click', () => { state.page--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('next').addEventListener('click', () => { state.page++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // Row click opens the repo.
  $('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-url]');
    if (tr) window.open(tr.dataset.url, '_blank', 'noopener');
  });

  // Dataset filters.
  for (const btn of document.querySelectorAll('.filter')) {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.dataset;
      if (key === state.dataset || btn.disabled) return;
      const label = btn.querySelector('.filter-title').textContent;
      toast(`Loading ${label}…`);
      try {
        // Reset view state so a filter/sort from the previous dataset
        // cannot leak into the new one.
        state.query = '';
        state.page = 1;
        state.sortKey = 'stars';
        state.sortDir = 'desc';
        $('search').value = '';
        await loadDataset(key);
        setSortIndicator('stars', 'desc');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast(`${label}: ${nf.format(state.all.length)} repositories.`);
      } catch (err) {
        toast(`Could not load ${label}: ${err.message}`, true);
      }
    });
  }

  // Refresh the ACTIVE dataset from GitHub.
  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    const key = state.dataset;
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    toast(`Re-crawling "${key}" from GitHub — this takes about a minute.`);
    try {
      const res = await fetch(`/api/repos?dataset=${encodeURIComponent(key)}&refresh=1`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadDatasets();
      await loadDataset(key);
      toast(`Refreshed ${key}: ${nf.format(data.count)} repositories.`);
    } catch (err) {
      toast(`Refresh failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh from GitHub';
    }
  });
}

bind();

loadDatasets()
  .then(() => loadDataset('all-time'))
  .catch((err) => {
    $('meta-badge').textContent = 'unavailable';
    toast(`Could not load data: ${err.message}`, true);
  });
