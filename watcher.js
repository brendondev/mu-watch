// watcher v14 — robust Location near nick header; "Lorencia" => "Privada"
import { chromium } from "playwright";
import fs from "fs/promises";
import fetch from "node-fetch";
import { exec as _exec } from "child_process";
import { promisify } from "util";
const exec = promisify(_exec);

const BASE = process.env.MU_BASE_URL || "https://mudream.online";
const PATH = process.env.MU_CHAR_PATH || "/pt/char/";
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WATCHLIST_FILE = process.env.WATCHLIST_FILE || "watchlist.txt";
const STATE_FILE = process.env.STATE_FILE || ".state.json";

const GIT_PERSIST = process.env.GIT_PERSIST === "1";
const GIT_USER_NAME = process.env.GIT_USER_NAME || "bot";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || "bot@users.noreply.github.com";

console.log("watcher version v14");
if (!WEBHOOK) { console.error("DISCORD_WEBHOOK_URL missing"); process.exit(1); }

const normalizePlain = (s) =>
  (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function mapLocation(value) {
  const n = normalizePlain(value).toLowerCase();
  if (n.startsWith("lorencia")) return "Privada";
  return value;
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

  // speed-up
  await page.route("**/*", (r) => {
    const t = r.request().resourceType();
    if (t === "image" || t === "font") return r.abort();
    return r.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  const closeCookieBanner = async () => {
    const tryClick = async (sel) => { try { await page.locator(sel).first().click({ timeout: 700 }); return true; } catch { return false; } };
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

  const ensureX50 = async () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const ok = await page.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
          const selected = document.querySelector('div[class*="SideMenuServers_selected"]');
          if (selected) {
            selected.scrollIntoView({ block: "center" });
            const arrow = selected.querySelector('svg[class*="open-btn"]');
            try { arrow?.click(); } catch {}
            try { selected.click(); } catch {}
          }
          const items = Array.from(document.querySelectorAll('div[class*="SideMenuServers_list-item"],div[class*="SideMenuServers_item"]'));
          const gw = items.find(el => /GUILDWAR/.test(norm(el.textContent)));
          if (gw) { gw.scrollIntoView({ block: "center" }); try { gw.style.display=""; } catch {}; try { gw.click(); } catch {} }
          const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
          return /GUILDWAR/.test(norm(sel?.textContent||""));
        });
        await page.waitForTimeout(450 + attempt * 150);
        if (ok) return;
      } catch {}
    }
  };

  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(html);
  };

  const extract = async () => {
    return await page.evaluate((nickIn) => {
      const nrm = (s) =>
        (s || "")
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .replace(/\u00A0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const eqNick = (a,b)=> nrm(a).toLowerCase() === nrm(b).toLowerCase();
      const isLocLabel = (txt) => nrm(txt).replace(/:\s*$/,"").toLowerCase() === "localizacao";

      // --- find header block (the one that contains <b>nick</b>) ---
      const allBlocks = Array.from(document.querySelectorAll("div,header,section,article"));
      let header = null;
      for (const el of allBlocks) {
        const b = el.querySelector("b");
        if (b && eqNick(b.textContent || "", nickIn)) { header = el; break; }
      }

      // STATUS from header img next to <b>nick</b>
      let status = null;
      if (header) {
        const img =
          header.querySelector('img[alt="Online"], img[alt="Offline"]') ||
          header.querySelector('img[src*="/assets/images/online"], img[src*="/assets/images/offline"]');
        if (img) {
          status = img.getAttribute("alt") ||
                   (/online\.png/i.test(img.getAttribute("src")||"") ? "Online" :
                    /offline\.png/i.test(img.getAttribute("src")||"") ? "Offline" : null);
        }
      }

      // LOCATION: choose the "Localização:" span whose container is NEAREST to header in DOM
      function distance(a, b) {
        if (!a || !b) return 1e9;
        // compute depth
        const path = (node) => { const arr=[]; while (node) { arr.push(node); node=node.parentElement; } return arr; };
        const pa = path(a), pb = path(b);
        // LCA distance
        let i = pa.length - 1, j = pb.length - 1, common = 0;
        while (i >= 0 && j >= 0 && pa[i] === pb[j]) { common++; i--; j--; }
        const da = pa.length - common, db = pb.length - common;
        return da + db;
      }

      let location = null;
      let bestDist = 1e9;

      const candidateSpans = Array.from(document.querySelectorAll("span")).filter(sp => isLocLabel(sp.textContent || ""));
      for (const sp of candidateSpans) {
        // value = next sibling span OR next span inside same container
        let val = null;

        // sibling chain
        let sib = sp.nextElementSibling;
        while (sib && sib.tagName && sib.tagName.toLowerCase() !== "span") sib = sib.nextElementSibling;
        if (sib && sib.tagName?.toLowerCase() === "span") {
          const v = (sib.textContent || "").trim();
          if (v) val = v;
        }

        // fallback: any following span in same container
        if (!val) {
          const cont = sp.parentElement;
          const spans = cont ? Array.from(cont.querySelectorAll("span")) : [];
          const idx = spans.indexOf(sp);
          for (let k = idx + 1; k < spans.length; k++) {
            const v = (spans[k].textContent || "").trim();
            if (v) { val = v; break; }
          }
        }

        if (val) {
          const d = distance(header, sp);
          if (d < bestDist) { bestDist = d; location = val; }
        }
      }

      return { ok: !!(status || location), status: status || "—", location: location || "—" };
    }, nick);
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await closeCookieBanner().catch(() => {});
    await ensureX50().catch(() => {});
    await page.waitForTimeout(1200);

    let data = { ok: false, status: "—", location: "—" };
    for (let i = 0; i < 5; i++) {
      data = await extract();
      console.log(`extract try ${i+1} → ok=${data.ok} status=${data.status} location=${data.location}`);
      if (data.location !== "—" || data.status !== "—") break;
      await page.waitForTimeout(700);
    }

    if (!data.ok && (await isAntiBot())) {
      await page.waitForTimeout(8000);
      await closeCookieBanner().catch(() => {});
      await ensureX50().catch(() => {});
      await page.waitForTimeout(1200);
      data = await extract();
      console.log(`extract (anti-bot) → ok=${data.ok} status=${data.status} location=${data.location}`);
    }

    await browser.close();

    if (data.location && data.location !== "—") {
      data.location = mapLocation(data.location);
    }
    return data.ok ? data : { ok: false, status: "—", location: "—", error: "content not found" };
  } catch (e) {
    await browser.close();
    return { ok: false, status: "—", location: "—", error: e.message || String(e) };
  }
}

