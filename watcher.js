// watcher v6 (location robusta + persistência do state por git opcional)
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

// persistência via git (set no workflow)
const GIT_PERSIST = process.env.GIT_PERSIST === "1";
const GIT_USER_NAME = process.env.GIT_USER_NAME || "bot";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || "bot@users.noreply.github.com";

console.log("watcher version v6");

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

  // bloqueia imagens/fontes (o <img> fica no DOM com alt/src)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font") return route.abort();
    return route.continue();
  });

  const url = `${BASE}${PATH}${encodeURIComponent(nick)}`;

  // --- helpers ---
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

  // abre a seta e escolhe GUILDWAR; confirma
  const ensureX50 = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const arrow = page.locator('svg.SideMenuServers_open-btn__Rsa_X').first();
        await arrow.waitFor({ timeout: 2000 });
        await arrow.click({ force: true, timeout: 1500 });

        const guildOption = page
          .locator('div.SideMenuServers_list-item__qzJXK', { hasText: "GUILDWAR" })
          .first();
        await guildOption.waitFor({ timeout: 2500 });
        await guildOption.click({ force: true, timeout: 1500 });

        await page.waitForTimeout(3000);

        const selText = await page
          .locator('div.SideMenuServers_selected__zYRfa')
          .first()
          .innerText()
          .catch(() => "");
        const normalized = (selText || "").replace(/\s+/g, "").toUpperCase();
        console.log(`ensureX50 → selected: ${normalized}`);
        if (/GUILDWAR/.test(normalized)) return;
      } catch (e) {
        console.log("ensureX50 error:", e?.message || e);
      }
    }
  };

  const isAntiBot = async () => {
    const html = await page.content();
    return /Just a moment|Checking your browser|cf-chl|Attention Required/i.test(html);
  };

  // EXTRAÇÃO ROBUSTA (localização + status)
  const extract = async () => {
    return await page.evaluate(() => {
      const norm = (s) =>
        (s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();

      // ===== Localização =====
      let location = null;

      // Varre containers plausíveis que contenham "Localização:"
      const containers = Array.from(document.querySelectorAll("div,section,article,li"));
      for (const el of containers) {
        const txtNorm = norm(el.textContent);
        if (!/Localizacao:/i.test(txtNorm)) continue;

        // 1) spans: label exato + próximo span
        const spans = Array.from(el.querySelectorAll("span"));
        if (spans.length) {
          // (a) label exato + próximo índice
          let idx = spans.findIndex((s) => /^Localiza(c|ç)ao:$/i.test(norm(s.textContent)));
          if (idx >= 0) {
            const next = spans[idx + 1];
            const val = next && norm(next.textContent);
            if (val) {
              location = (next.textContent || "").trim();
              break;
            }
          }
          // (b) fallback: primeiro span depois de um que contenha o label
          if (!location) {
            for (let i = 0; i < spans.length - 1; i++) {
              if (/^Localiza(c|ç)ao:$/i.test(norm(spans[i].textContent))) {
                const val = (spans[i + 1].textContent || "").trim();
                if (val) {
                  location = val;
                  break;
                }
              }
            }
            if (location) break;
          }
          // (c) último span do mesmo container (alguns layouts colocam o valor no fim)
          if (!location) {
            const last = spans[spans.length - 1];
            const val = (last?.textContent || "").trim();
            const hasLabel = spans.some((s) => /Localiza(c|ç)ao:/i.test(norm(s.textContent)));
            if (hasLabel && val && !/Localiza(c|ç)ao:/i.test(norm(val))) {
              location = val;
              break;
            }
          }
        }

        // 2) Fallback textual dentro do container
        if (!location) {
          const raw = (el.textContent || "").split(/Localiza(?:ção|cao):/i)[1];
          if (raw) {
            const val = raw.replace(/^[\s:\-]+/, "").split(/\n| {2,}|\t/)[0].trim();
            if (val) {
              location = val;
              break;
            }
          }
        }
      }

      // ===== Status (ícone Online/Offline) =====
      let status = null;
      const img =
        document.querySelector('img[alt="Online"], img[alt="Offline"]') ||
        document.querySelector('img[src*="/assets/images/online"], img[src*="/assets/images/offline"]');
      if (img) {
        const alt = img.getAttribute("alt");
        if (alt) status = alt;
        else {
          const src = img.getAttribute("src") || "";
          if (/online\.png/i.test(src)) status = "Online";
          else if (/offline\.png/i.test(src)) status = "Offline";
        }
      }

      return { ok: !!(status || location), status: status || "—", location: location || "—" };
    });
  };

  // --- fluxo principal da página ---
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await closeCookieBanner().catch(() => {});
    await ensureX50().catch(() => {});

    // dá um tempo pra SPA montar e injeta retry de localização
    await page.waitForTimeout(1200);

    let data = { ok: false, status: "—", location: "—" };
    for (let i = 0; i < 4; i++) {
      data = await extract();
      console.log(`extract try ${i + 1} → ok=${data.ok} status=${data.status} location=${data.location}`);
      if (data.location && data.location !== "—") break;
      await page.waitForTimeout(700);
    }

    // fallback anti-bot
    if (!data.ok && (await isAntiBot())) {
      await page.waitForTimeout(8000);
      await closeCookieBanner().catch(() => {});
      await ensureX50().catch(() => {});
      await page.waitForTimeout(1200);
      data = await extract();
      console.log(`extract (retry antibot) → ok=${data.ok} status=${data.status} location=${data.location}`);
    }

    await browser.close();
    return data.ok ? data : { ok: false, status: "—", location: "—", error: "conteúdo não encontrado" };
  } catch (e) {
    await browser.close();
    return { ok: false, status: "—", location: "—", error: e.message || String(e) };
  }
}

