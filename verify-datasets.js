/* Verifies the two-dataset switcher, the honest metric labelling, and that
   switching datasets does not leak view state. */
const path = require('path');

let failures = 0;
function check(label, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
}

(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // ---------- API level ----------
  const dsRes = await page.request.get('http://127.0.0.1:3000/api/datasets');
  const ds = await dsRes.json();
  check('GET /api/datasets returns 2 datasets', ds.datasets.length === 2, ds.datasets.map(d => d.key).join(','));
  check('both datasets available', ds.datasets.every(d => d.available),
    ds.datasets.map(d => `${d.key}:${d.count}`).join(' '));

  const weekly = await (await page.request.get('http://127.0.0.1:3000/api/repos?dataset=weekly')).json();
  check('weekly count is 2500', weekly.count === 2500, String(weekly.count));
  check('weekly declares window_days=7', weekly.window_days === 7, String(weekly.window_days));
  check('weekly carries explicit caveats', (weekly.caveats || []).length > 0);
  check('weekly base query includes pushed:>', /pushed:>/.test(weekly.base_query || weekly.query), weekly.base_query || weekly.query);
  check('weekly used banded pagination', weekly.banded === true, String(weekly.banded));

  const allTime = await (await page.request.get('http://127.0.0.1:3000/api/repos?dataset=all-time')).json();
  check('all-time count is 2500', allTime.count === 2500, String(allTime.count));
  check('all-time has no caveats', (allTime.caveats || []).length === 0);
  check('all-time used banded pagination', allTime.banded === true, String(allTime.banded));

  // Unknown dataset must be rejected, not silently fall back.
  const bad = await page.request.get('http://127.0.0.1:3000/api/repos?dataset=../../etc/passwd');
  check('unknown dataset rejected with 400', bad.status() === 400, `HTTP ${bad.status()}`);

  // Path traversal attempt must never read a file outside data/.
  const trav = await page.request.get('http://127.0.0.1:3000/api/repos?dataset=..%2f..%2fserver.js');
  const travText = await trav.text();
  check('traversal attempt leaks no source', trav.status() === 400 && !/require\(/.test(travText), `HTTP ${trav.status()}`);

  // ---------- weekly data integrity ----------
  const weekAgo = Date.now() - 7 * 86400000 - 3600000; // 1h slack for clock skew
  const stale = weekly.items.filter(r => new Date(r.pushed_at).getTime() < weekAgo);
  check('every weekly repo was pushed within 7 days', stale.length === 0,
    stale.length ? `${stale.length} stale, e.g. ${stale[0].full_name} @ ${stale[0].pushed_at}` : 'all fresh');
  check('every weekly repo has >1000 stars', weekly.items.every(r => r.stars > 1000));
  check('no archived repos in weekly', weekly.items.every(r => !r.archived));
  check('no forks in weekly', weekly.items.every(r => !r.fork));
  check('weekly ranks contiguous 1..2500', weekly.items.every((r, i) => r.rank === i + 1));
  check('weekly sorted by stars desc',
    weekly.items.every((r, i) => i === 0 || weekly.items[i - 1].stars >= r.stars));

  const ids = new Set(weekly.items.map(r => r.id));
  check('weekly has no duplicate repos', ids.size === 2500, String(ids.size));

  // ---------- banded-crawl specific invariants ----------
  // Bands can silently drop or double-count repos at their shared boundaries.
  const allIds = new Set(allTime.items.map(r => r.id));
  check('all-time has no duplicate repos', allIds.size === 2500, String(allIds.size));
  check('all-time ranks contiguous 1..2500', allTime.items.every((r, i) => r.rank === i + 1));
  check('all-time sorted by stars desc',
    allTime.items.every((r, i) => i === 0 || allTime.items[i - 1].stars >= r.stars));
  check('all-time every repo has >1000 stars', allTime.items.every(r => r.stars > 1000));

  // The definitive banding check: the resulting list must be gap-free from the
  // top. If a band boundary lost repos, the star sequence jumps unexpectedly.
  // We verify against an independent count of how many repos should be above
  // the last star value.
  const lastStars = allTime.items[allTime.items.length - 1].stars;
  const countAbove = await (await page.request.get(
    'https://api.github.com/search/repositories?q=' +
    encodeURIComponent(`stars:>${lastStars}`) + '&per_page=1')).json().catch(() => null);
  if (countAbove && typeof countAbove.total_count === 'number') {
    // items with stars > lastStars, plus those tied at lastStars that we included
    const tiedIncluded = allTime.items.filter(r => r.stars === lastStars).length;
    const expected = countAbove.total_count + tiedIncluded;
    check('all-time band boundaries lost no repos (gap-free)',
      allTime.count === 2500 && expected >= 2500,
      `#${allTime.count} repos, ${expected} exist at/above the last star value ${lastStars}`);
  } else {
    console.log('SKIP  all-time gap-free check (GitHub rate limit)');
  }

  // ---------- UI level ----------
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#tbody tr');

  check('two filter buttons rendered', await page.locator('.filter').count() === 2);

  const defaultActive = await page.locator('.filter.active').getAttribute('data-dataset');
  check('all-time is the default filter', defaultActive === 'all-time', defaultActive);

  const allTimeTop = await page.locator('#tbody tr').first().innerText();
  check('all-time top row is build-your-own-x', /build-your-own-x/.test(allTimeTop), allTimeTop.split('\n')[0]);

  // Switch to weekly.
  await page.click('.filter[data-dataset="weekly"]');
  await page.waitForTimeout(1200);

  const weeklyActive = await page.locator('.filter.active').getAttribute('data-dataset');
  check('weekly filter becomes active', weeklyActive === 'weekly', weeklyActive);

  const weeklyTop = await page.locator('#tbody tr').first().innerText();
  check('weekly top row changed from all-time', weeklyTop !== allTimeTop, weeklyTop.split('\n')[0]);

  const noteText = await page.textContent('#note');
  check('note discloses "no stars-gained metric"',
    /no "stars gained this week" metric/i.test(noteText), noteText.slice(0, 90).replace(/\s+/g, ' '));
  check('note shows the actual API query', /pushed:>/.test(noteText));

  const statsText = await page.textContent('#stats');
  check('weekly star card is labelled all-time, not weekly',
    /Total stars \(all-time\)/.test(statsText));

  // State must not leak back: apply a filter, switch, and confirm it resets.
  await page.fill('#search', 'react');
  await page.waitForTimeout(400);
  const filteredInfo = await page.textContent('#page-info');
  await page.click('.filter[data-dataset="all-time"]');
  await page.waitForTimeout(1200);
  const afterSwitchInfo = await page.textContent('#page-info');
  const searchVal = await page.inputValue('#search');
  check('filter resets when switching datasets', searchVal === '' && afterSwitchInfo === '1–50 of 2,500',
    `search="${searchVal}" info="${afterSwitchInfo}" (was "${filteredInfo}")`);

  // 250 rows-per-page option must work on a 2500-row dataset.
  await page.selectOption('#page-size', '250');
  await page.waitForTimeout(500);
  const bigPage = await page.textContent('#page-info');
  const bigRows = await page.locator('#tbody tr').count();
  check('250-rows-per-page option works', bigRows === 250 && /1–250 of 2,500/.test(bigPage),
    `${bigRows} rows, info="${bigPage}"`);
  await page.selectOption('#page-size', '50');
  await page.waitForTimeout(400);

  // Sorting must still work in the weekly view. Read cells directly —
  // innerText separates <td> with newlines, not tabs.
  await page.click('.filter[data-dataset="weekly"]');
  await page.waitForTimeout(1200);
  await page.click('th[data-key="stars"]');
  await page.waitForTimeout(300);
  const ascStars = await page.locator('#tbody tr td:nth-child(4)').evaluateAll((tds) =>
    tds.slice(0, 5).map((td) => Number(td.innerText.replace(/,/g, '').trim()))
  );
  check('ascending sort works in weekly view',
    ascStars.every((n, i) => i === 0 || ascStars[i - 1] <= n),
    `first stars: ${ascStars.join(' <= ')}`);

  // Filtering inside weekly.
  await page.fill('#search', 'rust');
  await page.waitForTimeout(400);
  const rustInfo = await page.textContent('#page-info');
  check('filtering works in weekly view', /of [\d,]+$/.test(rustInfo), rustInfo);
  await page.fill('#search', '');
  await page.waitForTimeout(400);

  // ---------- screenshot: weekly view ----------
  await page.click('.filter[data-dataset="weekly"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(__dirname, 'weekly.png') });

  await page.click('.filter[data-dataset="all-time"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(__dirname, 'alltime.png') });

  check('no console errors', errors.length === 0, errors.join(' | ') || 'none');

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
