// debug-page.js — dumps page structure to identify correct selectors
// Usage: node debug-page.js "https://results.eci.gov.in/ResultAcGenMay2026/statewiseS111.htm"
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteerExtra.use(StealthPlugin());
const puppeteer = puppeteerExtra;

const url = process.argv[2];
if (!url) { console.error('Usage: node debug-page.js <url>'); process.exit(1); }

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
});

const page = await browser.newPage();
console.log(`Navigating to: ${url}\n`);
await page.goto(url, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(
    () => document.querySelectorAll('.custom-table tbody tr').length > 0,
    { timeout: 15000 }
).catch(() => {});

const info = await page.evaluate(() => {
    // Title
    const title = document.title;

    // Tables on page
    const tables = Array.from(document.querySelectorAll('table')).map(t => ({
        id: t.id,
        className: t.className,
        rows: t.querySelectorAll('tr').length
    }));

    // Divs with "table" in class
    const tableDivs = Array.from(document.querySelectorAll('[class*="table"]')).slice(0, 20).map(el => ({
        tag: el.tagName,
        className: el.className,
        children: el.children.length
    }));

    // Pagination
    const paginationItems = Array.from(document.querySelectorAll('[class*="paginat"]')).slice(0, 5).map(el => ({
        tag: el.tagName,
        className: el.className,
        text: el.textContent?.trim()?.substring(0, 50)
    }));

    // First 3 rows of whatever table exists
    const firstRows = Array.from(document.querySelectorAll('tbody tr')).slice(0, 3).map(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim()?.substring(0, 30));
        return cells;
    });

    // Check specific selector
    const customTable = document.querySelector('.custom-table');
    const tbodyRows   = document.querySelectorAll('.custom-table tbody tr').length;

    return { title, tables, tableDivs, paginationItems, firstRows, customTable: !!customTable, tbodyRows };
});

console.log('=== PAGE TITLE ===');
console.log(info.title);

console.log('\n=== TABLES ===');
console.table(info.tables);

console.log('\n=== DIVS WITH "table" IN CLASS ===');
console.table(info.tableDivs);

console.log('\n=== PAGINATION ELEMENTS ===');
console.table(info.paginationItems);

console.log('\n=== FIRST 3 TABLE ROWS (any tbody tr) ===');
info.firstRows.forEach((row, i) => console.log(`Row ${i}:`, row));

console.log('\n=== SELECTOR CHECK ===');
console.log(`.custom-table exists: ${info.customTable}`);
console.log(`.custom-table tbody tr count: ${info.tbodyRows}`);

// Also dump a snippet of the actual HTML to see structure
const htmlSnippet = await page.evaluate(() => {
    const body = document.body.innerHTML;
    // Find first table-like structure
    const idx = body.indexOf('<table');
    if (idx === -1) return body.substring(0, 2000);
    return body.substring(idx, idx + 3000);
});

console.log('\n=== HTML SNIPPET (first table) ===');
console.log(htmlSnippet.substring(0, 3000));

await browser.close();
