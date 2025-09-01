// watcher v15 — stable header-anchored scraping + state file persistence (English output)
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

console.log("watcher version v15");

if (!WEBHOOK) {
  console.error("DISCORD_WEBHOOK_URL is missing");
  process.exit(1);
}

// ---------- small utils ----------
async function ensureDirOf(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}
async function loadList() {
  try {
    const raw = await fs.readFile(WATCHLIST_FILE, "utf8");
    // supports comma or newline
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
async function loadState() {
  try {
    const txt = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return {};
  }
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

// ---------- scraping ----------
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

  // speed-ups (alt/src still available without loading the binary)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "font" || t === "image") return route.abort();
    route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  const closeCookieBanner = async () => {
    const tryClick = async (sel) => {
      try {
        await page.locator(sel).first().click({ timeout: 700 });
        return true;
      } catch {
        return false;
      }
    };
    if (await tryClick('button:has-text("Permitir todos")')) return;
    if (await tryClick('button:has-text("Rejeitar")')) return;
    if (await tryClick('text=Permitir todos')) return;
    if (await tryClick('text=Rejeitar')) return;

    for (const f of page.frames()) {
      try {
        if (/usercentrics|consent|cookiebot/i.test(f.url())) {
          await f
            .locator(
              'button:has-text("Permitir todos"), button:has-text("Rejeitar")'
            )
            .first()
            .click({ timeout: 800 });
          return;
        }
      } catch {}
    }
  };

  const extractHeaderData = async (nickLower) => {
    return await page.evaluate((nickLower_) => {
      const norm = (s) => (s || "").trim().toLowerCase();

      // 1) Find the <b>nick</b> element
      const bTags = Array.from(document.querySelectorAll("b"));
      const bNick =
        bTags.find((b) => norm(b.textContent) === nickLower_) || null;
      if (!bNick) {
        return { ok: false, status: null, location: null, reason: "nick-not-found" };
      }

      // 2) Anchor to the nearest header container
      const header =
        bNick.closest('[class*="CharPage_name-block"]') ||
        bNick.closest('[class*="CharPage_char-header"]') ||
        bNick.parentElement;

      if (!header) {
        return { ok: false, status: null, location: null, reason: "header-not-found" };
      }

      // 3) STATUS: the small status icon right beside the nick in the header
      let status = null;
      const statusImg =
        header.querySelector('img[alt="Online"], img[alt="Offline"]') ||
        header.querySelector(
          'img[src*="/assets/images/online"], img[src*="/assets/images/offline"]'
        );
      if (statusImg) {
        status =
          statusImg.getAttribute("alt") ||
          (/online\.png/i.test(statusImg.getAttribute("src") || "")
            ? "Online"
            : /offline\.png/i.test(statusImg.getAttribute("src") || "")
            ? "Offline"
            : null);
      }

      // 4) LOCATION: find the span "Localização:" closest to the header (same block)
      let location = null;

      // search inside the header block first
      const spanPairs = Array.from(header.querySelectorAll("span"));
      for (let i = 0; i < spanPairs.length; i++) {
        const t = (spanPairs[i].textContent || "").trim();
        if (/^Localiza(?:ç|c)ão:$/i.test(t) || /^Location:$/i.test(t)) {
          // prefer immediate next span
          const sibling =
            spanPairs[i].nextElementSibling &&
            spanPairs[i].nextElementSibling.tagName?.toLowerCase() === "span"
              ? spanPairs[i].nextElementSibling
              : null;

          if (sibling) {
            const val = (sibling.textContent || "").trim();
            if (val) {
              location = val;
              break;
            }
          }

          // fallback: 2nd span within same parent
          const inParent = spanPairs[i].parentElement?.querySelectorAll("span");
          if (inParent && inParent.length >= 2) {
            const val = (inParent[1].textContent || "").trim();
            if (val) {
              location = val;
              break;
            }
          }
        }
      }

      // final normalization for location
      if (location) {
        // mapping requested: any "Lorencia..." -> "Privada"
        if (/^\s*lorencia/i.test(location)) location = "Privada";
      }

      return {
        ok: !!(status || location),
        status: status || "—",
        location: location || "—",
      };
    }, nickLower);
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await closeCookieBanner().catch(() => {});
    // give the SPA some time to mount the header
    await page.waitForTimeout(1500);

    // main extraction (anchored to header with the nick)
    let data = await extractHeaderData(nick.trim().toLowerCase());

    // very light retry if nothing found yet (slow network / hydration)
    if (!data.ok) {
      await page.waitForTimeout(1200);
      data = await extractHeaderData(nick.trim().toLowerCase());
    }

    await browser.close();
    return data.ok
      ? data
      : { ok: false, status: "—", location: "—", error: "content-not-found" };
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

// ---------- main loop ----------
(async () => {
  const list = await loadList();
  if (!list.length) {
    console.log("watchlist is empty");
    return;
  }

  // Make sure state file exists (created if missing)
  let state = await loadState();
  if (!state || typeof state !== "object") state = {};
  await saveState(state); // create the file if it didn’t exist

  let updated = false;

  for (const raw of list) {
    const nick = raw.trim();
    if (!nick) continue;

    const cur = await renderChar(nick);
    if (!cur.ok) {
      console.log(`fail ${nick}: ${cur.error || "no data"}`);
      continue;
    }

    const prev = state[nick] || {};
    const changed = prev.status !== cur.status || prev.location !== cur.location;

    // Always update local state; only notify on change
    state[nick] = {
      status: cur.status,
      location: cur.location,
      updatedAt: Date.now(),
    };
    updated = true;

    if (changed) {
      const msg = [
        `**${nick}**`,
        `• Status: ${cur.status}`,
        `• Location: ${cur.location}`,
      ].join("\n");
      await postDiscord(msg);
      console.log(`notified ${nick}: ${cur.status} / ${cur.location}`);
    } else {
      console.log(`no change ${nick}: ${cur.status} / ${cur.location}`);
    }
  }

  if (updated) {
    await saveState(state);
    console.log("state file updated");
  }
})();
