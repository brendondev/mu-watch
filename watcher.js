// watcher v1.1 — Cloudflare-aware, balanced waits, progressive retries, batch Discord, stable X-50
import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";
const CONCURRENCY = Number(process.env.CONCURRENCY || 1); // ajuste se necessário

// Orçamento de tempo para evitar timeout do Actions (padrão ~4,5min)
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS || 270000);
const HARD_DEADLINE = Date.now() + TIME_BUDGET_MS;

console.log("watcher version v1.1 (cloudflare-aware)");

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
async function postDiscord(payload) {
  const body = (typeof payload === "string")
    ? { content: payload }
    : payload;

  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

/* ---------------- Cloudflare helpers ---------------- */
async function waitCloudflare(page, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const challenged = await page.evaluate(() => {
      const t = document.title || "";
      if (/just a moment|checking your browser|attention required|verifying you are human/i.test(t)) return true;
      if (document.querySelector('#challenge-stage')) return true;
      if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return true;
      // Alguns temas mostram um spinner com texto "Checking..."
      return false;
    }).catch(() => false);
    if (!challenged) return; // challenge terminou
    await page.waitForTimeout(500);
  }
}

/* ---------------- Page helpers ---------------- */
async function closeCookieBanner(page) {
  const tryClick = async (sel) => {
    try { await page.locator(sel).first().click({ timeout: 700 }); return true; } catch { return false; }
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

      // abre grupo selecionado
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('div[class*="SideMenuServers_item"]'));
        const sel = all.find(el => el.className.includes("SideMenuServers_selected")) || all[0];
        if (sel) sel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForTimeout(220);

      // clica GUILDWAR (X-50)
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
      }, { timeout: 1600 }).catch(() => false);

      if (ok) return;
    } catch {}
    await page.waitForTimeout(200);
  }
}

