// watcher v21 — parallel queue + fast location + single-batch Discord + stable X-50
import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3); // <— ajuste se quiser

console.log("watcher version v21");

if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL is missing");
  process.exit(1);
}

/* ---------------- IO ---------------- */
async function loadList() {
  try {
    const t = await fs.readFile(WATCHLIST_FILE, "utf8");
    return t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function saveState(obj) {
  await fs.writeFile(STATE_FILE, JSON.stringify(obj), "utf8");
}
async function postDiscord(text) {
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
}
function chunkText(s, lim = 1900) {
  const chunks = [];
  let i = 0;
  while (i < s.length) {
    chunks.push(s.slice(i, i + lim));
    i += lim;
  }
  return chunks;
}

/* ---------------- Page helpers ---------------- */
async function closeCookieBanner(page) {
  const tryClick = async (sel) => {
    try { await page.locator(sel).first().click({ timeout: 600 }); return true; } catch { return false; }
  };
  if (await tryClick('button:has-text("Permitir todos")')) return;
  if (await tryClick('button:has-text("Rejeitar")')) return;
  if (await tryClick('text=Permitir todos')) return;
  if (await tryClick('text=Rejeitar')) return;
  for (const f of page.frames()) {
    try {
      if (/usercentrics|consent|cookiebot/i.test(f.url())) {
        const btn = f.locator('button:has-text("Permitir todos"), button:has-text("Rejeitar")').first();
        await btn.click({ timeout: 800 });
        return;
      }
    } catch {}
  }
}

async function ensureX50Once(page, maxTries = 3) {
  for (let i = 1; i <= maxTries; i++) {
    try {
      const selectedTxt = await page.evaluate(() => {
        const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
        return (sel?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
      });
      if (selectedTxt && /GUILDWAR/.test(selectedTxt)) return;

      // open selected group (usually X-5 CLASSIC)
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('div[class*="SideMenuServers_item"]'));
        const sel = all.find(el => el.className.includes("SideMenuServers_selected")) || all[0];
        if (sel) sel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForTimeout(180);

      // click GUILDWAR (X-50)
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('div[class*="SideMenuServers_item"]'));
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toUpperCase();
        const target = items.find(el => /GUILDWAR/.test(norm(el.textContent))) ||
                       items.find(el => /X\s*-\s*50/.test(norm(el.textContent)));
        if (target) {
          target.scrollIntoView({ block: "center" });
          target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
      });

      const ok = await page.waitForFunction(() => {
        const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
        const txt = (sel?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
        return /GUILDWAR/.test(txt);
      }, { timeout: 1200 }).catch(() => false);

      if (ok) return;
    } catch {}
    await page.waitForTimeout(180);
  }
}

// quick check if currently X-5
async function isX5(page) {
  return await page.evaluate(() => {
    const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
    const txt = (sel?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
    return !/GUILDWAR/.test(txt);
  }).catch(() => false);
}

// Fast wait (<= 4500ms) for header + non-empty location
async function waitForHeaderAndLocation(page, nick, timeoutMs = 4500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate((n) => {
      // header with <b>{nick}</b>
      const nameBlocks = Array.from(
        document.querySelectorAll(
          '.CharPage_name__wtExV, [class*="CharPage_name__"], .CharPage_name-block__nxxRU, [class*="CharPage_name-block__"]'
        )
      );
      const header = nameBlocks.find(c => {
        const b = c.querySelector('b');
        const txt = (b?.textContent || c.textContent || '').trim();
        return new RegExp(`\\b${n}\\b`, 'i').test(txt);
      });
      if (!header) return false;

      // scoped char-info first, then global fallback
      const pick = (root) => {
        const spans = Array.from(root.querySelectorAll('span'));
        for (let i = 0; i < spans.length; i++) {
          const t = (spans[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (/^Localiza(?:ç|c)ão\s*:?\s*$/i.test(t)) {
            const next = spans[i].parentElement?.querySelectorAll('span')?.[1] || spans[i].nextElementSibling;
            const val = next && next.tagName?.toLowerCase() === 'span' ? (next.textContent || '').trim() : '';
            if (val) return true;
          }
        }
        return false;
      };

      const infoRoot =
        document.querySelector('.CharPage_char-info__EW_Lb') ||
        document.querySelector('[class*="CharPage_char-info__"]') ||
        null;

      return (infoRoot && pick(infoRoot)) || pick(document);
    }, nick).catch(() => false);

    if (ok) return;
    await page.waitForTimeout(120);
  }
}

// single extraction (status anchored on header, location from char-info w/ fallback)
async function extractOnce(page, nick) {
  return await page.evaluate((n) => {
    // STATUS — icon near <b>{nick}</b>
    let status = '—';
    const nameBlocks = Array.from(
      document.querySelectorAll(
        '.CharPage_name__wtExV, [class*="CharPage_name__"], .CharPage_name-block__nxxRU, [class*="CharPage_name-block__"]'
      )
    );
    const header = nameBlocks.find(c => {
      const b = c.querySelector('b');
      const txt = (b?.textContent || c.textContent || '').trim();
      return new RegExp(`\\b${n}\\b`, 'i').test(txt);
    }) || null;

    if (header) {
      const img = header.querySelector('img[alt="Online"], img[alt="Offline"]');
      if (img) status = img.getAttribute('alt') || '—';
    }

    // LOCATION — first char-info, then global
    const pickLocation = (root) => {
      const spans = Array.from(root.querySelectorAll('span'));
      for (let i = 0; i < spans.length; i++) {
        const t = (spans[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (/^Localiza(?:ç|c)ão\s*:?\s*$/i.test(t)) {
          const next = spans[i].parentElement?.querySelectorAll('span')?.[1] || spans[i].nextElementSibling;
          if (next && next.tagName?.toLowerCase() === 'span') {
            const v = (next.textContent || '').trim();
            if (v) return v;
          }
        }
      }
      return null;
    };

    let location = '—';
    const infoRoot =
      document.querySelector('.CharPage_char-info__EW_Lb') ||
      document.querySelector('[class*="CharPage_char-info__"]') ||
      null;

    location = (infoRoot && pickLocation(infoRoot)) || pickLocation(document) || '—';
    if (/^Lorencia$/i.test(location)) location = 'Privada';

    return { ok: (status !== '—' || (location && location !== '—')), status, location };
  }, nick);
}

// full per-nick routine with tight timing (≈ 3.5–5s hard cap)
async function processNick(page, nick) {
  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // fix to X-50 only if needed (fast)
  if (await isX5(page)) {
    await ensureX50Once(page).catch(() => {});
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  // quick wait for header+location (≤ 4.5s)
  await waitForHeaderAndLocation(page, nick, 4500);
  await page.waitForTimeout(120);

  // try up to 3 times if location blank
  let data = await extractOnce(page, nick);
  if (data.location === '—') {
    await page.waitForTimeout(300);
    data = await extractOnce(page, nick);
    if (data.location === '—') {
      await page.waitForTimeout(500);
      data = await extractOnce(page, nick);
    }
  }
  return data.ok ? data : { ok: false, status: '—', location: '—', error: 'no-data' };
}

/* ------------------------------ MAIN ------------------------------ */
(async () => {
  const list = await loadList();
  if (!list.length) {
    console.log("watchlist is empty");
    return;
  }
  const state = await loadState();

  // one browser, multiple pages in pool
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR",
    extraHTTPHeaders: {
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1",
    },
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // allow same-origin JS/CSS; block images/fonts/media + known heavy third-parties
  const host = new URL(BASE).host;
  await context.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (["image", "font", "media"].includes(type)) return route.abort();

    // kill heavy third-party trackers
    if (/(googletagmanager|google-analytics|gtag|facebook|hotjar|yandex|tiktok)/i.test(url)) {
      return route.abort();
    }

    // prefer same-origin for scripts/styles (suficiente pro Next.js do site)
    try {
      const u = new URL(url);
      if ((type === "script" || type === "stylesheet") && u.host !== host) {
        return route.abort();
      }
    } catch {}
    return route.continue();
  });

  // warmup: open home once, accept cookies, set X-50 in one tab (não precisa repetir)
  const warm = await context.newPage();
  warm.setDefaultTimeout(2500);
  warm.setDefaultNavigationTimeout(8000);
  await warm.goto(`${BASE}/pt/`, { waitUntil: "domcontentloaded" });
  await closeCookieBanner(warm).catch(() => {});
  await ensureX50Once(warm).catch(() => {});
  await warm.close();

  // create page pool
  const pages = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const p = await context.newPage();
    p.setDefaultTimeout(2500);
    p.setDefaultNavigationTimeout(8000);
    pages.push(p);
  }

  const changes = [];
  let idx = 0;

  async function worker(p) {
    while (idx < list.length) {
      const myIdx = idx++;
      const nick = list[myIdx];

      try {
        const cur = await processNick(p, nick);
        if (!cur.ok) {
          console.log(`skip ${nick}: ${cur.error || "no data"}`);
        } else {
          const prev = state[nick] || {};
          const changed = prev.status !== cur.status || prev.location !== cur.location;
          if (changed) {
            changes.push({ nick, ...cur });
            state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
          } else {
            console.log(`no change ${nick}: status=${cur.status} loc=${cur.location}`);
          }
        }
      } catch (e) {
        console.log(`fail ${nick}: ${e?.message || e}`);
      }

      // tiny jitter to avoid heuristics
      await p.waitForTimeout(60 + Math.random() * 90);
    }
  }

  await Promise.all(pages.map((p) => worker(p)));

  // batch post (single or few messages max)
  if (changes.length) {
    const blocks = changes.map(c => `**${c.nick}**\n• Status: ${c.status}\n• Location: ${c.location}`);
    const payload = blocks.join("\n\n");
    for (const part of chunkText(payload, 1800)) {
      await postDiscord(part);
      await new Promise(r => setTimeout(r, 200));
    }
  } else {
    console.log("no changes to report");
  }

  await saveState(state);
  await Promise.all(pages.map(p => p.close()));
  await browser.close();
})();
