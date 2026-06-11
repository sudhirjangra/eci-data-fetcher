# ECI Parallel Scraper

Node.js + Puppeteer (headless Chromium). Bypasses ECI's bot protection. Scrapes pages in parallel browser tabs across multiple EC2 instances.

## Install

```bash
npm install
# Puppeteer downloads Chromium automatically (~170MB)
```

## EC2 setup (Linux)

Puppeteer needs these system libs on EC2 Amazon Linux / Ubuntu:

```bash
# Ubuntu / Debian
sudo apt-get install -y \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libxss1 ca-certificates fonts-liberation

# Amazon Linux 2
sudo yum install -y chromium
```

## Usage

### Single instance (all pages)
```bash
node scraper.js --state "Bihar" --url "https://results.eci.gov.in/ResultAc2025/statewiseS01.htm"
```

### Multiple EC2 instances (parallel, split by page range)

If Bihar has 20 pages, split across 4 instances:

**EC2 Instance 1:**
```bash
node scraper.js --state "Bihar" --url "https://results.eci.gov.in/ResultAc2025/statewiseS01.htm" --pages "1,2,3,4,5"
```

**EC2 Instance 2:**
```bash
node scraper.js --state "Bihar" --url "https://results.eci.gov.in/ResultAc2025/statewiseS01.htm" --pages "6,7,8,9,10"
```

**EC2 Instance 3:**
```bash
node scraper.js --state "Bihar" --url "https://results.eci.gov.in/ResultAc2025/statewiseS01.htm" --pages "11,12,13,14,15"
```

**EC2 Instance 4:**
```bash
node scraper.js --state "Bihar" --url "https://results.eci.gov.in/ResultAc2025/statewiseS01.htm" --pages "16,17,18,19,20"
```

Within each instance, assigned pages are fetched **simultaneously** (parallel). So 5-page instance = 5 pages at once.

## Different states on different EC2s

Each EC2 can handle a different state entirely:

```bash
# EC2 A - Bihar
node scraper.js --state "Bihar" --url "https://results.eci.gov.in/ResultAc2025/statewiseS01.htm"

# EC2 B - Jharkhand
node scraper.js --state "Jharkhand" --url "https://results.eci.gov.in/ResultAc2025/statewiseS03.htm"
```

## DB write rules (important)

- **Always written:** `eci_round`, `eci_last_updated_at`
- **Only on change:** `eci_updated_at` (when round or status changes)
- **Only on status change:** `result_status`
- **Only when newly 'Result Declared':** `result_declared_at`
- **NEVER written:** `tool_round`, `tool_round_updated_at`, `tool_result_status`, `tool_result_declared_at`

Other constituencies in the DB are never affected — upserts target by `constituency_id`.

## Updating selectors

If ECI site layout changes, edit `config.js` → `ECI_SELECTORS` section only. No other file needs changing.

## Page URL pattern

ECI uses: `statewiseS01.htm` (page 1), `statewiseS01p2.htm` (page 2), `statewiseS01p3.htm` (page 3), etc.

The scraper auto-derives page URLs from the base URL. Just pass the page-1 URL as `--url`.
