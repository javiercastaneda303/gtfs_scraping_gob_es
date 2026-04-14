const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://nap.transportes.gob.es";
const SNAPSHOT_DIR = path.join(__dirname, "snapshots");
const DIFF_DIR = path.join(__dirname, "diffs");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function isoStamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-");
}

function loadLatestSnapshot() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return null;
  const files = fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
    .sort();
  if (!files.length) return null;
  const last = files[files.length - 1];
  const raw = fs.readFileSync(path.join(SNAPSHOT_DIR, last), "utf8");
  return { file: last, data: JSON.parse(raw) };
}

async function createBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    viewport: { width: 1920, height: 1080 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  return { browser, context };
}

async function scrapeListing(page) {
  const items = {};

  await page.goto(`${BASE_URL}/Files/List`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(4000);

  const totalPages = await page.evaluate(() => {
    const pageButtons = document.querySelectorAll(".pagination .page-link");
    let max = 1;
    for (const btn of pageButtons) {
      const num = parseInt(btn.textContent.trim());
      if (!isNaN(num) && num > max) max = num;
    }
    return max;
  });
  console.log(`Total páginas: ${totalPages}`);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    console.log(`  Página ${pageNum}/${totalPages}`);
    if (pageNum > 1) {
      await page.evaluate((p) => {
        document.querySelector("#page").value = p;
        const form =
          document.querySelector("#page").closest("form") ||
          document.querySelector("form");
        if (form) form.submit();
      }, pageNum);
      await page.waitForTimeout(4000);
    }

    const pageItems = await page.evaluate(() => {
      const cards = document.querySelectorAll(".item-listado");
      const out = [];
      for (const card of cards) {
        const onclick = card.getAttribute("onclick") || "";
        const m = onclick.match(/Detail\/(\d+)/);
        if (!m) continue;
        const id = parseInt(m[1]);
        const titulo =
          card.querySelector(".card-title.hidden-title")?.textContent.trim() ||
          card.querySelector(".card-title-hidden")?.textContent.trim() ||
          "";
        const updateEl = [...card.querySelectorAll("span")].find((s) =>
          s.textContent.includes("Actualizado el")
        );
        const ultimaActualizacion = updateEl
          ? updateEl.textContent.trim().replace("Actualizado el ", "")
          : "";
        out.push({ id, titulo, ultimaActualizacion });
      }
      return out;
    });

    for (const it of pageItems) {
      items[it.id] = it;
    }
  }

  return items;
}

function diffSnapshots(prev, curr) {
  const nuevos = [];
  const eliminados = [];
  const actualizados = [];

  const prevMap = prev?.items || {};
  const currMap = curr.items;

  for (const id of Object.keys(currMap)) {
    if (!prevMap[id]) {
      nuevos.push(currMap[id]);
    } else if (
      prevMap[id].ultimaActualizacion !== currMap[id].ultimaActualizacion
    ) {
      actualizados.push({
        id: currMap[id].id,
        titulo: currMap[id].titulo,
        anterior: prevMap[id].ultimaActualizacion,
        actual: currMap[id].ultimaActualizacion,
      });
    }
  }
  for (const id of Object.keys(prevMap)) {
    if (!currMap[id]) eliminados.push(prevMap[id]);
  }

  return { nuevos, eliminados, actualizados };
}

async function main() {
  ensureDir(SNAPSHOT_DIR);
  ensureDir(DIFF_DIR);

  const previous = loadLatestSnapshot();
  console.log(
    previous
      ? `Snapshot anterior: ${previous.file} (${previous.data.timestamp})`
      : "No hay snapshot anterior — se generará el inicial."
  );

  const { browser, context } = await createBrowser();
  const page = await context.newPage();

  let items;
  try {
    console.log("Escaneando listado...");
    items = await scrapeListing(page);
  } finally {
    await browser.close();
  }

  const currentTimestamp = new Date().toISOString();
  const snapshot = {
    timestamp: currentTimestamp,
    total: Object.keys(items).length,
    items,
  };
  const stamp = isoStamp(new Date(currentTimestamp));
  const snapshotPath = path.join(SNAPSHOT_DIR, `snapshot-${stamp}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`Snapshot guardado: ${snapshotPath} (${snapshot.total} items)`);

  const { nuevos, eliminados, actualizados } = diffSnapshots(
    previous?.data,
    snapshot
  );

  const diff = {
    previousTimestamp: previous?.data?.timestamp || null,
    currentTimestamp,
    counts: {
      nuevos: nuevos.length,
      eliminados: eliminados.length,
      actualizados: actualizados.length,
    },
    nuevos,
    eliminados,
    actualizados,
  };
  const diffPath = path.join(DIFF_DIR, `diff-${stamp}.json`);
  fs.writeFileSync(diffPath, JSON.stringify(diff, null, 2));

  console.log("\n=== Resumen ===");
  console.log(`Nuevos:       ${nuevos.length}`);
  console.log(`Eliminados:   ${eliminados.length}`);
  console.log(`Actualizados: ${actualizados.length}`);
  console.log(`Diff guardado: ${diffPath}`);
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
