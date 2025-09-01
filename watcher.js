// watcher v8 (força abrir GUILDWAR via DOM + status do bloco de info)
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

console.log("watcher version v8");
if (!WEBHOOK) { console.error("DISCORD_WEBHOOK_URL ausente"); process.exit(1); }

async function renderChar(nick) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR",
    extraHTTPHeaders: { "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7", "upgrade-insecure-requests": "1" },
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();

  // Bloqueia imagens/fontes (o <img> continua no DOM com alt/src)
  await page.route("**/*", r => {
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

  // Abre a lista e clica GUILDWAR com DOM-level click (funciona mesmo hidden)
  const ensureX50 = async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const ok = await page.evaluate(() => {
          const norm = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
          // 1) acha o bloco selecionado (geralmente "X - 5 CLASSIC")
          const selected = document.querySelector('div[class*="SideMenuServers_selected"]');
          if (selected) {
            // tenta seta
            const arrow = selected.querySelector('svg[class*="open-btn"]');
            if (arrow) arrow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            // fallback: clica no próprio bloco
            selected.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
          // 2) acha qualquer list-item com GUILDWAR
          const items = Array.from(document.querySelectorAll('div[class*="SideMenuServers_list-item"],div[class*="SideMenuServers_item"]'));
          const gw = items.find(el => /GUILDWAR/.test(norm(el.textContent)));
          if (gw) {
            // remove display:none se houver e clica
            (gw.style && (gw.style.display = "block"));
            gw.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
          // 3) confirma texto do selecionado atualizado
          const sel = document.querySelector('div[class*="SideMenuServers_selected"]');
          const txt = norm(sel?.textContent || "");
          return /GUILDWAR/.test(txt);
        });
        // pequeno wait para SPA aplicar
        await page.waitForTimeout(500 + attempt * 200);
        const selText = await page.locator('div.SideMenuServers_selected__zYRfa').first().innerText().catch(()=>"");
        const normalized = (selText || "").replace(/\s+/g, "").toUpperCase();
        console.log(`ensureX50 attempt ${attempt} → selected: ${normalized}`);
        if (ok || /GUILDWAR/.test(normalized)) return;
      } catch (e) {
        console.log("ensureX50 error:", e?.message || e);
      }
    }
  };

  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(html);
  };

  // Extrai do bloco que contém “Localização:” e, se possível, do rótulo “Status:”
  const extract = async () => {
    return await page.evaluate(() => {
      const normA = (s) =>
        (s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();

      const hasLabel = (el, labelRe) =>
        Array.from(el.querySelectorAll("span")).some((s) => labelRe.test(normA(s.textContent)));

      // 1) acha o container de info (tem "Localização:")
      const containers = Array.from(document.querySelectorAll("div,section,article,li"));
      let info = null;
      for (const el of containers) {
        if (/Localizacao:/i.test(normA(el.textContent || ""))) { info = el; break; }
      }
      if (!info) return { ok: false, status: "—", location: "—" };

      // 2) Localização (mesma lógica robusta)
      let location = null;
      const spans = Array.from(info.querySelectorAll("span"));
      if (spans.length) {
        let idx = spans.findIndex((s) => /^Localiza(c|ç)ao:$/i.test(normA(s.textContent)));
        if (idx >= 0) {
          const next = spans[idx + 1];
          const val = next && (next.textContent || "").trim();
          if (val) location = val;
        }
        if (!location) {
          for (let i = 0; i < spans.length - 1; i++) {
            if (/^Localiza(c|ç)ao:$/i.test(normA(spans[i].textContent))) {
              const val = (spans[i + 1].textContent || "").trim();
              if (val) { location = val; break; }
            }
          }
        }
        if (!location) {
          const last = spans[spans.length - 1];
          const val = (last?.textContent || "").trim();
          const hasLoc = spans.some((s) => /Localiza(c|ç)ao:/i.test(normA(s.textContent)));
          if (hasLoc && val && !/Localiza(c|ç)ao:/i.test(normA(val))) location = val;
        }
      }
      if (!location) {
        const raw = (info.textContent || "").split(/Localiza(?:ção|cao):/i)[1];
        if (raw) {
          const val = raw.replace(/^[\s:\-]+/, "").split(/\n| {2,}|\t/)[0].trim();
          if (val) location = val;
        }
      }

      // 3) Status — PRIORIDADE: rótulo "Status:" dentro do mesmo bloco
      let status = null;
      if (hasLabel(info, /Status:/i)) {
        const sps = Array.from(info.querySelectorAll("span"));
        for (let i = 0; i < sps.length; i++) {
          if (/^Status:$/i.test(normA(sps[i].textContent))) {
            // próximo IMG alt ou src, ou texto do próximo span
            const nextImg = sps[i].parentElement?.querySelector('img[alt="Online"], img[alt="Offline"]');
            if (nextImg) {
              status = nextImg.getAttribute("alt") ||
                       (/online\.png/i.test(nextImg.getAttribute("src") || "") ? "Online"
                         : /offline\.png/i.test(nextImg.getAttribute("src") || "") ? "Offline" : null);
              if (status) break;
            }
            const nextSpan = sps[i + 1];
            if (!status && nextSpan) {
              const txt = (nextSpan.textContent || "").trim();
              if (/^Online$/i.test(txt)) { status = "Online"; break; }
              if (/^Offline$/i.test(txt)) { status = "Offline"; break; }
            }
          }
        }
      }

      // 4) Fallback: IMG dentro do bloco info (evita pegar ícones do menu)
      if (!status) {
        const inInfo =
          info.querySelector('img[alt="Online"], img[alt="Offline"]') ||
          info.querySelector('img[src*="/assets/images/online"], img[src*="/assets/images/offline"]');
        if (inInfo) {
          status = inInfo.getAttribute("alt") ||
                   (/online\.png/i.test(inInfo.getAttribute("src") || "") ? "Online"
                     : /offline\.png/i.test(inInfo.getAttribute("src") || "") ? "Offline" : null);
        }
      }

      return { ok: !!(status || location), status: status || "—", location: location || "—" };
    });
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await closeCookieBanner().catch(() => {});
    await ensureX50().catch(() => {});
    await page.waitForTimeout(1200);

    // retry curto
    let data = { ok: false, status: "—", location: "—" };
    for (let i = 0; i < 4; i++) {
      data = await extract();
      console.log(`extract try ${i + 1} → ok=${data.ok} status=${data.status} location=${data.location}`);
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
    return data.ok ? data : { ok: false, status: "—", location: "—", error: "conteúdo não encontrado" };
  } catch (e) {
    await browser.close();
    return { ok: false, status: "—", location: "—", error: e.message || String(e) };
  }
}

// ---------- estado / discord ----------
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
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (e) { console.error(`Webhook EXCEPTION: ${e.message || e}`); }
}

// ---------- loop principal ----------
(async () => {
  const list = await loadList();
  if (!list.length) { console.log("watchlist vazia"); return; }

  const state = await loadState();

  for (const nick of list) {
    const cur = await renderChar(nick);
    if (!cur.ok) { console.log(`falha ${nick}: ${cur.error || "sem dados"}`); continue; }

    const prev = state[nick] || {};
    const changed = prev.status !== cur.status || prev.location !== cur.location;
    const firstTime = !("status" in prev) && !("location" in prev);
    const FORCE_POST = process.env.FORCE_POST === "1";

    if (changed || firstTime || FORCE_POST) {
      const msg = [
        `**${nick}**`,
        `• Status: ${prev.status || "?"} → ${cur.status}`,
        `• Localização: ${prev.location || "?"} → ${cur.location}`,
      ].join("\n");
      await postDiscord(msg);
      state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
    } else {
      console.log(`${nick} sem mudança (status=${cur.status}, loc=${cur.location})`);
    }
  }

  await saveState(state);
  await persistStateGit();
})();
