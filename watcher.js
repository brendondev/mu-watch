import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL; // obrig.
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL ausente");
  process.exit(1);
}

// ======================
// Função principal renderChar
// ======================
async function renderChar(nick) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR",
    extraHTTPHeaders: {
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "upgrade-insecure-requests": "1"
    },
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();

  // bloqueia imagens e fontes pra acelerar
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "font") return route.abort();
    return route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  // helper: detecta tela de proteção
  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(html);
  };

  const gotoOnce = async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // tenta esperar label de localização ou status
    const locLabel = page.locator("span", { hasText: /Localiza(ç|c)ão:/i });
    try {
      await locLabel.first().waitFor({ timeout: 20000 });
    } catch {
      const hasStatus = page.locator("span", { hasText: /Status:/i });
      await Promise.race([
        hasStatus.first().waitFor({ timeout: 8000 }),
        page.waitForTimeout(8000)
      ]);
    }
  };

  try {
    // primeira tentativa
    await gotoOnce();

    // se bateu challenge do Cloudflare
    if (await isAntiBot()) {
      await page.waitForTimeout(8000);
      await gotoOnce();
    }

    // extrair dados
    const data = await page.evaluate(() => {
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

      const statusFromLabel = (() => {
        const containers = Array.from(
          document.querySelectorAll("div,li,section,article")
        );
        for (const c of containers) {
          if (/Status:/i.test(c.textContent || "")) {
            const img = c.querySelector(
              'img[alt="Online"], img[alt="Offline"]'
            );
            if (img && img.getAttribute("alt")) return img.getAttribute("alt");
          }
        }
        const any = document.querySelector(
          'img[alt="Online"], img[alt="Offline"]'
        );
        return any ? any.getAttribute("alt") : null;
      })();

      const location = findByLabel(/Localiza(ç|c)ão:/i);

      return {
        ok: !!(statusFromLabel || location),
        status: statusFromLabel || "—",
        location: location || "—"
      };
    });

    await browser.close();
    return data;
  } catch (e) {
    await browser.close();
    return {
      ok: false,
      status: "—",
      location: "—",
      error: e.message || String(e)
    };
  }
}

// ======================
// utilitários de lista/estado
// ======================
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
    body: JSON.stringify({ content })
  });
}

// ======================
// main loop
// ======================
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
      ].filter(Boolean).join("\n");

      await postDiscord(msg);
      state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
    }
  }
  await saveState(state);
})();
