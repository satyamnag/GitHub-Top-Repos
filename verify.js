/* Headless verification of the dashboard: renders the page, exercises
   sorting / filtering / pagination, and screenshots the result. */
const path = require('path');

(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#tbody tr', { timeout: 10000 });

  const badge = await page.textContent('#meta-badge');
  const statCards = await page.locator('.stat').count();
  const firstRow = await page.locator('#tbody tr').first().innerText();
  const rowsOnPage = await page.locator('#tbody tr').count();
  const pageInfo = await page.textContent('#page-info');
  console.log('badge       :', badge);
  console.log('stat cards  :', statCards);
  console.log('rows/page   :', rowsOnPage);
  console.log('page info   :', pageInfo);
  console.log('first row   :', firstRow.replace(/\n/g, ' | '));

  // --- sorting: click Stars header to flip to ascending
  await page.click('th[data-key="stars"]');
  await page.waitForTimeout(200);
  const ascFirst = await page.locator('#tbody tr').first().innerText();
  console.log('after stars asc, first row:', ascFirst.split('\n')[0]);
  await page.click('th[data-key="stars"]'); // back to desc
  await page.waitForTimeout(200);

  // --- sort by a text column
  await page.click('th[data-key="full_name"]');
  await page.waitForTimeout(200);
  console.log('after name asc, first row:', (await page.locator('#tbody tr').first().innerText()).split('\n')[0]);
  await page.click('th[data-key="stars"]');
  await page.waitForTimeout(200);

  // --- filter
  await page.fill('#search', 'react');
  await page.waitForTimeout(400);
  const filteredInfo = await page.textContent('#page-info');
  const filteredFirst = (await page.locator('#tbody tr').first().innerText()).split('\n')[0];
  console.log('filter "react" ->', filteredInfo, '| first:', filteredFirst);

  await page.fill('#search', 'zzzznotarealrepo');
  await page.waitForTimeout(400);
  console.log('no-match empty state visible:', await page.locator('#empty').isVisible());
  await page.fill('#search', '');
  await page.waitForTimeout(400);

  // --- pagination
  await page.click('#next');
  await page.waitForTimeout(300);
  console.log('after next ->', await page.textContent('#page-info'));

  await page.click('#prev');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'dashboard.png'), fullPage: false });
  console.log('screenshot saved: dashboard.png');

  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
