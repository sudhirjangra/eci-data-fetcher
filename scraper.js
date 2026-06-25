#!/usr/bin/env node
import { load } from 'cheerio';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllRows, fetchRoundsForIds, upsertRows } from './db.js';
import { ECI_SELECTORS, CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.join(__dirname, 'portal-urls.csv');

let cycleCount = 0;

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

let rl = null;
let lines = [];
let lineIdx = 0;

async function ask(prompt) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', line => lines.push(line));
  }

  process.stdout.write(prompt);

  return new Promise(resolve => {
    const check = () => {
      if (lineIdx < lines.length) {
        resolve(lines[lineIdx++].trim());
      } else {
        setImmediate(check);
      }
    };
    check();
  });
}

async function showStateMenu(states) {
  console.clear();
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        ECI RESULTS SCRAPER — STATE SELECTOR          ║');
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

// ── PAGE DISCOVERY ─────────────────────────────────────────────────────────────
async function discoverPages(url) {
  try {
    const headers = {
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    const res = await fetch(url, { headers, timeout: CONFIG.FETCH_TIMEOUT_MS });
    if (!res.ok) {
      console.warn(`  Page load failed: ${res.status} ${res.statusText}`);
      return { pageUrlMap: new Map([[1, url]]), detectedState: null };
    }
    const html = await res.text();
    const $ = load(html);

    const links = [];
    $(ECI_SELECTORS.pagination).each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      if (text && href) links.push({ text, href });
    });

    const detectedState = $('.page-title h2 span').text().trim() || null;

    const pageUrlMap = new Map();
    links.forEach(({ text, href }) => {
      const n = parseInt(text, 10);
      if (!isNaN(n) && href) {
        const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
        pageUrlMap.set(n, fullUrl);
      }
    });
    if (!pageUrlMap.has(1)) pageUrlMap.set(1, url);

    return { pageUrlMap, detectedState };
  } catch (err) {
    console.warn(`  Discovery failed: ${err.message}`);
    return { pageUrlMap: new Map([[1, url]]), detectedState: null };
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

function getPageUrl(baseUrl, pageNum, pageUrlMap) {
  if (pageUrlMap.has(pageNum)) return pageUrlMap.get(pageNum);
  const m = baseUrl.match(/^(.*?)(\d+)(\.htm)$/i);
  if (m) return `${m[1]}${parseInt(m[2], 10) + (pageNum - 1)}${m[3]}`;
  return baseUrl.replace(/\.htm$/i, `p${pageNum}.htm`);
}

// ── SCRAPE ─────────────────────────────────────────────────────────────────────
async function scrapePageWithFetch(pageNum, baseUrl, stateName, pageUrlMap) {
  const url = getPageUrl(baseUrl, pageNum, pageUrlMap);

  try {
    const headers = {
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    const res = await fetch(url, { headers, timeout: CONFIG.FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const html = await res.text();
    const $ = load(html);

    const result = [];
    $(ECI_SELECTORS.tableRows).each((_, row) => {
      const $row = $(row);
      const cells = $row.find('> td');
      if (cells.length < 8) return;

      const nameCell = cells.eq(ECI_SELECTORS.colName);
      const constName = (nameCell[0]?.firstChild?.textContent || '').trim() || nameCell.text().trim();

      const eciIdRaw = cells.eq(ECI_SELECTORS.colEciId).text().trim();
      const roundRaw = cells.eq(ECI_SELECTORS.colRound).text().replace(/\s+/g, '');
      const resultStatus = cells.eq(ECI_SELECTORS.colStatus).text().trim() || '';

      if (!constName || !eciIdRaw) return;
      const eciId = parseInt(eciIdRaw, 10);
      if (isNaN(eciId)) return;

      const m = roundRaw.match(/^(\d+)\/(\d+)$/);
      const currentRound = m ? parseInt(m[1], 10) : 0;

      result.push({
        stateName,
        constName,
        eciId,
        currentRound,
        resultStatus
      });
    });

    return result;
  } catch (err) {
    console.error(`  Fetch page ${pageNum} failed: ${err.message}`);
    return [];
  }
}

// ── BATCH PROCESS ──────────────────────────────────────────────────────────────
async function processBatch(items, eciMapCache, dbRoundCache, dbStatusCache, heartbeatCache) {
  if (items.length === 0) return { upserted: 0, roundChanges: 0, unmapped: 0 };

  const deduped = new Map();
  let unmapped = 0;
  for (const item of items) {
    const constId = eciMapCache.get(`${item.stateName}_${item.eciId}`);
    if (!constId) { unmapped++; continue; }
    const existing = deduped.get(constId);
    if (!existing || item.currentRound > existing.currentRound) {
      deduped.set(constId, { constId, currentRound: item.currentRound, resultStatus: item.resultStatus || '' });
    }
  }

  if (deduped.size === 0) return { upserted: 0, roundChanges: 0, unmapped };

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
  const changedRoundOnly = [];
  const changedStatusOnly = [];
  const changedWithDeclared = [];
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

      if (!row.result_status && !row.result_declared_at) {
        changedRoundOnly.push(row);
      } else if (row.result_status && !row.result_declared_at) {
        changedStatusOnly.push(row);
      } else {
        changedWithDeclared.push(row);
      }
    } else {
      const lastHb = heartbeatCache.get(constId) ?? 0;
      if (nowMs - lastHb >= CONFIG.HEARTBEAT_INTERVAL_MS) {
        heartbeatCache.set(constId, nowMs);
        heartbeat.push({ constituency_id: constId, eci_round: data.currentRound, eci_last_updated_at: now });
      }
    }
  }

  await upsertRows(changedRoundOnly, 'EciChanged-RoundOnly');
  await upsertRows(changedStatusOnly, 'EciChanged-StatusOnly');
  await upsertRows(changedWithDeclared, 'EciChanged-Declared');
  await upsertRows(heartbeat, 'EciHeartbeat');

  const total = changedRoundOnly.length + changedStatusOnly.length + changedWithDeclared.length + heartbeat.length;
  return { upserted: total, roundChanges, unmapped };
}

function formatTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

// ── RUN INSTANCE ───────────────────────────────────────────────────────────────
async function runInstance(state, stateName, pageUrlMap, assignedPages, eciMapCache, stat, sharedTotals, instanceId) {
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

      const time = formatTime();
      stat.cycle++;
      console.log(`[${time}] [Cycle ${stat.cycle}] [Instance ${instanceId}] Scraping pages: [${assignedPages.join(', ')}]`);

      try {
        const results = await Promise.allSettled(
          assignedPages.map((pageNum, idx) =>
            new Promise(r => setTimeout(r, idx * CONFIG.PAGE_FETCH_DELAY_MS))
              .then(() => scrapePageWithFetch(pageNum, state.url, stateName, pageUrlMap))
          )
        );

        const allItems = [];
        let failCount = 0;
        for (const result of results) {
          if (result.status === 'fulfilled') allItems.push(...result.value);
          else { failCount++; stat.errors++; }
        }

        stat.items = allItems.length;
        const { upserted, roundChanges, unmapped } = await processBatch(
          allItems, eciMapCache, dbRoundCache, dbStatusCache, heartbeatCache
        );
        stat.changes += roundChanges;
        sharedTotals.upserted += upserted;
        sharedTotals.changes  += roundChanges;

      } catch (err) {
        stat.errors++;
        stat.error = true;
      }

      stat.scraping = false;
      stat.lastCycleTime = formatTime();

      const finishTime = formatTime();
      console.log(`[${finishTime}] [Cycle ${stat.cycle}] [Instance ${instanceId}] Finished. Items: ${stat.items}, Changes: ${stat.changes}. Total upserted: ${sharedTotals.upserted}`);

      cycleCount++;
      if (cycleCount % 25 === 0) {
        console.clear();
        console.log(`[${formatTime()}] ─ Terminal cleared after 25 cycles. Running totals: Upserted ${sharedTotals.upserted}, Changes ${sharedTotals.changes} ─`);
      }

      await new Promise(r => setTimeout(r, CONFIG.CYCLE_PAUSE_MS));
    }
  } finally {
    clearInterval(refreshInterval);
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

  const shutdown = () => {
    if (rl) rl.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Stagger start, run in parallel
  await Promise.all(
    Array.from({ length: numInstances }, (_, i) =>
      new Promise(r => setTimeout(r, i * 1500))
        .then(() => runInstance(selected, stateName, pageUrlMap, assignedPages[i], eciMapCache, stats[i], sharedTotals, i + 1))
    )
  );
}

main().catch(err => {
  console.error('Fatal:', err);
  if (rl) rl.close();
  process.exit(1);
});
