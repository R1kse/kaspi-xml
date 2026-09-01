// Разовая сборка в файлы — для проверки без запуска сервиса.
//   node scripts/build-once.mjs [папка]
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "../src/merge.mjs";

const outDir = process.argv[2] || "out";
// Стектрейс в логе CI не нужен, нужна причина. В сообщениях ошибок
// ключей и токенов нет — только имена переменных и текст от Google.
const result = await build().catch((error) => {
  console.error(`Сборка не удалась: ${error.message}`);
  process.exit(1);
});
await fs.mkdir(outDir, { recursive: true });

for (const { shop, doc, stats } of result.shops) {
  const file = path.join(outDir, shop.route.replace(/^\//, ""));
  await fs.writeFile(file, doc, "utf8");
  console.log(`\n${shop.title} → ${file}`);
  console.log(`  merchantid:              ${shop.merchantId}`);
  console.log(`  офферов:                 ${stats.offers}`);
  console.log(`  в наличии:               ${stats.inStock}`);
  console.log(`  цена из таблицы:         ${stats.priced}${stats.fuzzyMatched ? ` (нестрогий SKU: ${stats.fuzzyMatched})` : ""}`);
  console.log(`  нет строки в таблице:    ${stats.noPriceRow}`);
  console.log(`  снято с продажи:         ${stats.disabled}`);
  if (shop.targetStore) {
    console.log(`  склад:                   ${shop.sourceStores.join("+")} → ${shop.targetStore}`);
    console.log(`  города:                  ${shop.cityIds.join(", ")}`);
    console.log(`  артикул магазина:        ${stats.skuRemapped || "0 (колонка не заполнена, пишем артикулы 1С)"}`);
  }
}

console.log(`\nВсего офферов в фиде 1С:   ${result.totals.offers}`);
console.log(`  кириллических складов:   ${result.totals.storeIdFixed}`);
console.log(`  схлопнуто дублей:        ${result.totals.duplicatesCollapsed}`);
if (result.problems.length) console.log(`  плохих цен пропущено:    ${result.problems.length}`);
if (result.missing.length) console.log(`  без цены (первые 10):    ${result.missing.slice(0, 10).join(", ")}`);
