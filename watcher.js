// watcher v16 — stable X-50 switch + anchored extraction (status & location)
import { chromium } from "playwright";
import fs from "fs/promises";
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

/* -------------------------- core render -------------------------- */
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

  // speed up: block images/fonts (DOM still has <img alt/src>)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font") return route.abort();
    return route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  /* -------------------------- helpers -------------------------- */
  const closeCookieBanner = async () => {
    const tryClick = async (sel) => {
      try {
        await page.locator(sel).first().click({ timeout: 800 });
        return true;
      } catch {
        return false;
      }
    };
    if (await tryClick('button:has-text("Permitir todos")')) return true;
    if (await tryClick('button:has-text("Rejeitar")')) return true;
    if (await tryClick('text=Permitir todos')) return true;
    if (await tryClick('text=Rejeitar')) return true;

    // iframe-based banners (Usercentrics/Cookiebot)
    for (const f of page.frames()) {
      try {
        if (/usercentrics|consent|cookiebot/i.test(f.url())) {
          const btn = f
            .locator('button:has-text("Permitir todos"), button:has-text("Rejeitar")')
            .first();
          await btn.click({ timeout: 800 });
          return true;
        }
      } catch {}
    }
    return false;
  };

  // Robust X-50: open the selected group then click item that contains "GUILDWAR"
  async function ensureX50(maxTries = 4) {
    for (let i = 1; i <= maxTries; i++) {
      try {
        await page.evaluate(() => window.scrollTo(0, 0));

        // open the currently selected server group (usually X - 5 CLASSIC)
        await page.evaluate(() => {
          const all = Array.from(
            document.querySelectorAll('div[class*="SideMenuServers_item"]')
          );
          const sel =
            all.find((el) => el.className.includes("SideMenuServers_selected")) ||
            all[0];
          if (sel) {
            sel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
        });

        await page.waitForTimeout(500);

        // click the GUILDWAR option
        await page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll('div[class*="SideMenuServers_item"]')
          );
          function norm(s) {
            return (s || "").replace(/\s+/g, " ").trim().toUpperCase();
          }
          const target =
            items.find((el) => /GUILDWAR/.test(norm(el.textContent))) ||
            items.find((el) => /X\s*-\s*50/.test(norm(el.textContent)));
          if (target) {
            target.scrollIntoView({ block: "center" });
            target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
        });

        // confirm selection turned into GUILDWAR
        const ok = await page.waitForFunction(() => {
          const sel = document.querySelector(
            'div[class*="SideMenuServers_selected"]'
          );
          const txt = (sel?.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .toUpperCase();
          return /GUILDWAR/.test(txt);
        }, { timeout: 2000 }).catch(() => false);

        if (ok) {
          console.log(`ensureX50 attempt ${i}: OK (GUILDWAR selected)`);
          return;
        } else {
          const selTxt = await page.evaluate(() => {
            const sel = document.querySelector(
              'div[class*="SideMenuServers_selected"]'
            );
            return (sel?.textContent || "").replace(/\s+/g, " ").trim();
          });
          console.log(
            `ensureX50 attempt ${i}: still not GUILDWAR → selectedText: ${selTxt}`
          );
        }
      } catch (e) {
        console.log(`ensureX50 attempt ${i} error: ${e?.message || e}`);
      }
      await page.waitForTimeout(600);
    }
  }

  // Wait until the "Localização:" label exists and the value span is non-empty
  async function waitForLocationReady(timeoutMs = 6000) {
    await page
      .waitForFunction(() => {
        const spans = Array.from(document.querySelectorAll("span"));
        for (const s of spans) {
          const t = (s.textContent || "").trim();
          if (/^Localiza(?:ç|c)ão:$/.test(t)) {
            const next = s.nextElementSibling;
            const val =
              next && next.tagName?.toLowerCase() === "span"
                ? (next.textContent || "").trim()
                : "";
            return val.length > 0;
          }
        }
        return false;
      }, { timeout: timeoutMs })
      .catch(() => {});
  }

  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(
      html
    );
  };

  // Extract ONLY from the character header and the exact Localização pair
  const extract = async () => {
    return await page.evaluate(() => {
      // 1) Status — the icon beside the nickname in the header
      let status = null;
      const nameRow = document.querySelector(
        '.CharPage_name__wtExV, [class*="CharPage_name__"]'
      );
      if (nameRow) {
        const statusImg = nameRow.querySelector(
          'img[alt="Online"], img[alt="Offline"]'
        );
        if (statusImg) status = statusImg.getAttribute("alt") || null;
      }
      if (!status) {
        const fallback = document.querySelector(
          'img[alt="Online"], img[alt="Offline"]'
        );
        if (fallback) status = fallback.getAttribute("alt");
      }

      // 2) Location — exact label "Localização:" then its sibling <span>
      let location = null;
      const spans = Array.from(document.querySelectorAll("span"));
      for (const s of spans) {
        const t = (s.textContent || "").trim();
        if (/^Localiza(?:ç|c)ão:$/.test(t)) {
          const next = s.nextElementSibling;
          if (next && next.tagName?.toLowerCase() === "span") {
            location = (next.textContent || "").trim();
            break;
          }
        }
      }

      // Normalize: Lorencia → Privada
      if (location && /lorencia/i.test(location)) location = "Privada";

      return {
        ok: !!(status || location),
        status: status || "—",
        location: location || "—",
      };
    });
  };

  /* -------------------------- flow -------------------------- */
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    await closeCookieBanner().catch(() => {});
    await ensureX50().catch(() => {});

    // Give the SPA time to render the header + location after switching
    await waitForLocationReady(6000);
    await page.waitForTimeout(400);

    let data = await extract();

    // Retry if Cloudflare page or still empty
    if (!data.ok && (await isAntiBot())) {
      await page.waitForTimeout(8000);
      await closeCookieBanner().catch(() => {});
      await ensureX50().catch(() => {});
      await waitForLocationReady(6000);
      await page.waitForTimeout(400);
      data = await extract();
    }

    await browser.close();
    return data.ok
      ? data
      : {
          ok: false,
          status: "—",
          location: "—",
          error: "content-not-found",
        };
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

/* ---------------------- list / state / notify ---------------------- */
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

/* ------------------------------ main ------------------------------ */
(async () => {
  const list = await loadList();
  if (!list.length) {
    console.log("watchlist is empty");
    return;
  }
  const state = await loadState();

  for (const nick of list) {
    const cur = await renderChar(nick);
    if (!cur.ok) {
      console.log(`fail ${nick}: ${cur.error || "no data"}`);
      continue;
    }

    const prev = state[nick] || {};
    const changed = prev.status !== cur.status || prev.location !== cur.location;

    if (changed) {
      const lines = [
        `**${nick}**`,
        `• Status: ${cur.status}`,
        `• Location: ${cur.location}`,
      ];
      await postDiscord(lines.join("\n"));
      state[nick] = {
        status: cur.status,
        location: cur.location,
        updatedAt: Date.now(),
      };
    }
  }

  await saveState(state);
})();
