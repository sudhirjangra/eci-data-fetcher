#!/usr/bin/env node

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllRows, fetchRoundsForIds, upsertRows } from './db.js';
import { ECI_SELECTORS, CONFIG } from './config.js';

puppeteerExtra.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.join(__dirname, 'portal-urls.csv');

function parseCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
  const states = [];
  for (let i = 1; i < lines.length; i++) {
    const comma = lines[i].indexOf(',');
    if (comma === -1) continue;
    const state = lines[i].slice(0, comma).trim();
    const url   = lines[i].slice(comma + 1).trim();
    if (state && url) states.push({ state, url });
  }
  return states;
}

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

async function showStateMenu(states) {
  console.clear();
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        ECI RESULTS SCRAPER — STATE SELECTOR         ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  const rows = Math.ceil(states.length / 2);
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < 2; c++) {
      const idx = c * rows + r;
      if (idx < states.length) {
        const num = String(idx + 1).padStart(2, ' ');
        line += `  ${num}. ${states[idx].state.padEnd(34)}`;
      }
    }
    console.log(line);
  }
  const answer = await ask('\nEnter state number: ');
  const idx = parseInt(answer, 10) - 1;
  return (idx >= 0 && idx < states.length) ? states[idx] : null;
}

// ── ANSI DASHBOARD ────────────────────────────────────────────────────────────
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME_CLEAR  = '\x1b[2J\x1b[H';

const logBuffer = [];
const MAX_LOGS = 4;

function hijackConsole() {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...args) => {
    const msg = args.map(a => String(a)).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    logBuffer.push(msg.slice(0, 120));
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  };
  console.log = push;
  console.warn = push;
  console.error = push;
}

function renderDashboard(selectedState, numInstances, stats, startTime, totals) {
  const termW   = Math.max(80, process.stdout.columns || 80);
  const colW    = Math.floor((termW - numInstances - 1) / numInstances);
  const totalW  = colW * numInstances + numInstances + 1;

  const pad = (text, w) => {
    const t = String(text ?? '');
    return t.length >= w ? ' ' + t.slice(0, w - 2) + ' ' : ' ' + t + ' '.repeat(w - 1 - t.length);
  };

  const hLine = (left, mid, right, fill = '─') => {
    let s = left;
    for (let i = 0; i < numInstances; i++) s += fill.repeat(colW) + (i < numInstances - 1 ? mid : right);
    return s;
  };

  const dataRow = (values, rawWidths) => {
    let s = '│';
    for (let i = 0; i < numInstances; i++) {
      const raw = rawWidths?.[i] ?? 0;
      const cell = values[i] ?? '';
      const visibleLen = raw || cell.length;
      const padding = Math.max(0, colW - visibleLen - 1);
      s += ' ' + cell + ' '.repeat(padding) + '│';
    }
    return s;
  };

  const elapsed   = Math.floor((Date.now() - startTime) / 1000);
  const elapsedStr = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const title     = `ECI SCRAPER  ·  ${selectedState.state}  ·  ${numInstances} instance${numInstances > 1 ? 's' : ''}  ·  +${elapsedStr}`;

  const statusStr = s => s.scraping ? '\x1b[33m⟳ Running\x1b[0m' : s.error ? '\x1b[31m✗ Error  \x1b[0m' : '\x1b[32m✓ Idle   \x1b[0m';

  const lines = [];
  lines.push('┌' + '─'.repeat(totalW - 2) + '┐');
  lines.push('│' + pad(title, totalW - 1) + '│');
  lines.push(hLine('├', '┬', '┤'));
  lines.push(dataRow(stats.map((_, i) => `  Instance ${i + 1}`)));
  lines.push(dataRow(stats.map(s => `  Pages: [${s.pages.join(',')}]`)));
  lines.push(hLine('├', '┼', '┤'));
  lines.push(dataRow(stats.map(s => `   ${statusStr(s)}`), stats.map(() => 12)));
  lines.push(dataRow(stats.map(s => `  Cycle    #${s.cycle}`)));
  lines.push(dataRow(stats.map(s => `  Items     ${s.items}`)));
  lines.push(dataRow(stats.map(s => `  Changes   ${s.changes}`)));
  lines.push(dataRow(stats.map(s => `  Errors    ${s.errors}`)));
  lines.push(dataRow(stats.map(s => `  Last  ${s.lastCycleTime || '--:--:--'}`)));
  lines.push(hLine('├', '┴', '┤'));
  lines.push('│' + pad(`  Total upserted: ${totals.upserted}  ·  Round changes: ${totals.changes}`, totalW - 1) + '│');
  lines.push('└' + '─'.repeat(totalW - 2) + '┘');
  if (logBuffer.length > 0) {
    logBuffer.forEach(msg => lines.push('  ' + msg));
  }
  lines.push('  Ctrl+C to stop');

  return lines.join('\n');
}

