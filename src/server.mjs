// HTTP-сервис: отдаёт два price-list.xml по постоянным ссылкам.
//   /centersna.xml — магазин Centersna, только матрасы
//   /matras.xml    — магазин 30378397, всё кроме матрасов
//   /health        — JSON со статистикой последней сборки
//   /              — то же человеческим языком
//
// Kaspi ходит по ссылке примерно раз в час и забирает файл целиком.
// Поэтому сервис держит последнюю УСПЕШНУЮ сборку в памяти и отдаёт её,
// даже если очередная пересборка упала: пустой или обрезанный ответ
// снимет с продажи весь ассортимент.
import http from "node:http";
import { build, SHOPS } from "./merge.mjs";

const PORT = Number(process.env.PORT) || 8080;
const REBUILD_MINUTES = Number(process.env.REBUILD_MINUTES) || 15;

const state = {
  docs: null,        // route -> xml, только успешная сборка
  meta: null,        // статистика успешной сборки
  builtAt: null,     // когда собрано
  lastTry: null,     // когда пробовали в последний раз
  lastError: null,   // текст последней ошибки, если была
  building: false,
  builds: 0,
  failures: 0
};

async function rebuild(reason) {
  if (state.building) return;
  state.building = true;
  state.lastTry = new Date();
  try {
    const result = await build();
    const docs = new Map();
    const shops = [];
    for (const { shop, doc, stats } of result.shops) {
      // Защита от пустой сборки: если фид приехал битым, лучше отдать старое.
      if (stats.offers === 0) throw new Error(`${shop.title}: в файле 0 офферов, сборку не принимаем`);
      docs.set(shop.route, doc);
      shops.push({
        route: shop.route,
        title: shop.title,
        merchantId: shop.merchantId,
        offers: stats.offers,
        inStock: stats.inStock,
        priced: stats.priced,
        noPriceRow: stats.noPriceRow,
        disabled: stats.disabled,
        skuRemapped: stats.skuRemapped,
        bytes: Buffer.byteLength(doc)
      });
    }
    state.docs = docs;
    state.meta = { shops, totals: result.totals, sources: result.sources, date: result.date };
    state.builtAt = new Date();
    state.lastError = null;
    state.builds += 1;
    console.log(`[${state.builtAt.toISOString()}] сборка ok (${reason}): ` +
      shops.map((s) => `${s.route} ${s.offers} офферов, ${s.inStock} в наличии`).join("; "));
  } catch (error) {
    state.failures += 1;
    state.lastError = error.message;
    console.error(`[${new Date().toISOString()}] сборка упала (${reason}): ${error.message}` +
      (state.docs ? " — отдаём предыдущую версию" : " — отдавать пока нечего"));
  } finally {
    state.building = false;
  }
}

const escapeHtml = (value) => String(value).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function statusPage() {
  const rows = (state.meta?.shops || []).map((s) => `<tr>
      <td><a href="${s.route}">${s.route}</a></td>
      <td>${escapeHtml(s.merchantId)}</td>
      <td>${s.offers}</td>
      <td>${s.inStock}</td>
      <td>${s.noPriceRow}</td>
    </tr>`).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Kaspi feed</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border-bottom:1px solid #ddd;padding:.4rem .6rem;text-align:left}
code{background:#f3f3f3;padding:.1rem .3rem;border-radius:3px}.err{color:#b00}</style>
<h1>Kaspi price-list</h1>
<p>Собрано: <b>${state.builtAt ? escapeHtml(state.builtAt.toISOString()) : "ещё ни разу"}</b>,
пересборка каждые ${REBUILD_MINUTES} мин.</p>
${state.lastError ? `<p class="err">Последняя попытка упала: ${escapeHtml(state.lastError)}</p>` : ""}
<table><tr><th>Ссылка</th><th>merchantid</th><th>офферов</th><th>в наличии</th><th>без цены</th></tr>
${rows}</table>
<p>Машинный статус: <a href="/health"><code>/health</code></a></p>`;
}

function sendXml(res, doc) {
  const body = Buffer.from(doc, "utf8");
  res.writeHead(200, {
    "content-type": "application/xml; charset=utf-8",
    "content-length": body.length,
    "last-modified": (state.builtAt || new Date()).toUTCString(),
    "cache-control": "no-cache"
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = url.pathname.replace(/\/+$/, "") || "/";

  if (state.docs?.has(route)) {
    if (req.method === "HEAD") { res.writeHead(200, { "content-type": "application/xml; charset=utf-8" }); return res.end(); }
    return sendXml(res, state.docs.get(route));
  }

  if (SHOPS.some((shop) => shop.route === route)) {
    // Маршрут известен, но успешной сборки ещё не было.
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "60" });
    return res.end(`Файл ещё не собран. ${state.lastError || "Идёт первая сборка."}\n`);
  }

  if (route === "/health") {
    const ok = Boolean(state.docs);
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok,
      builtAt: state.builtAt,
      lastTry: state.lastTry,
      lastError: state.lastError,
      builds: state.builds,
      failures: state.failures,
      rebuildMinutes: REBUILD_MINUTES,
      ...state.meta
    }, null, 2));
  }

  if (route === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(statusPage());
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("404\n");
});

server.listen(PORT, () => {
  console.log(`Сервис на http://localhost:${PORT}`);
  for (const shop of SHOPS) console.log(`  ${shop.route} — ${shop.title} (merchantid ${shop.merchantId})`);
  rebuild("старт");
  setInterval(() => rebuild("таймер"), REBUILD_MINUTES * 60 * 1000).unref?.();
});
