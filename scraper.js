const { chromium } = require("playwright");
const mongoose = require("mongoose");
require("dotenv").config();

const BASE_URL = "https://nap.transportes.gob.es";

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

  await page.goto(`${BASE_URL}/Files/List`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(4000);

  // Get total pages from pagination
  const totalPages = await page.evaluate(() => {
    const pageButtons = document.querySelectorAll(".pagination .page-link");
    let max = 1;
    for (const btn of pageButtons) {
      const num = parseInt(btn.textContent.trim());
      if (!isNaN(num) && num > max) max = num;
    }
    return max;
  });

  console.log(`Total pages found: ${totalPages}`);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    console.log(`Scraping list page ${pageNum}/${totalPages}...`);

    if (pageNum > 1) {
      // Navigate to the next page by submitting the form with the page number
      await page.evaluate((p) => {
        document.querySelector("#page").value = p;
        // Find and submit the form containing the pagination
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
    console.log(`  Found ${urls.length} items on page ${pageNum}`);
  }

  console.log(`\nTotal detail URLs collected: ${allUrls.length}`);
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
  // Connect to MongoDB
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const { browser, context } = await createBrowser();
  const page = await context.newPage();

  try {
    // Step 1: Collect all URLs
    console.log("\n=== Step 1: Collecting detail URLs ===\n");
    const detailUrls = await collectDetailUrls(page);

    // Save URLs to MongoDB
    for (const { id, url } of detailUrls) {
      await Dataset.findOneAndUpdate(
        { datasetId: id },
        { datasetId: id, url },
        { upsert: true }
      );
    }
    console.log(`Saved ${detailUrls.length} URLs to MongoDB`);

    // Step 2: Scrape each detail page
    console.log("\n=== Step 2: Scraping detail pages ===\n");
    for (let i = 0; i < detailUrls.length; i++) {
      const { id, url } = detailUrls[i];

      // Check if already fully scraped
      const existing = await Dataset.findOne({ datasetId: id });
      if (existing?.titulo) {
        console.log(
          `[${i + 1}/${detailUrls.length}] Skipping ${id} (already scraped)`
        );
        continue;
      }

      console.log(
        `[${i + 1}/${detailUrls.length}] Scraping detail: ${url}`
      );

      try {
        const data = await scrapeDetailPage(page, url, id);

        await Dataset.findOneAndUpdate({ datasetId: id }, data, {
          upsert: true,
        });

        console.log(`  -> ${data.titulo}`);
        console.log(`     Ubicaciones: ${data.ubicaciones.join(", ")}`);
        console.log(`     Operadores: ${data.operadores.map((o) => o.nombre).join(", ")}`);
        console.log(`     Descarga: ${data.descargaUrl}`);
      } catch (err) {
        console.error(`  Error scraping ${url}: ${err.message}`);
      }

      // Small delay between requests
      await page.waitForTimeout(1500);
    }

    console.log("\n=== Scraping complete ===");
  } finally {
    await browser.close();
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