// ── PAGE DISCOVERY ─────────────────────────────────────────────────────────────
async function discoverPages(url) {
  const browser = await puppeteerExtra.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  });
  try {
    const tab = await browser.newPage();
    await tab.goto(url, { waitUntil: 'load', timeout: CONFIG.FETCH_TIMEOUT_MS });
    await tab.waitForSelector(ECI_SELECTORS.pagination, { timeout: 10000 }).catch(() => {});

    const { links, detectedState } = await tab.evaluate(sel => ({
      links: Array.from(document.querySelectorAll(sel)).map(a => ({
        text: a.textContent?.trim(),
        href: a.href
      })),
      detectedState: document.querySelector('.page-title h2 span')?.textContent?.trim() || null
    }), ECI_SELECTORS.pagination);

    await tab.close().catch(() => {});

    const pageUrlMap = new Map();
    links.forEach(({ text, href }) => {
      const n = parseInt(text, 10);
      if (!isNaN(n) && href) pageUrlMap.set(n, href);
    });
    if (!pageUrlMap.has(1)) pageUrlMap.set(1, url);

    return { pageUrlMap, detectedState };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── DB CACHE ──────────────────────────────────────────────────────────────────
async function loadEciMap(stateName) {
  let mapData = await fetchAllRows(
    `constituencies?select=id,eci_id,states!inner(name)&states.name=eq.${encodeURIComponent(stateName)}&order=id.asc`
  );
  if (!Array.isArray(mapData) || mapData.length === 0) {
    const all = await fetchAllRows('constituencies?select=id,eci_id,states!inner(name)&order=id.asc');
    mapData = all.filter(row => row.states?.name === stateName);
  }

  const eciMapCache = new Map();
  mapData.forEach(row => eciMapCache.set(`${stateName}_${row.eci_id}`, row.id));
  return { eciMapCache, count: eciMapCache.size };
}

// ── SCRAPE ─────────────────────────────────────────────────────────────────────
async function scrapePageWithTab(browser, pageNum, baseUrl, stateName, pageUrlMap) {
  const url = pageUrlMap.has(pageNum)
    ? pageUrlMap.get(pageNum)
    : (() => {
        const m = baseUrl.match(/^(.*?)(\d+)(\.htm)$/i);
        return m ? `${m[1]}${parseInt(m[2], 10) + (pageNum - 1)}${m[3]}` : baseUrl;
      })();

  const tab = await browser.newPage();
  try {
    await tab.setExtraHTTPHeaders({
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    await tab.goto(url, { waitUntil: 'load', timeout: CONFIG.FETCH_TIMEOUT_MS });
    await tab.waitForFunction(
      () => {
        const rows = document.querySelectorAll('.custom-table tbody tr');
        for (const row of rows) {
          if (row.querySelectorAll(':scope > td').length >= 8) return true;
        }
        return false;
      },
      { timeout: 20000 }
    ).catch(() => {});

    return await tab.evaluate((sel, state) => {
      const result = [];
      document.querySelectorAll(sel.tableRows).forEach(row => {
        const cells = Array.from(row.children).filter(el => el.tagName === 'TD');
        if (cells.length < 8) return;
        const constName  = (cells[sel.colName]?.childNodes[0]?.textContent || '').trim() ||
                            cells[sel.colName]?.textContent?.trim();
        const eciIdRaw   = cells[sel.colEciId]?.textContent?.trim();
        const roundRaw   = (cells[sel.colRound]?.textContent || '').replace(/\s+/g, '');
        const resultStatus = cells[sel.colStatus]?.textContent?.trim() || '';
        if (!constName || !eciIdRaw) return;
        const eciId = parseInt(eciIdRaw, 10);
        if (isNaN(eciId)) return;
        const m = roundRaw.match(/^(\d+)\/(\d+)$/);
        result.push({ stateName: state, constName, eciId, currentRound: m ? parseInt(m[1], 10) : 0, resultStatus });
      });
      return result;
    }, ECI_SELECTORS, stateName);
  } finally {
    await tab.close().catch(() => {});
  }
}

// ── BATCH PROCESS ──────────────────────────────────────────────────────────────
async function processBatch(items, eciMapCache, dbRoundCache, dbStatusCache, heartbeatCache) {
  if (items.length === 0) return { upserted: 0, roundChanges: 0 };

  const deduped = new Map();
  for (const item of items) {
    const constId = eciMapCache.get(`${item.stateName}_${item.eciId}`);
    if (!constId) continue;
    const existing = deduped.get(constId);
    if (!existing || item.currentRound > existing.currentRound) {
      deduped.set(constId, { constId, currentRound: item.currentRound, resultStatus: item.resultStatus || '' });
    }
  }

  if (deduped.size === 0) return { upserted: 0, roundChanges: 0 };

  try {
    const rows = await fetchRoundsForIds(Array.from(deduped.keys()));
    const seen = new Set();
    rows.forEach(row => {
      seen.add(row.constituency_id);
      dbRoundCache.set(row.constituency_id, row.eci_round ?? 0);
      dbStatusCache.set(row.constituency_id, row.result_status ?? '');
    });
    deduped.forEach((_, id) => {
      if (!seen.has(id)) { dbRoundCache.set(id, 0); dbStatusCache.set(id, ''); }
    });
  } catch (_) {}

  const now = new Date().toISOString();
  const nowMs = Date.now();
  const changed = [];
  const heartbeat = [];
  let roundChanges = 0;

  for (const [constId, data] of deduped) {
    const cachedRound  = dbRoundCache.get(constId) ?? 0;
    const cachedStatus = dbStatusCache.get(constId) ?? '';
    const roundChanged  = data.currentRound !== cachedRound;
    const statusChanged = data.resultStatus !== cachedStatus;

    if (roundChanged)  { dbRoundCache.set(constId, data.currentRound); roundChanges++; }
    if (statusChanged) { dbStatusCache.set(constId, data.resultStatus); }

    if (roundChanged || statusChanged) {
      heartbeatCache.set(constId, nowMs);
      const row = { constituency_id: constId, eci_round: data.currentRound, eci_last_updated_at: now, eci_updated_at: now };
      if (statusChanged) {
        row.result_status = data.resultStatus;
        if (data.resultStatus === ECI_SELECTORS.declaredStatus && cachedStatus !== ECI_SELECTORS.declaredStatus) {
          row.result_declared_at = now;
        }
      }
      changed.push(row);
    } else {
      const lastHb = heartbeatCache.get(constId) ?? 0;
      if (nowMs - lastHb >= CONFIG.HEARTBEAT_INTERVAL_MS) {
        heartbeatCache.set(constId, nowMs);
        heartbeat.push({ constituency_id: constId, eci_round: data.currentRound, eci_last_updated_at: now });
      }
    }
  }

  await upsertRows(changed.filter(r => !r.result_status && !r.result_declared_at), 'Round');
  await upsertRows(changed.filter(r =>  r.result_status && !r.result_declared_at), 'Status');
  await upsertRows(changed.filter(r =>  r.result_status &&  r.result_declared_at), 'Declared');
  await upsertRows(heartbeat, 'Heartbeat');

  return { upserted: changed.length + heartbeat.length, roundChanges };
}

// ── RUN INSTANCE ───────────────────────────────────────────────────────────────
async function runInstance(state, stateName, pageUrlMap, assignedPages, eciMapCache, stat, sharedTotals) {
  const dbRoundCache  = new Map();
  const dbStatusCache = new Map();
  const heartbeatCache = new Map();

  eciMapCache.forEach(id => { dbRoundCache.set(id, 0); dbStatusCache.set(id, ''); });

  try {
    const ids = Array.from(dbRoundCache.keys());
    if (ids.length > 0) {
      const rows = await fetchRoundsForIds(ids);
      rows.forEach(row => {
        dbRoundCache.set(row.constituency_id, row.eci_round ?? 0);
        dbStatusCache.set(row.constituency_id, row.result_status ?? '');
      });
    }
  } catch (_) {}

  const browser = await puppeteerExtra.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  });

  const refreshInterval = setInterval(async () => {
    try {
      const ids = Array.from(dbRoundCache.keys());
      if (ids.length > 0) {
        const rows = await fetchRoundsForIds(ids);
        rows.forEach(row => {
          dbRoundCache.set(row.constituency_id, row.eci_round ?? 0);
          dbStatusCache.set(row.constituency_id, row.result_status ?? '');
        });
      }
    } catch (_) {}
  }, CONFIG.DB_REFRESH_INTERVAL_MS);

  try {
    while (true) {
      stat.scraping = true;
      stat.error = false;

      try {
        const results = await Promise.allSettled(
          assignedPages.map((pageNum, idx) =>
            new Promise(r => setTimeout(r, idx * CONFIG.PAGE_FETCH_DELAY_MS))
              .then(() => scrapePageWithTab(browser, pageNum, state.url, stateName, pageUrlMap))
          )
        );

        const allItems = [];
        for (const result of results) {
          if (result.status === 'fulfilled') allItems.push(...result.value);
          else stat.errors++;
        }

        stat.items = allItems.length;
        const { upserted, roundChanges } = await processBatch(
          allItems, eciMapCache, dbRoundCache, dbStatusCache, heartbeatCache
        );
        stat.changes += roundChanges;
        sharedTotals.upserted += upserted;
        sharedTotals.changes  += roundChanges;

      } catch (err) {
        stat.errors++;
        stat.error = true;
      }

      stat.cycle++;
      stat.scraping = false;
      stat.lastCycleTime = new Date().toLocaleTimeString();

      await new Promise(r => setTimeout(r, CONFIG.CYCLE_PAUSE_MS));
    }
  } finally {
    clearInterval(refreshInterval);
    await browser.close().catch(() => {});
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────────
async function main() {
  const states   = parseCsv(csvPath);
  const selected = await showStateMenu(states);
  if (!selected) { console.log('Exited.'); process.exit(0); }

  const raw = await ask('\nParallel instances (1-4, default 1): ');
  const numInstances = Math.max(1, Math.min(4, parseInt(raw, 10) || 1));

  console.log(`\nDiscovering pages for ${selected.state}...`);
  const { pageUrlMap, detectedState } = await discoverPages(selected.url);
  const stateName = detectedState || selected.state;
  const allPages  = Array.from(pageUrlMap.keys()).sort((a, b) => a - b);
  console.log(`  ${allPages.length} pages found  ·  State: "${stateName}"`);

  console.log(`Loading DB cache...`);
  const { eciMapCache, count } = await loadEciMap(stateName);
  if (count === 0) {
    console.log(`⚠ No constituencies found for "${stateName}". Check DB.`);
    process.exit(1);
  }
  console.log(`  ${count} constituencies loaded\n`);

  // Round-robin page distribution
  const assignedPages = Array.from({ length: numInstances }, () => []);
  allPages.forEach((page, idx) => assignedPages[idx % numInstances].push(page));

  const stats = Array.from({ length: numInstances }, (_, i) => ({
    pages: assignedPages[i],
    cycle: 0, items: 0, changes: 0, errors: 0,
    scraping: false, error: false, lastCycleTime: null
  }));
  const sharedTotals = { upserted: 0, changes: 0 };
  const startTime = Date.now();

  hijackConsole();

  // const renderInterval = setInterval(() => {
  //   process.stdout.write(HOME_CLEAR);
  //   process.stdout.write(renderDashboard(selected, numInstances, stats, startTime, sharedTotals));
  //   process.stdout.write('\n');
  // }, 500);

  const shutdown = () => {
    // clearInterval(renderInterval);
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Stagger start, run in parallel
  await Promise.all(
    Array.from({ length: numInstances }, (_, i) =>
      new Promise(r => setTimeout(r, i * 1500))
        .then(() => runInstance(selected, stateName, pageUrlMap, assignedPages[i], eciMapCache, stats[i], sharedTotals))
    )
  );
}

main().catch(err => {
  process.stdout.write(SHOW_CURSOR);
  console.error('Fatal:', err);
  process.exit(1);
});