async function isX5(page) {
  return await page.evaluate(() => {
    const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
    const txt = (sel?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
    return !/GUILDWAR/.test(txt);
  }).catch(() => false);
}

// espera somente o header (nome do nick) — localização pode atrasar
async function waitForHeader(page, nick, timeoutMs = 6500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate((n) => {
      const sel = '.CharPage_name__wtExV, [class*="CharPage_name__"], .CharPage_name-block__nxxRU, [class*="CharPage_name-block__"]';
      const blocks = Array.from(document.querySelectorAll(sel));
      return blocks.some(c => {
        const b = c.querySelector('b');
        const txt = (b?.textContent || c.textContent || '').trim();
        return new RegExp(`\\b${n}\\b`, 'i').test(txt);
      });
    }, nick).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

// Mais robusto (texto + <img alt>)
async function extractOnce(page, nick) {
  return await page.evaluate((n) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    const nameBlocks = Array.from(document.querySelectorAll(
      '.CharPage_name__wtExV, [class*="CharPage_name__"], .CharPage_name-block__nxxRU, [class*="CharPage_name-block__"]'
    ));

    const header = nameBlocks.find(c => {
      const b = c.querySelector('b');
      const txt = norm(b?.textContent || c.textContent || "");
      return new RegExp(`\\b${n}\\b`, "i").test(txt);
    }) || null;

    // STATUS
    let status = "—";
    if (header) {
      const headerTxt = norm(header.textContent || "");
      if (/\bONLINE\b/i.test(headerTxt)) status = "Online";
      else if (/\bOFFLINE\b/i.test(headerTxt)) status = "Offline";

      if (status === "—") {
        const img = header.querySelector('img[alt]');
        const alt = img?.getAttribute("alt") || "";
        if (/^online$/i.test(alt)) status = "Online";
        else if (/^offline$/i.test(alt)) status = "Offline";
      }
    }

    // LOCATION
    const pickLocation = (root) => {
      const spans = Array.from(root.querySelectorAll('span, div, p'));
      for (let i = 0; i < spans.length; i++) {
        const t = norm(spans[i].textContent || "");
        if (/^Localiza(?:ç|c)ão\s*:?$|^Location\s*:?$|^Localização$/i.test(t)) {
          const next = spans[i].parentElement?.querySelector('span:nth-of-type(2)') ||
                       spans[i].nextElementSibling;
          const v = norm(next?.textContent || "");
          if (v) return v;
        }
      }
      const any = spans.find(el => /Localiza(?:ç|c)ão|Location/i.test(norm(el.textContent || "")));
      if (any) {
        const m = norm(any.textContent || "").match(/(?:Localiza(?:ç|c)ão|Location)\s*:?\s*(.+)$/i);
        if (m && m[1]) return norm(m[1]);
      }
      return null;
    };

    let location = "—";
    const infoRoot =
      document.querySelector('.CharPage_char-info__EW_Lb') ||
      document.querySelector('[class*="CharPage_char-info__"]') ||
      document;

    location = pickLocation(infoRoot) || "—";
    if (/^Lorencia$/i.test(location)) location = "Hidden 🔐";
    if (/^Noria$/i.test(location))    location = "Noria 🌸";

    const ok = (status !== "—") || (location && location !== "—");
    return { ok, status, location };
  }, nick);
}

/* ------------------------------ MAIN ------------------------------ */
(async () => {
  const list = await loadList();
  if (!list.length) {
    console.log("watchlist is empty");
    return;
  }
  const state = await loadState();

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

  // Roteamento: permite subdomínios do BASE e o script de challenge do Cloudflare
  const baseURL = new URL(BASE);
  const BASE_HOST = baseURL.host;                               // ex: mudream.online
  const BASE_DOMAIN = BASE_HOST.split('.').slice(-2).join('.'); // ex: mudream.online
  const allowHost = (h) => h === BASE_HOST || h.endsWith(`.${BASE_DOMAIN}`);

  await context.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url  = req.url();

    try {
      const u = new URL(url);
      const h = u.host;

      // Bloqueia trackers óbvios (por host)
      if (/(googletagmanager|google-analytics|gtag|facebook|hotjar|yandex|tiktok)/i.test(h)) {
        return route.abort();
      }

      // Permite o script de challenge do Cloudflare
      if (/^challenges\.cloudflare\.com$/i.test(h) && type === "script") {
        return route.continue();
      }

      // Permite JS/CSS/IMAGENS do domínio base e subdomínios (ex: static.mudream.online)
      if (["script","stylesheet","image"].includes(type) && (allowHost(h) || /^challenges\.cloudflare\.com$/i.test(h))) {
        return route.continue();
      }

      // Bloqueia terceiros pesados
      if (["script","stylesheet","image","font","media"].includes(type)) {
        return route.abort();
      }
    } catch {
      // data:, about: etc. — segue
    }
    return route.continue();
  });

  // aquecimento: cookies + X-50 + esperar Cloudflare
  const warm = await context.newPage();
  warm.setDefaultTimeout(5000);
  warm.setDefaultNavigationTimeout(15000);
  await warm.goto(`${BASE}/pt/`, { waitUntil: "load" });
  await waitCloudflare(warm, 10000).catch(() => {});
  await closeCookieBanner(warm).catch(() => {});
  await ensureX50Once(warm).catch(() => {});
  await warm.close();

  // pool de páginas
  const pages = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const p = await context.newPage();
    p.setDefaultTimeout(5000);
    p.setDefaultNavigationTimeout(15000);
    pages.push(p);
  }

  const changes = [];
  let idx = 0;

  async function processNick(page, nick) {
    const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitCloudflare(page, 10000);

    if (await isX5(page)) {
      await ensureX50Once(page).catch(() => {});
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitCloudflare(page, 8000);
    }

    await waitForHeader(page, nick, 6500);
    await page.waitForTimeout(150);

    // tenta extrair com re-tentativas progressivas
    const delays = [0, 250, 400, 600, 800];
    let data = { ok: false, status: '—', location: '—' };
    for (const d of delays) {
      if (d) await page.waitForTimeout(d);
      data = await extractOnce(page, nick);
      if (data.ok && data.location !== '—') break;
    }

    // reload + última tentativa
    if (!data.ok || data.location === '—') {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitCloudflare(page, 8000);
      await waitForHeader(page, nick, 2500);
      await page.waitForTimeout(200);
      data = await extractOnce(page, nick);
    }

    if (!data.ok) {
      if (process.env.DEBUG === '1') {
        try {
          const fn = `debug_${encodeURIComponent(nick)}_${Date.now()}.png`;
          await page.screenshot({ path: fn, fullPage: true });
          const htmlLen = (await page.content()).length;
          console.log(`DEBUG: screenshot=${fn} html.length=${htmlLen}`);
        } catch {}
      }
      return { ok: false, status: '—', location: '—', error: 'no-data' };
    }
    return data;
  }

  async function worker(p) {
    while (idx < list.length && Date.now() < HARD_DEADLINE) {
      const myIdx = idx++;
      const nick = list[myIdx];
      try {
        const cur = await processNick(p, nick);
        if (!cur.ok) {
          console.log(`skip ${nick}: ${cur.error || "no-data"}`);
        } else {
          const prev = state[nick] || {};
          const changed = prev.status !== cur.status || prev.location !== cur.location;
          if (changed) {
            const now = Date.now();
            changes.push({
              nick,
              ...cur,
              prevStatus: (prev.status ?? '—'),
              prevLocation: (prev.location ?? '—'),
              updatedAt: now
            });
            state[nick] = { status: cur.status, location: cur.location, updatedAt: now };
          } else {
            console.log(`no change ${nick}: status=${cur.status} loc=${cur.location}`);
          }
        }
      } catch (e) {
        console.log(`fail ${nick}: ${e?.message || e}`);
      }
      await p.waitForTimeout(80 + Math.random() * 120);
    }
    if (Date.now() >= HARD_DEADLINE) {
      console.log("time budget reached — exiting gracefully");
    }
  }

  await Promise.all(pages.map((p) => worker(p)));

  if (changes.length) {
    const statusChanges = changes.filter(c => c.prevStatus !== c.status).length;
    const locChangesOnly = changes.length - statusChanges;

    const embeds = changes.map((c) => {
      const statusChanged = c.prevStatus !== c.status;
      const color = statusChanged
        ? (c.status === 'Online' ? 0x2ecc71 : 0xe74c3c)
        : 0x3498db;

      const unix = Math.floor((c.updatedAt || Date.now()) / 1000);
      const url = `${BASE}${PATH}${encodeURIComponent(c.nick)}`;
      const statusLine = `**Status:** \`${c.prevStatus || '—'}\` → \`${c.status}\``;
      const locLine    = `**Location:** \`${c.prevLocation || '—'}\` → \`${c.location}\``;
      const titleEmoji = statusChanged ? (c.status === 'Online' ? '🟢' : '🔴') : '📍';

      return {
        title: `${titleEmoji} ${c.nick}`,
        url,
        color,
        description: `${statusLine}\n${locLine}\n\n⏱️ <t:${unix}:f> • <t:${unix}:R>`,
        footer: { text: `watcher v1.1 • GuildWar (X-50) • CONCURRENCY=${CONCURRENCY}` },
        timestamp: new Date(c.updatedAt || Date.now()).toISOString(),
      };
    });

    const header = `**Updates (${changes.length})** — ${statusChanges} of status, ${locChangesOnly} of location`;
    for (let i = 0; i < embeds.length; i += 10) {
      const slice = embeds.slice(i, i + 10);
      await postDiscord({
        username: "MU Watcher X-50",
        content: i === 0 ? header : undefined,
        embeds: slice,
      });
      await new Promise(r => setTimeout(r, 300));
    }
  } else {
    console.log("no changes to report");
  }

  await saveState(state);
  await Promise.all(pages.map(p => p.close()));
  await browser.close();
})();
