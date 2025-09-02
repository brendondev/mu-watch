// watcher v20 — batch único no Discord + localização robusta + X-50 estável + CSS liberado
import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

console.log("watcher version v20");

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

/* --------------- Page helpers --------------- */
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
      if (selectedTxt && /GUILDWAR/.test(selectedTxt)) {
        console.log(`ensureX50: already GUILDWAR`);
        return;
      }

      // abre o grupo selecionado (frequente X-5 CLASSIC)
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

// espera header com <b>nick</b> e a Localização com valor não-vazio
async function waitForHeaderAndLocation(page, nick, timeoutMs = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate((n) => {
      // header com o nick
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

      // bloco com informações (escopo primário)
      const infoRoot =
        document.querySelector('.CharPage_char-info__EW_Lb') ||
        document.querySelector('[class*="CharPage_char-info__"]') ||
        document;

      const spans = Array.from(infoRoot.querySelectorAll('span'));
      for (let i = 0; i < spans.length; i++) {
        const t = (spans[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (/^Localiza(?:ç|c)ão\s*:?\s*$/i.test(t)) {
          const next = spans[i].parentElement?.querySelectorAll('span')?.[1] || spans[i].nextElementSibling;
          const val = next && next.tagName?.toLowerCase() === 'span' ? (next.textContent || '').trim() : '';
          if (val.length > 0) return true;
        }
      }

      // fallback global (algumas páginas atrasam o escopo principal)
      const all = Array.from(document.querySelectorAll('span'));
      for (let i = 0; i < all.length; i++) {
        const t = (all[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (/^Localiza(?:ç|c)ão\s*:?\s*$/i.test(t)) {
          const next = all[i].parentElement?.querySelectorAll('span')?.[1] || all[i].nextElementSibling;
          const val = next && next.tagName?.toLowerCase() === 'span' ? (next.textContent || '').trim() : '';
          if (val.length > 0) return true;
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
    // STATUS — ícone no header do <b>{nick}</b>
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

    // LOCALIZAÇÃO — procurar no escopo char-info; fallback global
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

/* ------------------------------ MAIN ------------------------------ */
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

  // Bloqueio leve: NÃO corta stylesheet (evita render travado); corta só image/font/media
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media"].includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(3200);
  page.setDefaultNavigationTimeout(9000);

  // Home 1x: cookies + X-50 1x
  await page.goto(`${BASE}/pt/`, { waitUntil: "domcontentloaded" });
  await closeCookieBanner(page).catch(() => {});
  await ensureX50Once(page).catch(() => {});

  const changes = [];
  for (const nick of list) {
    const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // se caiu em X-5, corrige rápido e volta
    const stillX5 = await page.evaluate(() => {
      const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
      const txt = (sel?.textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
      return !/GUILDWAR/.test(txt);
    }).catch(() => false);
    if (stillX5) {
      await ensureX50Once(page).catch(() => {});
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }

    // espera header + localização com valor
    await waitForHeaderAndLocation(page, nick, 9000);
    // pequena margem p/ SPA pintar
    await page.waitForTimeout(200);

    // tenta extrair, com 2 pequenas re-tentativas se location sair em branco
    let cur = await extractFast(page, nick);
    if (cur.location === '—') {
      await page.waitForTimeout(500);
      cur = await extractFast(page, nick);
      if (cur.location === '—') {
        await page.waitForTimeout(700);
        cur = await extractFast(page, nick);
      }
    }

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

    // jitter mínimo entre perfis (evita CF heurística)
    await page.waitForTimeout(90 + Math.random() * 90);
  }

  // Posta em lote (1 ou mais mensagens se exceder 2k chars)
  if (changes.length) {
    const blocks = changes.map(c => `**${c.nick}**\n• Status: ${c.status}\n• Location: ${c.location}`);
    const payload = blocks.join("\n\n");
    for (const part of chunkText(payload, 1800)) {
      await postDiscord(part);
      await new Promise(r => setTimeout(r, 250)); // respiro entre mensagens
    }
  } else {
    console.log("no changes to report");
  }

  await saveState(state);
  await browser.close();
})();
