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

async function renderChar(nick) {
  const browser = await chromium.launch({ args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage();
  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;
  await page.goto(url, { waitUntil: "networkidle" });

  const data = await page.evaluate(() => {
    const findByLabel = (re) => {
      const spans = Array.from(document.querySelectorAll("span"));
      for (let i = 0; i < spans.length; i++) {
        const t = (spans[i].textContent || "").trim();
        if (re.test(t)) {
          const next = spans[i].parentElement?.querySelectorAll("span")?.[1] || spans[i].nextElementSibling;
          if (next?.tagName?.toLowerCase() === "span") {
            const val = (next.textContent || "").trim();
            if (val) return val;
          }
        }
      }
      return null;
    };
    const status =
      document.querySelector('img[alt="Online"], img[alt="Offline"]')?.getAttribute("alt") || null;
    const location = findByLabel(/Localiza(ç|c)ão:/i);
    return { ok: !!(status || location), status: status || "—", location: location || "—" };
  });

  await browser.close();
  return data;
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
    body: JSON.stringify({ content })
  });
}

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
      console.log(`falha ${nick}`);
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
