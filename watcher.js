// watcher v4 (status por alt/src e X-50 garantido, sem waitFor de locator)
import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

console.log("watcher version v4");

if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL ausente");
  process.exit(1);
}

async function renderChar(nick) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR",
    extraHTTPHeaders: {
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1"
    },
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();

  // Bloqueia imagens/fontes pra acelerar (o <img> ainda existe no DOM com alt/src)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font") return route.abort();
    return route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  // Helpers ---------------------------------------------------
  const closeCookieBanner = async () => {
    const tryClick = async (sel) => {
      try { await page.locator(sel).first().click({ timeout: 700 }); return true; } catch { return false; }
    };
    if (await tryClick('button:has-text("Permitir todos")')) return true;
    if (await tryClick('button:has-text("Rejeitar")')) return true;
    if (await tryClick('text=Permitir todos')) return true;
    if (await tryClick('text=Rejeitar')) return true;

    // iframes (Usercentrics/Cookiebot)
    for (const f of page.frames()) {
      try {
        if (/usercentrics|consent|cookiebot/i.test(f.url())) {
          const btn = f.locator('button:has-text("Permitir todos"), button:has-text("Rejeitar")').first();
          await btn.click({ timeout: 800 });
          return true;
        }
      } catch {}
    }
    return false;
  };

  // abre X-5 e seleciona X-50; confirma que X-50 ficou selecionado
const ensure50x = async () => {
  const tryDomSwitch = async () => {
    return await page.evaluate(() => {
      const byText = (root, re) => {
        const els = root.querySelectorAll('div[class*="SideMenuServers_item"]');
        for (const el of els) {
          const txt = (el.textContent || "").trim();
          if (re.test(txt)) return el;
        }
        return null;
      };

      // 1) abrir/expandir grupo X - 5 (se tiver botão de expandir)
      const groupX5 = byText(document, /\bX\s*-\s*5\b/i);
      if (groupX5) {
        const btn = groupX5.querySelector('svg[class*="open-btn"]');
        (btn || groupX5).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }

      // 2) clicar item X - 50
      const item50 = byText(document, /\bX\s*-\s*50\b/i);
      if (item50) {
        item50.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }

      // 3) checar selecionado
      const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
      const selText = (sel?.textContent || "").trim();
      return {
        selectedIs50: /\bX\s*-\s*50\b/i.test(selText),
        selectedText: selText
      };
    });
  };

  let ok = false, last = { selectedIs50: false, selectedText: "" };
  for (let i = 0; i < 3; i++) {
    last = await tryDomSwitch();
    if (last.selectedIs50) { ok = true; break; }
    await page.waitForTimeout(600);
  }
  console.log("selected 50x:", ok, "selectedText:", last.selectedText);
};


  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(html);
  };

  const extract = async () => {
    return await page.evaluate(() => {
      const findByLabel = (labelRe) => {
        const spans = Array.from(document.querySelectorAll("span"));
        for (let i = 0; i < spans.length; i++) {
          const t = (spans[i].textContent || "").trim();
          if (labelRe.test(t)) {
            const next =
              spans[i].parentElement?.querySelectorAll("span")?.[1] ||
              spans[i].nextElementSibling;
            if (next?.tagName?.toLowerCase() === "span") {
              const val = (next.textContent || "").trim();
              if (val) return val;
            }
          }
        }
        return null;
      };

      // STATUS: detectar por alt OU pelo src do ícone (online/offline.png)
      const statusFromImg = (() => {
        const img =
          document.querySelector('img[alt="Online"], img[alt="Offline"]') ||
          document.querySelector('img[src*="/assets/images/online"], img[src*="/assets/images/offline"]');
        if (!img) return null;
        const alt = img.getAttribute("alt");
        if (alt) return alt;
        const src = img.getAttribute("src") || "";
        if (/online\.png/i.test(src)) return "Online";
        if (/offline\.png/i.test(src)) return "Offline";
        return null;
      })();

      const location = findByLabel(/Localiza(ç|c)ão:/i);

      return {
        ok: !!(statusFromImg || location),
        status: statusFromImg || "—",
        location: location || "—"
      };
    });
  };
  // -----------------------------------------------------------

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    await closeCookieBanner().catch(()=>{});
    await ensure50x().catch(()=>{});

    // tempo pra SPA montar após o switch
    await page.waitForTimeout(1500);

    let data = await extract();

    if (!data.ok && (await isAntiBot())) {
      await page.waitForTimeout(8000);
      await closeCookieBanner().catch(()=>{});
      await ensure50x().catch(()=>{});
      await page.waitForTimeout(1200);
      data = await extract();
    }

    await browser.close();
    return data.ok ? data : { ok: false, status: "—", location: "—", error: "conteúdo não encontrado" };
  } catch (e) {
    await browser.close();
    return { ok: false, status: "—", location: "—", error: e.message || String(e) };
  }
}

async function loadList() {
  try {
    const t = await fs.readFile(WATCHLIST_FILE, "utf8");
    return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); }
  catch { return {}; }
}

async function saveState(obj) {
  await fs.writeFile(STATE_FILE, JSON.stringify(obj), "utf8");
}

async function postDiscord(content) {
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content })
  });
}

(async () => {
  const list = await loadList();
  if (!list.length) { console.log("watchlist vazia"); return; }
  const state = await loadState();

  for (const nick of list) {
    const cur = await renderChar(nick);
    if (!cur.ok) { console.log(`falha ${nick}: ${cur.error || "sem dados"}`); continue; }

    const prev = state[nick] || {};
    const changed = prev.status !== cur.status || prev.location !== cur.location;

    if (changed) {
      const msg = [
        `**${nick}** mudou:`,
        prev.status !== cur.status ? `• Status: ${prev.status || "?"} → ${cur.status}` : null,
        prev.location !== cur.location ? `• Localização: ${prev.location || "?"} → ${cur.location}` : null,
      ].filter(Boolean).join("\n");

      await postDiscord(msg);
      state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
    }
  }
  await saveState(state);
})();
