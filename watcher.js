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

// abre o grupo "X - 5" (se necessário) e clica no item list "X - 50" (SideMenuServers_list-item__...)
// confirma seleção; repete até 4 tentativas
const ensure50x = async () => {
  // faz tudo no DOM para evitar timing de visibilidade
  const tryOnce = async () => {
    return await page.evaluate(() => {
      const hasClassPart = (el, part) =>
        !!Array.from((el.className || "").toString().split(/\s+/)).find(c => c.includes(part));

      // 1) encontrar container de lista/side menu pra poder rolar
      const side = Array.from(document.querySelectorAll("div"))
        .find(d => Array.from(d.querySelectorAll("div")).some(x => hasClassPart(x, "SideMenuServers_item")));
      if (side) side.scrollTop = 0;

      // 2) garantir que o grupo X - 5 está expandido (se tiver botão)
      const groups = Array.from(document.querySelectorAll('div'))
        .filter(el => hasClassPart(el, "SideMenuServers_item") && /\bX\s*-\s*5\b/i.test((el.textContent||"").trim()));
      if (groups.length) {
        const g = groups[0];
        const btn = g.querySelector('svg[class*="open-btn"]');
        if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        else g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }

      // 3) clicar no list-item X - 50 (classe: SideMenuServers_list-item__)
      const listItems = Array.from(document.querySelectorAll('div'))
        .filter(el => hasClassPart(el, "SideMenuServers_list-item") && /\bX\s*-\s*50\b/i.test((el.textContent||"").trim()));

      // caso não ache list-item, tenta qualquer item com texto X - 50
      const targets = listItems.length ? listItems : Array.from(document.querySelectorAll('div'))
        .filter(el => hasClassPart(el, "SideMenuServers_item") && /\bX\s*-\s*50\b/i.test((el.textContent||"").trim()));

      if (targets.length) {
        const t = targets[0];
        // rola até ele
        t.scrollIntoView({ block: "center", inline: "nearest" });
        // clica nele
        t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }

      // 4) verificar selecionado
      const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
      const selText = (sel?.textContent || "").replace(/\s+/g, "");
      const is50 = /X-50/i.test(selText); // normaliza sem espaços
      return { is50, selText };
    });
  };

  let ok = false, last = { is50: false, selText: "" };
  for (let i = 0; i < 4; i++) {
    last = await tryOnce();
    if (last.is50) { ok = true; break; }
    await page.waitForTimeout(700);
  }
  console.log("selected 50x:", ok, "selectedText:", last.selText);
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
