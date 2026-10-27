// SiteGuard Kurzcheck als Cloudflare Worker.
// Ruft EINE öffentlich erreichbare Seite (plus robots.txt und sitemap.xml) ab
// und zeigt einen Bericht auf Deutsch. Kein Pentest, keine Rechtsberatung.

const UA = "SiteGuardKurzcheck/0.1 (manuelle Prüfung)";
const HOST_RE = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function get(url, opts = {}) {
  try {
    return await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
      ...opts,
    });
  } catch {
    return null;
  }
}

async function check(input) {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: "Die Adresse ist ungültig." };
  }
  if (!HOST_RE.test(u.hostname)) return { error: "Bitte eine öffentliche Domain angeben, z. B. beispiel.de." };

  const f = [];
  const add = (prio, where, what, step) => f.push({ prio, where, what, step });

  // http -> https
  const plain = await get("http://" + u.hostname, { redirect: "manual" });
  if (plain && plain.status < 300) {
    add("Hoch", "HTTPS", "Die http-Version leitet nicht auf https weiter.", "Weiterleitung auf https beim Hoster einrichten.");
  }

  const res = await get("https://" + u.hostname + u.pathname + u.search);
  if (!res || res.status >= 400) {
    add("Hoch", "Erreichbarkeit", `Seite nicht abrufbar (Status: ${res ? res.status : "keine Antwort"}).`, "Adresse und Hosting prüfen.");
    return { host: u.hostname, f };
  }
  const html = (await res.text()).slice(0, 500000);

  for (const [name, label] of [
    ["strict-transport-security", "HSTS"],
    ["x-content-type-options", "X-Content-Type-Options"],
    ["content-security-policy", "Content-Security-Policy"],
    ["referrer-policy", "Referrer-Policy"],
  ]) {
    if (!res.headers.get(name)) add("Mittel", "Sicherheits-Header", `${label} fehlt.`, `${label}-Header beim Hoster ergänzen lassen.`);
  }

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
  if (!title) add("Hoch", "SEO", "Kein Seitentitel gefunden.", "Einen klaren Titel (ca. 50-60 Zeichen) setzen.");
  else if (title.length > 65) add("Niedrig", "SEO", `Seitentitel ist lang (${title.length} Zeichen).`, "Auf ca. 60 Zeichen kürzen.");

  if (!/<meta[^>]+name=["']description["'][^>]*content=["'][^"']+/i.test(html))
    add("Mittel", "SEO", "Keine Meta-Beschreibung gefunden.", "Eine Beschreibung (ca. 120-155 Zeichen) ergänzen.");

  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  if (h1 === 0) add("Mittel", "SEO", "Keine H1-Überschrift gefunden.", "Eine H1 mit dem Hauptthema ergänzen.");
  else if (h1 > 1) add("Niedrig", "SEO", `${h1} H1-Überschriften gefunden.`, "Auf eine H1 pro Seite reduzieren.");

  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter((t) => !/\balt=["'][^"']+/i.test(t)).length;
  if (noAlt) add("Niedrig", "Barrierefreiheit", `${noAlt} von ${imgs.length} Bildern ohne Alt-Text.`, "Alt-Texte ergänzen.");

  if (!/<meta[^>]+name=["']viewport["']/i.test(html))
    add("Hoch", "Mobile Nutzbarkeit", "Kein Viewport-Meta-Tag gefunden.", "Viewport-Meta-Tag ergänzen.");

  const hrefs = (html.match(/href=["'][^"']+/gi) || []).join(" ").toLowerCase();
  if (!hrefs.includes("impressum")) add("Hoch", "Rechtliches", "Kein Link zum Impressum gefunden.", "Prüfen lassen, ob ein Impressum nötig und verlinkt ist.");
  if (!hrefs.includes("datenschutz")) add("Hoch", "Rechtliches", "Kein Link zur Datenschutzerklärung gefunden.", "Prüfen lassen, ob eine Datenschutzerklärung nötig ist.");

  const hosts = new Set();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)/gi)) {
    try {
      const h = new URL(m[1], "https://" + u.hostname).hostname;
      if (h !== u.hostname) hosts.add(h);
    } catch {}
  }
  if (hosts.size)
    add("Mittel", "Drittanbieter", "Externe Skripte von: " + [...hosts].slice(0, 8).join(", "),
      "Prüfen, ob jeder Dienst noch gebraucht wird und ob eine Einwilligung (Cookie-Banner) nötig ist.");

  const robots = await get("https://" + u.hostname + "/robots.txt");
  const robotsOk = !!robots && robots.status < 400;
  if (!robotsOk) add("Niedrig", "SEO", "Keine robots.txt gefunden.", "robots.txt anlegen.");
  let hasSitemap = false;
  if (robotsOk) {
    const rt = (await robots.text()).slice(0, 100000);
    hasSitemap = /^\s*sitemap:\s*\S+/im.test(rt);
  }
  if (!hasSitemap) {
    const sm = await get("https://" + u.hostname + "/sitemap.xml");
    hasSitemap = !!sm && sm.status < 400;
  }
  if (!hasSitemap) add("Niedrig", "SEO", "Keine Sitemap gefunden (weder in robots.txt noch unter /sitemap.xml).", "Sitemap erzeugen und bei der Google Search Console melden.");

  const order = { Hoch: 0, Mittel: 1, Niedrig: 2 };
  f.sort((a, b) => order[a.prio] - order[b.prio]);
  return { host: u.hostname, f };
}

function render(r) {
  if (r.error) return `<p class="err">${esc(r.error)}</p>`;
  let out = `<h2>Kurzcheck: ${esc(r.host)}</h2>`;
  out += `<p class="note">Automatisch erhobene Hinweise zu einer öffentlich erreichbaren Seite. Kein Penetrationstest, kein Sicherheitsaudit, keine Rechtsberatung. Bitte alle Befunde vor der Weitergabe manuell prüfen.</p>`;
  if (!r.f.length) return out + "<p>Keine Auffälligkeiten bei den geprüften Punkten.</p>";
  for (const x of r.f) {
    out += `<div class="card ${x.prio}"><b>${esc(x.prio)} · ${esc(x.where)}</b><p>${esc(x.what)}</p><p class="step">Nächster Schritt: ${esc(x.step)}</p></div>`;
  }
  return out;
}

function page(body, value = "") {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>SiteGuard Kurzcheck</title>
<style>
:root{--bg:#f7f9fc;--fg:#0f1f33;--card:#fff;--line:#dbe3ef;--blue:#1f5eff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1b2d;--fg:#e8eef8;--card:#162338;--line:#2a3a55}}
body{margin:0;padding:20px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:640px;margin-inline:auto}
h1{font-size:24px}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid var(--line);width:100%;box-sizing:border-box;margin-top:8px}
input{background:var(--card);color:var(--fg)}button{background:var(--blue);color:#fff;border:0;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0}
.card.Hoch{border-left-color:#e5484d}.card.Mittel{border-left-color:#f5a524}.card.Niedrig{border-left-color:#7aa2ff}
.card p{margin:4px 0}.step{opacity:.8;font-size:14px}.note{font-size:14px;opacity:.8}.err{color:#e5484d}
</style></head><body>
<h1>SiteGuard Kurzcheck</h1>
<form method="get"><input name="url" value="${esc(value)}" placeholder="beispiel.de" inputmode="url" autocapitalize="off" autocomplete="off"><button>Seite prüfen</button></form>
${body}
</body></html>`;
}

const respond = (body) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });

export default {
  async fetch(request) {
    const url = new URL(request.url).searchParams.get("url");
    if (!url) return respond(page(""));
    return respond(page(render(await check(url)), url));
  },
};
