// watcher v5 (seleção X‑50 robusta e status via alt/src)
import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

console.log("watcher version v5");

if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL ausente");
  process.exit(1);
}

async function renderChar(nick) {
  // inicia Playwright em modo headless
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

  // bloqueia imagens/fontes para acelerar (o <img> permanece no DOM)
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "font") return route.abort();
    return route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  // fecha cookie banner (botões “Permitir todos”, “Rejeitar” e iframes)
  const closeCookieBanner = async () => {
    const tryClick = async (sel) => {
      try {
        await page.locator(sel).first().click({ timeout: 700 });
        return true;
      } catch {
        return false;
      }
    };
    if (await tryClick('button:has-text("Permitir todos")')) return true;
    if (await tryClick('button:has-text("Rejeitar")')) return true;
    if (await tryClick('text=Permitir todos')) return true;
    if (await tryClick('text=Rejeitar')) return true;
    // verificação de iframes (Usercentrics/Cookiebot)
    for (const frame of page.frames()) {
      try {
        if (/usercentrics|consent|cookiebot/i.test(frame.url())) {
          const btn = frame
            .locator('button:has-text("Permitir todos"), button:has-text("Rejeitar")')
            .first();
          await btn.click({ timeout: 800 });
          return true;
        }
      } catch {
        /* nada */
      }
    }
    return false;
  };

  // abre o item selecionado “CLASSIC” e clica no list-item “GUILDWAR”; confirma o selecionado
  const ensure50x = async () => {
    // volta para o topo do side menu
    await page.evaluate(() => window.scrollTo(0, 0));

    const selectedIsGuildwar = async () => {
      return await page.evaluate(() => {
        const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
        if (!sel) return false;
        const txt = (sel.textContent || "").replace(/\s+/g, "").toUpperCase();
        return /GUILDWAR/.test(txt);
      });
    };

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        // 1) localizar o item atualmente selecionado (CLASSIC)
        const selected = page.locator('div[class*="SideMenuServers_selected"]').first();
        await selected.scrollIntoViewIfNeeded().catch(() => {});
        // 1a) clicar no chevron (open-btn) para expandir, ou no próprio item
        const openBtn = selected.locator('svg[class*="open-btn"]');
        if (await openBtn.count()) {
          await openBtn.first().click({ force: true, timeout: 600 }).catch(() => {});
        } else {
          await selected.click({ force: true, timeout: 600 }).catch(() => {});
        }
        await page.waitForTimeout(400);
        // 2) clicar no list-item “GUILDWAR”
        const gwItem = page
          .locator('div[class*="SideMenuServers_list-item"]', { hasText: "GUILDWAR" })
          .first();
        const gwAny = page
          .locator('div[class*="SideMenuServers_item"]', { hasText: "GUILDWAR" })
          .first();
        const target = (await gwItem.count()) ? gwItem : gwAny;
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await target.click({ force: true, timeout: 1200 }).catch(() => {});
        await page.waitForTimeout(700);
        // 3) verifica se selecionou GUILDWAR
        const ok = await selectedIsGuildwar();
        const selTxt = await page.evaluate(() => {
          const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
          return (sel?.textContent || "").replace(/\s+/g, "");
        });
        console.log(
          `ensure50x attempt ${attempt} → selected GUILDWAR: ${ok} selectedText: ${selTxt}`,
        );
        if (ok) return;
      } catch (e) {
        console.log(`ensure50x attempt ${attempt} error: ${e?.message || e}`);
      }
      await page.waitForTimeout(600);
    }
  };

  // detecta anti-bot
  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(html);
  };

  // extração de status/localização
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
      // status pelo alt ou src do ícone online/offline
      const statusFromImg = (() => {
        const img =
          document.querySelector('img[alt="Online"], img[alt="Offline"]') ||
          document.querySelector(
            'img[src*="/assets/images/online"], img[src*="/assets/images/offline"]',
          );
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
        location: location || "—",
      };
    });
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await closeCookieBanner().catch(() => {});
    await ensure50x().catch(() => {});
    await page.waitForTimeout(1500);
    let data = await extract();
    // fallback anti-bot
    if (!data.ok && (await isAntiBot())) {
      await page.waitForTimeout(8000);
      await closeCookieBanner().catch(() => {});
      await ensure50x().catch(() => {});
      await page.waitForTimeout(1200);
      data = await extract();
    }
    await browser.close();
    return data.ok
      ? data
      : { ok: false, status: "—", location: "—", error: "conteúdo não encontrado" };
  } catch (e) {
    await browser.close();
    return {
      ok: false,
      status: "—",
      location: "—",
      error: e.message || String(e),
    };
  }
}

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

// loop principal: verifica todos os nicks, extrai status/localização e avisa no Discord em caso de mudança
(async () => {
  const list = await loadList();
  if (!list.length) {
    console.log("watchlist vazia");
    return;
  }
  const state = await loadState();
  for (const nick of list) {
    const cur = await renderChar(nick);
    if (!cur.ok) {
      console.log(`falha ${nick}: ${cur.error || "sem dados"}`);
      continue;
    }
    const prev = state[nick] || {};
    const changed = prev.status !== cur.status || prev.location !== cur.location;
    if (changed) {
      const msg = [
        `**${nick}** mudou:`,
        prev.status !== cur.status ? `• Status: ${prev.status || "?"} → ${cur.status}` : null,
        prev.location !== cur.location
          ? `• Localização: ${prev.location || "?"} → ${cur.location}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      await postDiscord(msg);
      state[nick] = {
        status: cur.status,
        location: cur.location,
        updatedAt: Date.now(),
      };
    }
  }
  await saveState(state);
})();
