// watcher v17 — fixa seleção X-50 via DOM (sem waitForSelector) + header-anchored status/location + state
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

console.log("watcher version v17");
if (!WEBHOOK) { console.error("DISCORD_WEBHOOK_URL ausente"); process.exit(1); }

/* ------------------ FS & Discord ------------------ */
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

/* ------------------ Scraper core ------------------ */
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

  // Acelera: não carregar fontes/imagens (o <img> com alt/src ainda fica no DOM)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "font" || t === "image") return route.abort();
    route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  const closeCookieBanner = async () => {
    const tryClick = async (sel) => {
      try { await page.locator(sel).first().click({ timeout: 500 }); return true; } catch { return false; }
    };
    if (await tryClick('button:has-text("Permitir todos")')) return;
    if (await tryClick('button:has-text("Rejeitar")')) return;
    if (await tryClick('text=Permitir todos')) return;
    if (await tryClick('text=Rejeitar')) return;
    for (const f of page.frames()) {
      try {
        if (/usercentrics|consent|cookiebot/i.test(f.url())) {
          await f.locator('button:has-text("Permitir todos"), button:has-text("Rejeitar")').first().click({ timeout: 700 });
          return;
        }
      } catch {}
    }
  };

  // Seleciona X-50 (“GUILDWAR”) usando somente DOM/dispatchEvent, com tentativas
  const ensureX50 = async () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ok = await page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
        const normSp = (s) => (s || "").toUpperCase();

        // 1) pega o item selecionado atual (normalmente CLASSIC / X-5)
        const selected = document.querySelector('div[class*="SideMenuServers_selected"]') ||
                         document.querySelector('div[class*="SideMenuServers_item"]');

        // função segura de clique
        const safeClick = (el) => {
          try {
            el.scrollIntoView({ block: "center", inline: "center" });
            el.style.removeProperty("display");
            el.style.visibility = "visible";
            el.style.opacity = "1";
            const evt = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
            el.dispatchEvent(evt);
            return true;
          } catch { return false; }
        };

        // já está em GUILDWAR?
        const selectedTxt = norm(selected?.textContent || "");
        if (/GUILDWAR|X-50/.test(selectedTxt)) return true;

        // 2) tenta abrir o grupo (chevron)
        if (selected) {
          const chevron = selected.querySelector('svg[class*="open-btn"]');
          if (chevron) safeClick(chevron);
          safeClick(selected);
        }

        // 3) procura o item "GUILDWAR" ou “X - 50”
        const items = Array.from(document.querySelectorAll('div[class*="SideMenuServers_item"], div[class*="SideMenuServers_list-item"]'));
        const target = items.find(el => /GUILDWAR/.test(norm(el.textContent || "")) || /X-50/.test(norm(el.textContent || "")) || /X\s*-\s*50/.test(normSp(el.textContent || "")));
        if (target) {
          safeClick(target);
        }

        // 4) checa novamente o selecionado
        const selNow = document.querySelector('div[class*="SideMenuServers_selected"]') || selected;
        const txt = norm(selNow?.textContent || "");
        return /GUILDWAR|X-50/.test(txt);
      });

      const selText = await page.evaluate(() => {
        const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
        return (sel?.textContent || "").replace(/\s+/g, "");
      });
      console.log(`ensureX50 attempt ${attempt} → selected: ${selText}`);

      if (ok) return true;
      await page.waitForTimeout(500 + attempt * 150);
    }
    return false;
  };

  const extractHeader = async (nickLower) => {
    return await page.evaluate((nickLower_) => {
      const norm = (s) => (s || "").trim().toLowerCase();

      // 1) <b>nick</b>
      const bNick = Array.from(document.querySelectorAll("b"))
        .find(b => norm(b.textContent) === nickLower_);
      if (!bNick) return { ok: false, status: null, location: null, reason: "nick-not-found" };

      // 2) header
      const header = bNick.closest('[class*="CharPage_char-header"]') ||
                     bNick.closest('[class*="CharPage_name-block"]') ||
                     bNick.parentElement;

      if (!header) return { ok: false, status: null, location: null, reason: "header-not-found" };

      // 3) status (ícone ao lado do nick)
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

      // 4) location (par de spans dentro do bloco info do header)
      let location = null;
      const info = header.querySelector('[class*="CharPage_char-info"]') || header;
      const spans = Array.from(info.querySelectorAll("span"));
      for (let i = 0; i < spans.length; i++) {
        const t = (spans[i].textContent || "").trim();
        if (/^Localiza(?:ç|c)ão:$/i.test(t) || /^Location:$/i.test(t)) {
          const sib = spans[i].nextElementSibling;
          if (sib && sib.tagName?.toLowerCase() === "span") {
            location = (sib.textContent || "").trim();
            break;
          }
          const inParent = spans[i].parentElement?.querySelectorAll("span");
          if (inParent && inParent.length >= 2) {
            location = (inParent[1].textContent || "").trim();
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

    // tenta forçar X-50 pelo DOM, sem travar a execução se falhar
    await page.waitForTimeout(700);
    const switched = await ensureX50().catch(()=>false);
    console.log(`X-50 switched: ${!!switched}`);

    // tempo para header hidratar
    await page.waitForTimeout(1200);

    // captura a partir do header do nick
    let data = await extractHeader(nick.trim().toLowerCase());
    if (!data.ok) {
      await page.waitForTimeout(1000);
      data = await extractHeader(nick.trim().toLowerCase());
    }

    await browser.close();
    return data.ok ? data : { ok: false, status: "—", location: "—", error: "content-not-found" };
  } catch (e) {
    await browser.close();
    return { ok: false, status: "—", location: "—", error: e.message || String(e) };
  }
}

/* ------------------ Main loop ------------------ */
(async () => {
  const list = await loadList();
  if (!list.length) { console.log("watchlist vazia"); return; }

  let state = await loadState();
  if (!state || typeof state !== "object") state = {};
  await saveState(state); // garante existência

  let changedAnything = false;

  for (const raw of list) {
    const nick = raw.trim();
    if (!nick) continue;

    const cur = await renderChar(nick);
    if (!cur.ok) { console.log(`falha ${nick}: ${cur.error || "sem dados"}`); continue; }

    const prev = state[nick] || {};
    const changed = prev.status !== cur.status || prev.location !== cur.location;

    // salva snapshot atual SEMPRE
    state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
    changedAnything ||= changed;

    if (changed) {
      const msg = [`**${nick}**`, `• Status: ${cur.status}`, `• Location: ${cur.location}`].join("\n");
      await postDiscord(msg);
      console.log(`notificado ${nick}: ${cur.status} / ${cur.location}`);
    } else {
      console.log(`sem mudança ${nick}: ${cur.status} / ${cur.location}`);
    }
  }

  if (changedAnything) {
    await saveState(state);
    console.log("state.json atualizado");
  }
})();
