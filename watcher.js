// watcher v18 — fast single-page, robust X-50, status anchored to nick, xhr allowed
import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

console.log("watcher version v18");

if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL is missing");
  process.exit(1);
}

/* ---------------------- utils: io ---------------------- */
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
async function postDiscord(content) {
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

/* ----------------- page helpers (fast) ----------------- */
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
        await btn.click({ timeout: 600 });
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
      if (selectedTxt && /GUILDWAR/.test(selectedTxt)) {
        console.log(`ensureX50: already GUILDWAR`);
        return;
      }

      // abre grupo selecionado (geralmente X-5 CLASSIC)
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('div[class*="SideMenuServers_item"]'));
        const sel = all.find(el => el.className.includes("SideMenuServers_selected")) || all[0];
        if (sel) sel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForTimeout(220);

      // clica na opção GUILDWAR (X-50)
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

      if (ok) {
        console.log(`ensureX50 attempt ${i}: OK (GUILDWAR selected)`);
        return;
      } else {
        const selTxt = await page.evaluate(() => {
          const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
          return (sel?.textContent || "").replace(/\s+/g, " ").trim();
        });
        console.log(`ensureX50 attempt ${i}: still not GUILDWAR → selectedText: ${selTxt}`);
      }
    } catch (e) {
      console.log(`ensureX50 attempt ${i} error: ${e?.message || e}`);
    }
    await page.waitForTimeout(220);
  }
}

async function waitForHeaderAndLocation(page, nick, timeoutMs = 4000) {
  // espera o header com o <b>nick</b> e a label Localização com valor
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate((n) => {
      // header com o nick
      const containers = Array.from(document.querySelectorAll('.CharPage_name__wtExV, [class*="CharPage_name__"], .CharPage_name-block__nxxRU, [class*="CharPage_name-block__"]'));
      const hasNick = containers.some(c => new RegExp(`\\b${n}\\b`, 'i').test(c.textContent || ''));
      if (!hasNick) return false;

      // localização preenchida
      const spans = Array.from(document.querySelectorAll('span'));
      for (const s of spans) {
        const t = (s.textContent || '').trim();
        if (/^Localiza(?:ç|c)ão:$/.test(t)) {
          const next = s.parentElement?.querySelectorAll('span')?.[1] || s.nextElementSibling;
          const val = next && next.tagName?.toLowerCase() === 'span' ? (next.textContent || '').trim() : '';
          return val.length > 0;
        }
      }
      return false;
    }, nick).catch(() => false);

    if (ok) return;
    await page.waitForTimeout(150);
  }
}

async function extractFast(page, nick) {
  return await page.evaluate((n) => {
    // STATUS — somente na linha que contém o <b>{nick}</b>
    let status = null;
    const nameBlocks = Array.from(document.querySelectorAll('.CharPage_name__wtExV, [class*="CharPage_name__"], .CharPage_name-block__nxxRU, [class*="CharPage_name-block__"]'));
    const header = nameBlocks.find(c => {
      const b = c.querySelector('b');
      const txt = (b?.textContent || c.textContent || '').trim();
      return new RegExp(`\\b${n}\\b`, 'i').test(txt);
    }) || null;

    if (header) {
      const img = header.querySelector('img[alt="Online"], img[alt="Offline"]');
      if (img) status = img.getAttribute('alt') || null;
    }

    if (!status) {
      // fallback: nenhum status
      status = '—';
    }

    // LOCALIZAÇÃO — par label/valor
    let location = '—';
    const spans = Array.from(document.querySelectorAll('span'));
    for (let i = 0; i < spans.length; i++) {
      const t = (spans[i].textContent || '').trim();
      if (/^Localiza(?:ç|c)ão:$/i.test(t)) {
        const next = spans[i].parentElement?.querySelectorAll('span')?.[1] || spans[i].nextElementSibling;
        if (next && next.tagName?.toLowerCase() === 'span') {
          location = (next.textContent || '').trim() || '—';
        }
        break;
      }
    }

    if (/^Lorencia$/i.test(location)) location = 'Privada';

    return { ok: (status !== '—' || (location && location !== '—')), status, location };
  }, nick);
}

/* ------------------------------ main ------------------------------ */
(async () => {
  const list = await loadList();
  if (!list.length) {
    console.log("watchlist is empty");
    return;
  }
  const state = await loadState();

  // 1 navegador / 1 contexto / 1 aba
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

  // Bloqueio: só corta image/font/media/stylesheet; deixa script/xhr/fetch/document liberados (qualquer host)
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media", "stylesheet"].includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(2500);
  page.setDefaultNavigationTimeout(8000);

  // Home 1x: cookies + X-50 1x
  await page.goto(`${BASE}/pt/`, { waitUntil: "domcontentloaded" });
  await closeCookieBanner(page).catch(() => {});
  await ensureX50Once(page).catch(() => {});

  const changes = [];
  for (const nick of list) {
    const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // se por algum motivo voltou pro X-5, corrige rápido
    const stillX5 = await page.evaluate(() => {
      const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
      const txt = (sel?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
      return !/GUILDWAR/.test(txt);
    }).catch(() => false);
    if (stillX5) {
      await ensureX50Once(page).catch(() => {});
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }

    await waitForHeaderAndLocation(page, nick, 3500);
    const cur = await extractFast(page, nick);

    if (!cur.ok) {
      console.log(`skip ${nick}: no data`);
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

    await page.waitForTimeout(110 + Math.random() * 120);
  }

  if (changes.length) {
    const lines = [];
    for (const c of changes) {
      lines.push(`**${c.nick}**`);
      lines.push(`• Status: ${c.status}`);
      lines.push(`• Location: ${c.location}`);
      lines.push("");
    }
    await postDiscord(lines.join("\n").trim());
  } else {
    console.log("no changes to report");
  }

  await saveState(state);
  await browser.close();
})();
