// Чтение цен из закрытой Google-таблицы через сервисный аккаунт.
//
// Таблица НЕ публикуется в интернет: ей выдаётся доступ «Просмотр» роботу
// вида kaspi-feed@проект.iam.gserviceaccount.com. Поэтому себестоимость
// («Цена 1С») может спокойно лежать в той же таблице — наружу уходит только
// то, что мы сами кладём в XML.
//
// Зависимостей нет: JWT подписывается штатным node:crypto.
import crypto from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const base64url = (input) => Buffer.from(input).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Ключ принимаем и как сырой JSON, и как base64 — в переменные окружения
// многострочный JSON с \n внутри private_key заезжает по-разному.
export function parseServiceAccount(raw) {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON: не разбирается ни как JSON, ни как base64");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON: нет client_email или private_key");
  }
  // Если ключ пришёл строкой из .env, переводы строк могли остаться литералами.
  key.private_key = key.private_key.replace(/\\n/g, "\n");
  return key;
}

// Токен живёт час, дёргать его на каждую сборку незачем.
let cachedToken = null;

async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.email === key.client_email && cachedToken.expires > now + 60) {
    return cachedToken.value;
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri || TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const signature = base64url(
    crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key)
  );

  const response = await fetch(key.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    // Текст ошибки Google безопасен для лога: ключа в нём нет.
    throw new Error(`Google OAuth: HTTP ${response.status} ${data.error_description || data.error || ""}`.trim());
  }
  cachedToken = { email: key.client_email, value: data.access_token, expires: now + (data.expires_in || 3600) };
  return cachedToken.value;
}

// Возвращает строки таблицы как массив массивов — тот же формат, что даёт
// parseCsv, поэтому дальше по коду разницы между источниками нет.
export async function readSheet({ serviceAccountJson, sheetId, range }) {
  const key = parseServiceAccount(serviceAccountJson);
  const token = await accessToken(key);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`
    + `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || `HTTP ${response.status}`;
    if (response.status === 403 || response.status === 404) {
      throw new Error(`Google Sheets: ${detail}. Проверь, что таблица расшарена на ${key.client_email}`);
    }
    throw new Error(`Google Sheets: ${detail}`);
  }
  const rows = (data.values || []).map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
  if (!rows.length) throw new Error(`Google Sheets: диапазон ${range} пуст`);
  return rows;
}
