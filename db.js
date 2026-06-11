process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { SUPABASE_URL, SUPABASE_ANON_KEY, CONFIG } from './config.js';

const BASE_HEADERS = {
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'resolution=merge-duplicates'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(t);
    }
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export async function fetchAllRows(pathWithQuery) {
    const all = [];
    let from  = 0;
    const pageSize = 1000;
    while (true) {
        const to  = from + pageSize - 1;
        const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathWithQuery}`, {
            headers: { ...BASE_HEADERS, 'Range-Unit': 'items', 'Range': `${from}-${to}` }
        });
        if (!res.ok) { const t = await res.text(); throw new Error(`GET ${res.status}: ${t}`); }
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) break;
        all.push(...rows);
        if (rows.length < pageSize) break;
        from += pageSize;
    }
    return all;
}

export async function fetchRoundsForIds(constIds) {
    if (!constIds || constIds.length === 0) return [];
    const chunks = chunk(constIds, 150);
    const all    = [];
    for (const ids of chunks) {
        const csv = ids.join(',');
        const res = await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/election_data?select=constituency_id,eci_round,result_status&constituency_id=in.(${csv})`,
            { headers: BASE_HEADERS }
        );
        if (!res.ok) { const t = await res.text(); throw new Error(`GET ${res.status}: ${t}`); }
        const rows = await res.json();
        if (Array.isArray(rows)) all.push(...rows);
    }
    return all;
}

export async function upsertRows(rows, label = 'upsert') {
    if (!rows || rows.length === 0) return;
    const chunks = chunk(rows, CONFIG.UPSERT_CHUNK_SIZE);

    for (const [ci, ch] of chunks.entries()) {
        let lastErr = null;
        for (let attempt = 1; attempt <= CONFIG.MAX_WRITE_ATTEMPTS; attempt++) {
            try {
                const res = await fetchWithTimeout(
                    `${SUPABASE_URL}/rest/v1/election_data?on_conflict=constituency_id`,
                    { method: 'POST', headers: BASE_HEADERS, body: JSON.stringify(ch) }
                );
                if (!res.ok) {
                    const t = await res.text();
                    throw new Error(`POST ${res.status}: ${t}`);
                }
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (attempt < CONFIG.MAX_WRITE_ATTEMPTS) {
                    const delay = 400 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
                    console.warn(`[DB] ${label} chunk ${ci + 1} attempt ${attempt} failed, retry in ${delay}ms:`, err.message);
                    await sleep(delay);
                }
            }
        }
        if (lastErr) throw new Error(`[DB] ${label} chunk ${ci + 1} failed: ${lastErr.message}`);
    }
}
