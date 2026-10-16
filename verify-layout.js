/* Focused check of sticky-header behaviour and the layout var. */
const path = require('path');

(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#tbody tr');

  const info = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar');
    const th = document.querySelector('thead th');
    return {
      topbarHeight: topbar.offsetHeight,
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
      thTop: getComputedStyle(th).top,
    };
  });
  console.log('topbar height :', info.topbarHeight);
  console.log('--topbar-h    :', JSON.stringify(info.cssVar));
  console.log('th sticky top :', info.thTop);

  // Before scrolling: is row 1 fully below the sticky header?
  const before = await page.evaluate(() => {
    const th = document.querySelector('thead th').getBoundingClientRect();
    const row1 = document.querySelector('#tbody tr').getBoundingClientRect();
    const cell = document.querySelector('#tbody tr td:nth-child(4)');
    return {
      headerBottom: Math.round(th.bottom),
      row1Top: Math.round(row1.top),
      row1Height: Math.round(row1.height),
      starsText: cell.innerText,
      starsClipped: cell.scrollWidth > cell.clientWidth + 1,
    };
  });
  console.log('header bottom :', before.headerBottom, '| row1 top:', before.row1Top, '| height:', before.row1Height);
  console.log('row1 stars    :', before.starsText, '| clipped:', before.starsClipped);
  console.log('row1 clear of header:', before.row1Top >= before.headerBottom - 1);

  // Scroll the table's own scrollport and confirm the header stays pinned.
  await page.evaluate(() => { document.querySelector('#table').scrollTop = 1200; });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const table = document.querySelector('#table');
    const th = document.querySelector('thead th').getBoundingClientRect();
    const tr = document.querySelector('tbody tr').getBoundingClientRect();
    const tableBox = table.getBoundingClientRect();
    return {
      scrollTop: table.scrollTop,
      headerTop: Math.round(th.top),
      tableTop: Math.round(tableBox.top),
      firstRowTop: Math.round(tr.top),
      firstRowBottom: Math.round(tr.bottom),
    };
  });
  console.log('\nafter table scroll -> scrollTop:', after.scrollTop);
  console.log('  header top :', after.headerTop, '| table top:', after.tableTop);
  console.log('  header pinned at table top:', Math.abs(after.headerTop - after.tableTop) <= 1);
  console.log('  first visible row starts below header:', after.firstRowTop >= after.headerTop);

  await page.evaluate(() => { document.querySelector('#table').scrollTop = 0; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'scrolled.png') });

  // Narrow viewport: table scrolls horizontally instead of clipping columns.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(300);
  const narrow = await page.evaluate(() => ({
    cssVar: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
    scrollable: (() => { const t = document.querySelector('#table'); return t.scrollWidth > t.clientWidth; })(),
  }));
  console.log('narrow viewport -> --topbar-h:', narrow.cssVar, '| table scrolls horizontally:', narrow.scrollable);
  await page.screenshot({ path: path.join(__dirname, 'narrow.png') });

  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