// ---------- estado / discord ----------
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

async function persistStateGit() {
  if (!GIT_PERSIST) return;
  try {
    await exec(`git config user.name "${GIT_USER_NAME}"`);
    await exec(`git config user.email "${GIT_USER_EMAIL}"`);
    // evita rejected: puxa antes
    try {
      await exec(`git pull --rebase`);
    } catch (e) {
      console.log("git pull --rebase falhou (segue mesmo assim):", e?.stdout || e?.message || String(e));
    }
    await exec(`git add ${STATE_FILE}`);
    // commit pode não ter mudanças — não falhe se não houver nada
    await exec(`git commit -m "chore(state): update ${new Date().toISOString()}" || true`);
    await exec(`git push`);
    console.log("state.json: commit + push OK");
  } catch (e) {
    console.error("persistStateGit error:", e?.stdout || e?.message || String(e));
  }
}

async function postDiscord(content) {
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`Webhook FAILED: ${res.status} ${res.statusText} :: ${body.slice(0, 200)}`);
    } else {
      console.log(`Webhook OK: ${res.status}`);
    }
  } catch (e) {
    console.error(`Webhook EXCEPTION: ${e.message || e}`);
  }
}

// ---------- loop principal ----------
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
    const firstTime = !("status" in prev) && !("location" in prev);
    const FORCE_POST = process.env.FORCE_POST === "1";

    if (changed || firstTime || FORCE_POST) {
      const lines = [
        `**${nick}**`,
        `• Status: ${prev.status || "?"} → ${cur.status}`,
        `• Localização: ${prev.location || "?"} → ${cur.location}`,
      ];
      await postDiscord(lines.join("\n"));
      state[nick] = { status: cur.status, location: cur.location, updatedAt: Date.now() };
    } else {
      console.log(`${nick} sem mudança (status=${cur.status}, loc=${cur.location})`);
    }
  }

  await saveState(state);
  await persistStateGit(); // <- com GIT_PERSIST=1, commita e dá push
})();