/* ---------------- state / discord ---------------- */
async function loadList() { try { const t = await fs.readFile(WATCHLIST_FILE, "utf8"); return t.split(/\r?\n/).map(s=>s.trim()).filter(Boolean); } catch { return []; } }
async function loadState() { try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { return {}; } }
async function saveState(obj) { await fs.writeFile(STATE_FILE, JSON.stringify(obj), "utf8"); }
async function persistStateGit() {
  if (!GIT_PERSIST) return;
  try {
    await exec(`git config user.name "${GIT_USER_NAME}"`);
    await exec(`git config user.email "${GIT_USER_EMAIL}"`);
    try { await exec(`git pull --rebase`); } catch {}
    await exec(`git add ${STATE_FILE}`);
    await exec(`git commit -m "chore(state): update ${new Date().toISOString()}" || true`);
    await exec(`git push`);
    console.log("state.json: commit + push OK");
  } catch (e) { console.error("persistStateGit error:", e?.stdout || e?.message || String(e)); }
}
async function postDiscord(content) {
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  } catch (e) { console.error(`Webhook exception: ${e.message || e}`); }
}

/* ---------------- main ---------------- */
(async () => {
  const list = await loadList();
  if (!list.length) { console.log("watchlist is empty"); return; }

  const state = await loadState();

  for (const nick of list) {
    const cur = await renderChar(nick);
    if (!cur.ok) { console.log(`fail ${nick}: ${cur.error || "no data"}`); continue; }

    const msg = [`**${nick}**`, `• Status: ${cur.status}`, `• Location: ${cur.location}`].join("\n");
    await postDiscord(msg);

    state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
  }

  await saveState(state);
  if (GIT_PERSIST) await persistStateGit();
})();
