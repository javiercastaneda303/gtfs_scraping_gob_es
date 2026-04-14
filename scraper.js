const { chromium } = require("playwright");
const mongoose = require("mongoose");
require("dotenv").config();

const BASE_URL = "https://nap.transportes.gob.es";

// --- Logging helpers ---
const t0 = Date.now();
function elapsed() {
  const s = (Date.now() - t0) / 1000;
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  return `${mm}:${ss}`;
}
function log(msg) {
  console.log(`[${elapsed()}] ${msg}`);
}
function logStep(msg) {
  console.log(`\n[${elapsed()}] ========== ${msg} ==========`);
}

// --- Mongoose Schema ---
const datasetSchema = new mongoose.Schema(
  {
    datasetId: { type: Number, unique: true },
    url: String,
    titulo: String,
    ubicaciones: [String],
    operadores: [
      {
        nombre: String,
        url: String,
      },
    ],
    descargaUrl: String,
    descargaSize: String,
    formatos: [String],
    tipoTransporte: [String],
    ultimaActualizacion: String,
    metadatoId: String,
    metadatos: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const Dataset = mongoose.model("Dataset", datasetSchema);

// --- Browser helpers ---
async function createBrowser() {
  const browser = await chromium.launch({
    headless: false,
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

// --- Step 1: Collect all detail URLs from the list pages ---
async function collectDetailUrls(page) {
  const allUrls = [];

  log(`Abriendo listado: ${BASE_URL}/Files/List`);
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

  log(`Paginación detectada: ${totalPages} páginas`);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    log(`→ Recorriendo listado página ${pageNum}/${totalPages}`);

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

    const urls = await page.evaluate((base) => {
      const cards = document.querySelectorAll(".item-listado");
      return Array.from(cards).map((card) => {
        const onclick = card.getAttribute("onclick") || "";
        const match = onclick.match(/\.\/Detail\/(\d+)/);
        if (match) {
          return {
            id: parseInt(match[1]),
            url: `${base}/Files/Detail/${match[1]}`,
          };
        }
        return null;
      }).filter(Boolean);
    }, BASE_URL);

    allUrls.push(...urls);
    log(`   ${urls.length} items en esta página (acumulado: ${allUrls.length})`);
  }

  log(`Total URLs de detalle recolectadas: ${allUrls.length}`);
  return allUrls;
}

// --- Step 2: Scrape detail page ---
async function scrapeDetailPage(page, url, datasetId) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  const data = await page.evaluate((baseUrl) => {
    const result = {};

    // Title
    const titleEl = document.querySelector(".card-header.card-title");
    result.titulo = titleEl?.textContent?.trim() || "";

    // Locations - inside .card-info .regionesDiv elements
    const cardInfo = document.querySelector(".card-info");
    if (cardInfo) {
      const regionDivs = cardInfo.querySelectorAll(".regionesDiv");
      const locs = [];
      for (const div of regionDivs) {
        // Clean text: remove "Y X más" hints and normalize whitespace
        const raw = div.textContent.trim().replace(/Y\s+\d+\s+más/g, "");
        // Split by comma in case of "Álava, Vizcaya"
        const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
        // Also handle "..." truncation
        for (const part of parts) {
          const clean = part.replace(/\.{2,}/, "").trim();
          if (clean) locs.push(clean);
        }
      }
      result.ubicaciones = [...new Set(locs)];
    } else {
      result.ubicaciones = [];
    }

    // Operators - listed under "Operadores incluidos" as { nombre, url }
    const operatorsHeader = [...document.querySelectorAll("b, strong")].find(
      (el) => el.textContent.includes("Operadores incluidos")
    );
    if (operatorsHeader) {
      const parent = operatorsHeader.closest(".card-footer, .card-descripcion") || operatorsHeader.closest("div");
      if (parent) {
        // Get all <li> from both visible and hidden (contraibleOff) sections
        const lis = parent.querySelectorAll("li");
        result.operadores = Array.from(lis).map((li) => {
          const a = li.querySelector("a");
          return {
            nombre: (a?.textContent || li.textContent).trim(),
            url: a?.getAttribute("href") || "",
          };
        });
      } else {
        result.operadores = [];
      }
    } else {
      result.operadores = [];
    }

    // Download link
    const downloadBtn = document.querySelector(".btn-descargar-fichero");
    if (downloadBtn) {
      const btnText = downloadBtn.textContent.trim();
      const sizeMatch = btnText.match(/\(([^)]+)\)/);
      result.descargaSize = sizeMatch ? sizeMatch[1] : "";

      // The actual download URL is in the href but requires login
      // Extract the returnUrl which contains the detail page path
      const href = downloadBtn.getAttribute("href") || "";
      if (href.includes("returnUrl=")) {
        const returnPath = decodeURIComponent(
          href.split("returnUrl=")[1]
        );
        result.descargaUrl = `${baseUrl}${returnPath}`;
      } else {
        result.descargaUrl = href.startsWith("/")
          ? `${baseUrl}${href}`
          : href;
      }
    } else {
      result.descargaUrl = "";
      result.descargaSize = "";
    }

    // Formats (GTFS-ZIP, GTFS-RT, etc.)
    const badges = document.querySelectorAll(".badge.badge-info");
    result.formatos = Array.from(badges).map((b) => b.textContent.trim());

    // Transport type
    const footerSpans = document.querySelectorAll(".card-footer-inner .text-muted");
    const transportTypes = [];
    for (const span of footerSpans) {
      const text = span.textContent.trim();
      if (
        text.includes("Autobús") ||
        text.includes("Ferroviario") ||
        text.includes("Marítimo") ||
        text.includes("Aéreo")
      ) {
        transportTypes.push(
          ...text.split(",").map((t) => t.trim())
        );
      }
    }
    // Also check the detail header area for transport type icons/text
    if (transportTypes.length === 0) {
      const allText = document.body.innerText;
      const types = ["Autobús", "Ferroviario", "Marítimo", "Aéreo"];
      for (const t of types) {
        if (allText.includes(t)) transportTypes.push(t);
      }
    }
    result.tipoTransporte = [...new Set(transportTypes)];

    // Last update
    const updateEl = [...document.querySelectorAll("span, p")].find((el) =>
      el.textContent.includes("Actualizado el")
    );
    result.ultimaActualizacion = updateEl
      ? updateEl.textContent.trim().replace("Actualizado el ", "")
      : "";

    // Metadatos - botón "Ver metadatos" + modal #modal-metadatos-{metadatoId}
    result.metadatoId = "";
    result.metadatos = {};
    const metaBtn = document.querySelector("button.b-metadata, [onclick^='showMetadato']");
    if (metaBtn) {
      const onclick = metaBtn.getAttribute("onclick") || "";
      const target = metaBtn.getAttribute("data-target") || "";
      const idMatch =
        onclick.match(/showMetadato\(['"]?(\d+)['"]?\)/) ||
        target.match(/modal-metadatos-(\d+)/);
      if (idMatch) result.metadatoId = idMatch[1];
    }

    if (result.metadatoId) {
      const modal = document.querySelector(
        `#modal-metadatos-${result.metadatoId}`
      );
      if (modal) {
        const cards = modal.querySelectorAll(".card.divMetadatosCard");
        for (const card of cards) {
          const titleEl = card.querySelector(
            ".divMetadatosTitle .align-middle.font-weight-bold"
          );
          const sectionTitle = titleEl?.textContent?.trim() || "Sin título";
          const rows = card.querySelectorAll("table tbody tr");
          const section = {};
          for (const tr of rows) {
            const tds = tr.querySelectorAll("td");
            if (tds.length < 2) continue;
            const key = tds[0].textContent.trim();
            const link = tds[1].querySelector("a");
            const value = link
              ? link.getAttribute("href") || link.textContent.trim()
              : tds[1].textContent.trim().replace(/\s+/g, " ");
            if (key) section[key] = value;
          }
          if (Object.keys(section).length) {
            result.metadatos[sectionTitle] = section;
          }
        }
      }
    }

    return result;
  }, BASE_URL);

  return {
    datasetId,
    url,
    ...data,
  };
}

// --- Main ---
async function main() {
  logStep("INICIO DEL SCRAPER");
  log(`MONGO_URI: ${process.env.MONGO_URI ? "definida" : "NO definida"}`);

  log("Conectando a MongoDB...");
  await mongoose.connect(process.env.MONGO_URI);
  log("✓ Conectado a MongoDB");

  log("Lanzando navegador Chromium...");
  const { browser, context } = await createBrowser();
  const page = await context.newPage();
  log("✓ Navegador listo");

  const stats = { scraped: 0, skipped: 0, errors: 0 };

  try {
    logStep("PASO 1/2: Recolectando URLs del listado");
    const detailUrls = await collectDetailUrls(page);

    log("Guardando URLs en MongoDB (upsert)...");
    for (const { id, url } of detailUrls) {
      await Dataset.findOneAndUpdate(
        { datasetId: id },
        { datasetId: id, url },
        { upsert: true }
      );
    }
    log(`✓ ${detailUrls.length} URLs persistidas`);

    logStep("PASO 2/2: Scrapeando páginas de detalle");
    const total = detailUrls.length;

    for (let i = 0; i < total; i++) {
      const { id, url } = detailUrls[i];
      const idx = `[${i + 1}/${total}]`;

      const existing = await Dataset.findOne({ datasetId: id });
      if (existing?.titulo && existing?.metadatoId) {
        stats.skipped++;
        log(`${idx} ⏭  id=${id} ya scrapeado, omitiendo`);
        continue;
      }

      log(`${idx} ▶  Scrapeando id=${id}  ${url}`);
      const start = Date.now();

      try {
        const data = await scrapeDetailPage(page, url, id);

        await Dataset.findOneAndUpdate({ datasetId: id }, data, {
          upsert: true,
        });

        const ms = Date.now() - start;
        const metaSections = Object.keys(data.metadatos || {}).length;
        stats.scraped++;
        log(`${idx} ✓  "${data.titulo}" (${ms}ms)`);
        log(
          `        ubicaciones=${data.ubicaciones.length} operadores=${data.operadores.length} formatos=[${data.formatos.join(", ")}] metadatoId=${data.metadatoId || "-"} secciones=${metaSections}`
        );
      } catch (err) {
        stats.errors++;
        log(`${idx} ✗  Error en id=${id}: ${err.message}`);
      }

      if ((i + 1) % 10 === 0) {
        log(
          `   · Progreso: ${i + 1}/${total} | scraped=${stats.scraped} skipped=${stats.skipped} errors=${stats.errors}`
        );
      }

      await page.waitForTimeout(1500);
    }

    logStep("SCRAPING COMPLETADO");
    log(
      `Resumen: scraped=${stats.scraped} skipped=${stats.skipped} errors=${stats.errors} total=${total}`
    );
  } finally {
    log("Cerrando navegador...");
    await browser.close();
    log("Desconectando de MongoDB...");
    await mongoose.disconnect();
    log(`✓ Finalizado en ${elapsed()}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
