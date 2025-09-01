// watcher v16 — restore X-50 selection + header-anchored status/location + state persistence
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

console.log("watcher version v16");

if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL is missing");
  process.exit(1);
}

/* ------------------------- FS + Discord utils ------------------------- */
async function ensureDirOf(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}
async function loadList() {
  try {
    const raw = await fs.readFile(WATCHLIST_FILE, "utf8");
    return raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}
async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); }
  catch { return {}; }
}
async function saveState(obj) {
  await ensureDirOf(STATE_FILE);
  await fs.writeFile(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
}
async function postDiscord(content) {
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

/* ---------------------------- Scraping core --------------------------- */
async function renderChar(nick) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR",
    extraHTTPHeaders: {
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1",
    },
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();

  // speed-up (alt/src remains in DOM)
  await page.route("**/*", route => {
    const t = route.request().resourceType();
    if (t === "font" || t === "image") return route.abort();
    return route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  const closeCookieBanner = async () => {
    const tryClick = async sel => {
      try { await page.locator(sel).first().click({ timeout: 700 }); return true; } catch { return false; }
    };
    if (await tryClick('button:has-text("Permitir todos")')) return;
    if (await tryClick('button:has-text("Rejeitar")')) return;
    if (await tryClick('text=Permitir todos')) return;
    if (await tryClick('text=Rejeitar')) return;
    for (const f of page.frames()) {
      try {
        if (/usercentrics|consent|cookiebot/i.test(f.url())) {
          await f.locator('button:has-text("Permitir todos"), button:has-text("Rejeitar")').first().click({ timeout: 800 });
          return;
        }
      } catch {}
    }
  };

  // robust “open X-5/CLASSIC” -> click “GUILDWAR” -> confirm selected shows GUILDWAR
  const ensureX50 = async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        // make sure left menu exists
        await page.waitForSelector('div[class*="SideMenuServers_item"]', { timeout: 3000 });

        // open group (CLASSIC / X - 5)
        const classic = page.locator('div[class*="SideMenuServers_item"]', { hasText: /CLASSIC|X\s*-\s*5/i }).first();
        await classic.scrollIntoViewIfNeeded().catch(() => {});
        // try chevron, otherwise click the block
        const chevron = classic.locator('svg[class*="open-btn"]').first();
        if (await chevron.count()) {
          await chevron.click({ force: true, timeout: 1200 }).catch(()=>{});
        } else {
          await classic.click({ force: true, timeout: 1200 }).catch(()=>{});
        }
        await page.waitForTimeout(400);

        // click GUILDWAR option (X - 50)
        const gw = page.locator('div[class*="SideMenuServers_item"], div[class*="SideMenuServers_list-item"]', { hasText: /GUILDWAR|X\s*-\s*50/i }).first();
        await gw.scrollIntoViewIfNeeded().catch(()=>{});
        await gw.click({ force: true, timeout: 2000 }).catch(()=>{});
        await page.waitForTimeout(700);

        // confirm selected label
        const selectedText = (await page.locator('div[class*="SideMenuServers_selected"]').first().innerText().catch(()=>"" )) || "";
        const normalized = selectedText.replace(/\s+/g, "").toUpperCase();
        console.log(`ensureX50 attempt ${attempt} → selected: ${normalized}`);
        if (/GUILDWAR|X-50/.test(normalized)) return;
      } catch (e) {
        console.log(`ensureX50 attempt ${attempt} error: ${e?.message || e}`);
      }
      await page.waitForTimeout(500);
    }
  };

  const extractHeader = async (nickLower) => {
    return await page.evaluate((nickLower_) => {
      const norm = (s) => (s || "").trim().toLowerCase();

      // 1) find <b>nick</b> in header
      const b = Array.from(document.querySelectorAll("b")).find(el => norm(el.textContent) === nickLower_);
      if (!b) return { ok: false, status: null, location: null, reason: "nick-not-found" };

      // 2) get header container
      const header = b.closest('[class*="CharPage_char-header"]') ||
                     b.closest('[class*="CharPage_name-block"]') ||
                     b.parentElement;

      if (!header) return { ok: false, status: null, location: null, reason: "header-not-found" };

      // 3) status icon near nick
      let status = null;
      const sImg = header.querySelector('img[alt="Online"], img[alt="Offline"]') ||
                   header.querySelector('img[src*="/assets/images/online"], img[src*="/assets/images/offline"]');
      if (sImg) {
        const alt = sImg.getAttribute("alt");
        if (alt) status = alt;
        else {
          const src = sImg.getAttribute("src") || "";
          if (/online\.png/i.test(src)) status = "Online";
          if (/offline\.png/i.test(src)) status = "Offline";
        }
      }

      // 4) location inside the same header block (CharPage_char-info…)
      let location = null;
      const infoBlock = header.querySelector('[class*="CharPage_char-info"]') || header;
      const spans = Array.from(infoBlock.querySelectorAll("span"));
      for (let i = 0; i < spans.length; i++) {
        const t = (spans[i].textContent || "").trim();
        if (/^Localiza(?:ç|c)ão:$/i.test(t) || /^Location:$/i.test(t)) {
          const next = spans[i].nextElementSibling;
          if (next && next.tagName?.toLowerCase() === "span") {
            location = (next.textContent || "").trim();
            break;
          }
          // fallback: second span in same parent
          const sibs = spans[i].parentElement?.querySelectorAll("span");
          if (sibs && sibs.length >= 2) {
            location = (sibs[1].textContent || "").trim();
            break;
          }
        }
      }

      if (location && /^\s*lorencia/i.test(location)) location = "Privada";

      return { ok: !!(status || location), status: status || "—", location: location || "—" };
    }, nickLower);
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await closeCookieBanner().catch(()=>{});

    // ensure side menu is ready, then force X-50
    await page.waitForTimeout(600);
    await ensureX50().catch(()=>{});

    // let SPA hydrate header
    await page.waitForSelector('div[class*="CharPage_char-header"]', { timeout: 6000 }).catch(()=>{});
    await page.waitForTimeout(900);

    let data = await extractHeader(nick.trim().toLowerCase());
    if (!data.ok) {
      await page.waitForTimeout(1200);
      data = await extractHeader(nick.trim().toLowerCase());
    }

    await browser.close();
    return data.ok ? data : { ok: false, status: "—", location: "—", error: "content-not-found" };
  } catch (e) {
    await browser.close();
    return { ok: false, status: "—", location: "—", error: e.message || String(e) };
  }
}

/* ------------------------------ Main loop ----------------------------- */
(async () => {
  const list = await loadList();
  if (!list.length) { console.log("watchlist is empty"); return; }

  let state = await loadState();
  if (!state || typeof state !== "object") state = {};
  await saveState(state); // make sure file exists

  let changedAnything = false;

  for (const raw of list) {
    const nick = raw.trim();
    if (!nick) continue;

    const cur = await renderChar(nick);
    if (!cur.ok) { console.log(`fail ${nick}: ${cur.error || "no data"}`); continue; }

    const prev = state[nick] || {};
    const changed = prev.status !== cur.status || prev.location !== cur.location;

    // persist current snapshot
    state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
    changedAnything ||= changed;

    if (changed) {
      const msg = [`**${nick}**`, `• Status: ${cur.status}`, `• Location: ${cur.location}`].join("\n");
      await postDiscord(msg);
      console.log(`notified ${nick}: ${cur.status} / ${cur.location}`);
    } else {
      console.log(`no change ${nick}: ${cur.status} / ${cur.location}`);
    }
  }

  if (changedAnything) {
    await saveState(state);
    console.log("state file updated");
  }
})();
