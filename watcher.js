// watcher v5 (seleção X-50 via menu de seta; status via alt/src)
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
  // bloqueia imagens/fontes (reduz carga; ícone ainda está no DOM)
  await page.route("**/*", route => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font") return route.abort();
    return route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  // fecha banner de cookies
  const closeCookieBanner = async () => {
    const tryClick = async sel => {
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
    for (const frame of page.frames()) {
      try {
        if (/usercentrics|consent|cookiebot/i.test(frame.url())) {
          const btn = frame
            .locator('button:has-text("Permitir todos"), button:has-text("Rejeitar")')
            .first();
          await btn.click({ timeout: 800 });
          return true;
        }
      } catch {}
    }
    return false;
  };

  // abre a seta do menu e escolhe GUILDWAR; confirma o selecionado
  const ensureX50 = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // clica na seta (open-btn) para abrir o menu
        const arrow = page.locator('svg.SideMenuServers_open-btn__Rsa_X').first();
        await arrow.waitFor({ timeout: 1500 });
        await arrow.click({ force: true, timeout: 1500 });
        // aguarda e clica em “GUILDWAR”
        const guildOption = page
          .locator('div.SideMenuServers_list-item__qzJXK', { hasText: "GUILDWAR" })
          .first();
        await guildOption.waitFor({ timeout: 2000 });
        await guildOption.click({ force: true, timeout: 1500 });
        // espera a seleção atualizar
        await page.waitForTimeout(3000);
        // confere o texto do item selecionado
        const selText = await page
          .locator('div.SideMenuServers_selected__zYRfa')
          .first()
          .innerText();
        const normalized = selText.replace(/\s+/g, "").toUpperCase();
        console.log(
          `ensureX50 attempt ${attempt} → selected: ${normalized}`,
        );
        if (/GUILDWAR/.test(normalized)) return;
      } catch (e) {
      }
    }
  };

  // detecta anti-bot
  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(html);
  };

  // extrai status via alt/src e localização via rótulo
  const extract = async () => {
    return await page.evaluate(() => {
      const findByLabel = re => {
        const spans = Array.from(document.querySelectorAll("span"));
        for (let i = 0; i < spans.length; i++) {
          const t = (spans[i].textContent || "").trim();
          if (re.test(t)) {
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
      // status pelo alt ou src
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
    await ensureX50().catch(() => {});
    await page.waitForTimeout(2000);
    let data = await extract();
    // se cair em tela de proteção, tenta de novo
    if (!data.ok && (await isAntiBot())) {
      await page.waitForTimeout(8000);
      await closeCookieBanner().catch(() => {});
      await ensureX50().catch(() => {});
      await page.waitForTimeout(2000);
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
    return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
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

// Loop principal: verifica cada nick e avisa se status/localização mudarem
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
        prev.location !== cur.location ? `• Localização: ${prev.location || "?"} → ${cur.location}` : null,
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
