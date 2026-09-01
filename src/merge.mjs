// Сборка price-list.xml для Kaspi из двух источников:
//   остатки  -> XML-фид 1С (SOURCE_XML_URL)
//   цены     -> закрытая Google-таблица (Sheets API) или CSV
// Kaspi забирает файл целиком, поэтому в нём должны быть ВСЕ офферы,
// а не только изменившиеся: файл — снимок, а не дельта.
//
// Модуль ничего не пишет на диск и ничего не печатает: отдаёт готовые
// документы и статистику, а что с ними делать — решает вызывающий код.
import fs from "node:fs/promises";
import { readSheet } from "./sheets.mjs";

export async function fetchText(url, label) {
  // Локальный путь — удобно прогонять сборку на сохранённой копии фида.
  if (!/^https?:/i.test(url)) return fs.readFile(url, "utf8");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${url}`);
  return response.text();
}

// Разбор CSV с кавычками и переводами строк внутри полей.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (quoted) {
      if (char === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\r") continue;
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

// Sheets умеет превратить "0339200200" в число 339200200, поэтому
// сравниваем ещё и по цифрам без ведущих нулей.
const loose = (sku) => String(sku).replace(/\D/g, "").replace(/^0+/, "");

// На вход — строки таблицы (массив массивов). Откуда они взялись, из CSV
// или из Sheets API, коду дальше безразлично.
export function buildPriceIndex(rows) {
  if (!rows.length) throw new Error("Таблица цен пуста");
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const skuAt = header.findIndex((cell) => cell === "sku");
  const priceAt = header.findIndex((cell) => cell.includes("kaspi"));
  const sellAt = header.findIndex((cell) => cell.startsWith("продавать"));
  const shopAt = header.findIndex((cell) => cell.startsWith("магазин"));
  const nameAt = header.findIndex((cell) => cell === "товар" || cell.startsWith("наимен"));
  // Артикул магазина Centersna: в фиде 1С лежит свой артикул, Kaspi ждёт свой.
  const skuMatrasAt = header.findIndex((cell) => cell.includes("артикул") && cell.includes("centersna"));
  if (skuAt < 0 || priceAt < 0) {
    throw new Error(`Не найдены колонки sku / «Цена Kaspi». Заголовок: ${header.join(" | ")}`);
  }

  const exact = new Map();
  const fuzzy = new Map();
  // По названию сопоставляются архивные товары Centersna: артикул у них свой,
  // а название совпадает с фидом 1С. Одинаковые названия у разных sku —
  // повод не угадывать: такой ключ выбрасываем.
  const byName = new Map();
  const nameConflicts = new Set();
  const problems = [];
  for (const cells of rows.slice(1)) {
    const sku = (cells[skuAt] || "").trim().replace(/^'/, "");
    if (!sku) continue;
    const raw = (cells[priceAt] || "").replace(/[\s ]/g, "").replace(",", ".");
    const price = Math.round(Number(raw));
    const sellRaw = sellAt >= 0 ? (cells[sellAt] || "").trim().toLowerCase() : "да";
    const sell = !["нет", "no", "0", "false"].includes(sellRaw);
    if (!Number.isFinite(price) || price <= 0) {
      problems.push({ sku, reason: `нечисловая цена «${cells[priceAt]}»` });
      continue;
    }
    const entry = {
      sku,
      price,
      sell,
      shop: shopAt >= 0 ? (cells[shopAt] || "").trim() : "",
      skuMatras: skuMatrasAt >= 0 ? (cells[skuMatrasAt] || "").trim().replace(/^'/, "") : ""
    };
    exact.set(sku, entry);
    fuzzy.set(loose(sku), entry);
    if (nameAt >= 0) {
      const key = nameKey(cells[nameAt] || "");
      if (key !== "|") {
        const prev = byName.get(key);
        if (prev && prev.sku !== sku) nameConflicts.add(key);
        else byName.set(key, entry);
      }
    }
  }
  for (const key of nameConflicts) byName.delete(key);
  return { exact, fuzzy, byName, problems };
}

const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";

// Ключ для сопоставления по названию: артикулы 1С и Centersna разные,
// а названия совпадают с точностью до кавычек, «HS» и пробелов в размере.
export function nameKey(name) {
  const clean = String(name).toLowerCase()
    .replace(/матрас ортопедический|матрас|ортопедический/g, " ")
    .replace(/\bhs\b|\bлт\b/g, " ")
    .replace(/размер/g, " ")
    .replace(/[«»"“”()\/.,]/g, " ")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
  const size = (clean.match(/(\d[,\s]\d0)\s*[*х×x]\s*(\d[,\s]\d0)/) || [""])[0].replace(/\s/g, "");
  return `${clean.replace(/(\d[,\s]\d0)\s*[*х×x]\s*(\d[,\s]\d0)/, "").replace(/\s+/g, " ").trim()}|${size}`;
}

// Архив кабинета Centersna: товары, снятые с продажи. В фиде 1С их нет,
// а цену в кабинете кто-то всё равно должен держать актуальной — поэтому
// они едут в тот же файл со своими артикулами Centersna и available="no".
export function parseArchive(xml) {
  const offers = [];
  const skipped = { noModel: 0, noPrice: 0 };
  for (const match of xml.matchAll(/<offer\b([^>]*)>([\s\S]*?)<\/offer>/g)) {
    const [, head, body] = match;
    const sku = attr(`<offer${head}>`, "sku");
    const model = (body.match(/<model>([\s\S]*?)<\/model>/)?.[1] || "").trim();
    const price = Math.round(Number(body.match(/<cityprice\b[^>]*>([^<]*)<\/cityprice>/)?.[1] || 0));
    if (!sku) continue;
    // Оффер без названия или с ценой 0 Kaspi всё равно не примет.
    if (!model) { skipped.noModel += 1; continue; }
    if (!(price > 0)) { skipped.noPrice += 1; continue; }
    offers.push({ sku, head, body, model, price, key: nameKey(model) });
  }
  return { offers, skipped };
}

// Название -> артикул Centersna, по архиву. Неоднозначные названия
// (одно и то же имя у разных артикулов) выкидываем, угадывать нечего.
function archiveSkuIndex(offers) {
  const index = new Map();
  const conflicts = new Set();
  for (const offer of offers) {
    const prev = index.get(offer.key);
    if (prev && prev !== offer.sku) conflicts.add(offer.key);
    else index.set(offer.key, offer.sku);
  }
  for (const key of conflicts) index.delete(key);
  return index;
}

// В фиде 1С часть storeId написана кириллицей (РР70 вместо PP70) —
// Kaspi такой склад не знает и оффер по нему не продаётся.
const fixStoreId = (id) => id
  .replace(/Р/g, "P").replace(/С/g, "C").replace(/А/g, "A")
  .replace(/Е/g, "E").replace(/М/g, "M").replace(/Н/g, "H")
  .replace(/О/g, "O").replace(/Т/g, "T").replace(/В/g, "B")
  .replace(/К/g, "K").replace(/Х/g, "X");

// Остатки из фида, склад -> {stock, available}. Дубли одного склада
// схлопываются по максимуму: в фиде PP2 встречается дважды с разными
// числами, и брать последнее значит уронить товар в ноль на ровном месте.
function readStores(block) {
  const stores = new Map();
  for (const tag of block.match(/<availability\b[^>]*\/?>/g) || []) {
    const storeId = fixStoreId(attr(tag, "storeId"));
    if (!storeId) continue;
    const stock = Math.max(0, Math.floor(Number(attr(tag, "stockCount")) || 0));
    const available = attr(tag, "available") === "yes";
    const prev = stores.get(storeId);
    if (!prev) stores.set(storeId, { stock, available });
    else {
      if (stock > prev.stock) prev.stock = stock;
      if (available) prev.available = true;
    }
  }
  return stores;
}

const availabilityXml = (rows) => `<availabilities>\n${rows
  .map(({ storeId, stock, available }) =>
    `      <availability available="${available ? "yes" : "no"}" storeId="${storeId}" stockCount="${available ? stock : 0}"/>`)
  .join("\n")}\n    </availabilities>`;

const cityPricesXml = (cityIds, price) => `<cityprices>\n${cityIds
  .map((cityId) => `      <cityprice cityId="${cityId}">${price}</cityprice>`)
  .join("\n")}\n    </cityprices>`;

const list = (value, fallback) => (value || fallback).split(",").map((s) => s.trim()).filter(Boolean);

// Два магазина — два merchantid, два файла, две ссылки.
// Матрасы идут только в Centersna, всё прочее — только в 30378397.
// «Наматрасник» матрасом не считается: проверяется начало названия.
export const SHOPS = [
  {
    key: "matras",
    route: "/centersna.xml",
    title: "Centersna — только матрасы",
    merchantId: process.env.MERCHANT_ID_MATRAS || "Centersna",
    company: process.env.COMPANY_MATRAS || "Centersna",
    // У Centersna своя схема: один склад и один город, а не 18 и 13 как в 1С.
    // Centersna_PP1 — это Алматы, Москвина 23.
    targetStore: process.env.CENTERSNA_STORE || "Centersna_PP1",
    sourceStores: list(process.env.CENTERSNA_SOURCE_STORES, "PP2"),
    cityIds: list(process.env.CENTERSNA_CITIES, "750000000"),
    skuField: "skuMatras",
    // Архив кабинета: и источник артикулов Centersna, и сами снятые товары.
    useArchiveSku: true
  },
  {
    key: "other",
    route: "/matras.xml",
    title: "Matras.kz — кровати и всё кроме матрасов",
    merchantId: process.env.MERCHANT_ID_OTHER || "30378397",
    company: process.env.COMPANY_OTHER || "",
    // Склады и города берём как есть из фида — схема совпадает.
    targetStore: null,
    sourceStores: null,
    cityIds: null,
    skuField: null
  }
];

const isMattress = (name) => /^\s*матра[сц]/i.test(name);

// Необязательная колонка «Магазин» в таблице перебивает правило по названию.
function shopFor(name, override) {
  const value = (override || "").trim().toLowerCase();
  if (value.startsWith("матрас") || value === "matras" || value.startsWith("centersna")) return "matras";
  if (value) return "other";
  return isMattress(name) ? "matras" : "other";
}

// Потолок остатка: Kaspi считает срок отгрузки по количеству, весь склад
// показывать незачем. 0 = не ограничивать.
const STOCK_CAP = Math.max(0, Math.floor(Number(process.env.STOCK_CAP) || 0));
const cap = (stock) => (STOCK_CAP ? Math.min(stock, STOCK_CAP) : stock);

// Главная функция: на входе фид и строки таблицы, на выходе — документы.
export function merge(xml, priceRows, archiveXml) {
  const { exact, fuzzy, byName, problems } = buildPriceIndex(priceRows);
  const archive = archiveXml ? parseArchive(archiveXml) : { offers: [], skipped: { noModel: 0, noPrice: 0 } };
  const archiveSku = archiveSkuIndex(archive.offers);
  // Артикулы, уже занятые живыми офферами: архивный дубль того же товара
  // публиковать второй раз нельзя.
  const usedSkus = new Set();
  // Формат даты — как в выгрузке самого Kaspi: "2026-08-31 10:54", время Алматы.
  const now = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");

  const totals = { offers: 0, storeIdFixed: 0, duplicatesCollapsed: 0, badPriceRows: problems.length };
  const missing = [];
  let firstPass = true;

  function render(shop, stats) {
    return xml
      .replace(/[ \t]*<offer\b([^>]*)>([\s\S]*?)<\/offer>\r?\n?/g, (whole, head, body) => {
        const sku = attr(`<offer${head}>`, "sku");
        const name = (body.match(/<model>([\s\S]*?)<\/model>/)?.[1] || "").trim();
        const entry = exact.get(sku) || fuzzy.get(loose(sku));
        if (firstPass) {
          totals.offers += 1;
          if (!entry) missing.push(sku);
        }
        if (shopFor(name, entry?.shop) !== shop.key) return "";

        stats.offers += 1;
        if (entry && !exact.has(sku)) stats.fuzzyMatched += 1;

        const availBlock = body.match(/<availabilities>[\s\S]*?<\/availabilities>/)?.[0] || "";
        const rawStores = (availBlock.match(/<availability\b/g) || []).length;
        if (/storeId="[^"]*[Ѐ-ӿ]/.test(availBlock)) stats.storeIdFixed += 1;

        const sell = entry ? entry.sell : true;
        if (entry && !entry.sell) stats.disabled += 1;

        const stores = readStores(availBlock);
        stats.duplicatesCollapsed += Math.max(0, rawStores - stores.size);

        let rows;
        if (shop.targetStore) {
          // Схема Centersna: один склад. Берём максимум по складам-источникам,
          // а не сумму — товар физически лежит в одном месте, сумма завысит остаток.
          let stock = 0;
          let available = false;
          for (const storeId of shop.sourceStores) {
            const info = stores.get(storeId);
            if (!info) continue;
            if (info.stock > stock) stock = info.stock;
            if (info.available) available = true;
          }
          if (!stores.size) stats.noSourceStore += 1;
          rows = [{ storeId: shop.targetStore, stock: cap(stock), available: sell && available && stock > 0 }];
        } else {
          rows = [...stores.entries()].map(([storeId, info]) => ({
            storeId, stock: cap(info.stock), available: sell && info.available && info.stock > 0
          }));
        }
        if (rows.some((row) => row.available)) stats.inStock += 1;
        let next = availBlock ? body.replace(availBlock, availabilityXml(rows)) : body;

        const cityBlock = next.match(/<cityprices>[\s\S]*?<\/cityprices>/)?.[0] || "";
        const cityIds = shop.cityIds
          || [...new Set([...cityBlock.matchAll(/<cityprice\b[^>]*cityId="([^"]*)"/g)].map((m) => m[1]))];
        if (entry) {
          stats.priced += 1;
          if (cityBlock) next = next.replace(cityBlock, cityPricesXml(cityIds, entry.price));
        } else {
          // Нет строки в таблице — цену не трогаем, оставляем как в 1С.
          stats.noPriceRow += 1;
        }

        // У магазина могут быть свои артикулы: сначала колонка в таблице,
        // потом архив кабинета по названию, иначе остаётся артикул 1С.
        let shopSku = sku;
        if (shop.skuField && entry?.[shop.skuField]) {
          shopSku = entry[shop.skuField];
        } else if (shop.useArchiveSku) {
          const fromArchive = archiveSku.get(nameKey(name));
          if (fromArchive) { shopSku = fromArchive; stats.skuFromArchive += 1; }
        }
        if (shopSku !== sku) stats.skuRemapped += 1;
        if (shop.useArchiveSku) usedSkus.add(shopSku);
        const newHead = head.replace(/sku="[^"]*"/, `sku="${shopSku}"`);
        return `\t\t<offer${newHead}>${next}</offer>\n`;
      })
      .replace(/(<kaspi_catalog\b[^>]*\bdate=")[^"]*(")/, `$1${now}$2`);
  }

  // Архивные офферы дописываются в конец <offers>. Остатка у них нет
  // по определению, цена — из таблицы по названию, иначе своя из архива.
  function renderArchive(stats) {
    const chunks = [];
    for (const offer of archive.offers) {
      if (usedSkus.has(offer.sku)) { stats.archiveSkipped += 1; continue; }
      const entry = byName.get(offer.key);
      const price = entry ? entry.price : offer.price;
      if (entry) stats.archivePriced += 1;

      let body = offer.body;
      const availBlock = body.match(/<availabilities>[\s\S]*?<\/availabilities>/)?.[0] || "";
      if (availBlock) {
        const rows = [...readStores(availBlock).keys()]
          .map((storeId) => ({ storeId, stock: 0, available: false }));
        body = body.replace(availBlock, availabilityXml(rows));
      }
      const cityBlock = body.match(/<cityprices>[\s\S]*?<\/cityprices>/)?.[0] || "";
      if (cityBlock) {
        const cityIds = [...new Set([...cityBlock.matchAll(/<cityprice\b[^>]*cityId="([^"]*)"/g)].map((m) => m[1]))];
        body = body.replace(cityBlock, cityPricesXml(cityIds, price));
      }
      stats.archiveOffers += 1;
      chunks.push(`\t\t<offer${offer.head}>${body}</offer>\n`);
    }
    return chunks.join("");
  }

  const shops = [];
  for (const shop of SHOPS) {
    const stats = {
      offers: 0, priced: 0, fuzzyMatched: 0, noPriceRow: 0, disabled: 0, inStock: 0,
      storeIdFixed: 0, duplicatesCollapsed: 0, skuRemapped: 0, noSourceStore: 0,
      skuFromArchive: 0, archiveOffers: 0, archivePriced: 0, archiveSkipped: 0
    };
    let doc = render(shop, stats);
    firstPass = false;
    if (shop.useArchiveSku && archive.offers.length) {
      const tail = renderArchive(stats);
      doc = doc.replace(/([ \t]*<\/offers>)/, `${tail}$1`);
      stats.offers += stats.archiveOffers;
    }
    if (shop.merchantId) {
      doc = doc.replace(/<merchantid>[\s\S]*?<\/merchantid>/, `<merchantid>${shop.merchantId}</merchantid>`);
    }
    if (shop.company) {
      doc = doc.replace(/<company>[\s\S]*?<\/company>/, `<company>${shop.company}</company>`);
    }
    totals.storeIdFixed += stats.storeIdFixed;
    totals.duplicatesCollapsed += stats.duplicatesCollapsed;
    shops.push({ shop, doc, stats });
  }

  return { shops, totals, problems, missing, date: now };
}

// Цены: закрытая Google-таблица, если задан сервисный аккаунт, иначе CSV.
async function loadPrices() {
  const sheetId = process.env.PRICES_SHEET_ID;
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (sheetId && serviceAccountJson) {
    const range = process.env.PRICES_SHEET_RANGE || "A:Z";
    const rows = await readSheet({ serviceAccountJson, sheetId, range });
    // В лог пишем id таблицы, но не ключ и не ссылку с токеном.
    return { rows, source: `google-sheet:${sheetId} ${range}` };
  }
  if (sheetId || serviceAccountJson) {
    throw new Error("Для чтения таблицы нужны обе переменные: PRICES_SHEET_ID и GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  const csvUrl = process.env.PRICES_CSV_URL || "data/prices.csv";
  return { rows: parseCsv(await fetchText(csvUrl, "Таблица цен")), source: `csv:${csvUrl}` };
}

// Скачать источники и собрать. Возвращает то же, что merge().
export async function build({ sourceXmlUrl } = {}) {
  const xmlUrl = sourceXmlUrl || process.env.SOURCE_XML_URL
    || "https://centermatrasov.kz/kspmat/kaspi_catalog.xml";
  // Архив выгружается из кабинета руками и лежит в репозитории. Нет файла —
  // собираем как раньше, без архивных офферов: это не повод ронять сборку.
  const archiveUrl = process.env.ARCHIVE_XML_URL || "data/archive-centersna.xml";
  const [xml, prices, archiveXml] = await Promise.all([
    fetchText(xmlUrl, "Фид 1С"),
    loadPrices(),
    fetchText(archiveUrl, "Архив Centersna").catch(() => null)
  ]);
  const result = merge(xml, prices.rows, archiveXml);
  result.sources = {
    xmlUrl, prices: prices.source, xmlBytes: xml.length, priceRows: prices.rows.length - 1,
    archive: archiveXml ? archiveUrl : "нет"
  };
  return result;
}
