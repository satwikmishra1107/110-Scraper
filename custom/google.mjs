// custom/google.mjs | run: node custom/google.mjs
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
// Safety cap only: pagination normally ends on the first page that has no job cards
const MAX_PAGES_TO_FETCH = 100;
const GOOGLE_BASE_URL =
  "https://www.google.com/about/careers/applications/jobs/results/?location=India&degree=BACHELORS&sort_by=date&target_level=EARLY";

const SD_KEYWORDS = [
  "software",
  "engineer",
  "engineering",
  "technical",
  "developer",
  "backend",
  "frontend",
  "back-end",
  "front-end",
  "full stack",
  "full-stack",
  "system",
  "architect",
  "ui",
  "ux",
  "sde",
  "sdet",
  "react",
  "node",
  "java",
  "c\\+\\+", // + must be escaped: an unescaped "c++" crashes the regex below
  "typescript",
  "mongo",
];

const SD_REGEX = new RegExp(`\\b(?:${SD_KEYWORDS.join("|")})(?:s|ing)?\\b`, "i");

// ---------- Helpers ----------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title) {
  return SD_REGEX.test(title || "");
}

// ---------- Scraper Logic ----------
async function scrapeGoogle() {
  log(`Launching Stealth Browser for Google...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const matchingJobs = [];
  let notSoftwareCount = 0;
  let totalJobsChecked = 0;
  let totalJobsOnSite = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    for (let currentPage = 1; currentPage <= MAX_PAGES_TO_FETCH; currentPage++) {
      log(`   Fetching Google jobs page ${currentPage}...`);

      const pageUrl = `${GOOGLE_BASE_URL}&page=${currentPage}`;

      await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 45000 })
        .catch(e => log(`   ⚠️ goto warning: ${e.message}`));

      // Wait for the results header ("23 jobs matched"); it renders on empty pages too
      try {
        await page.waitForFunction(
          () => /\d+ jobs? matched/.test(document.body.innerText),
          { timeout: 15000 },
        );
      } catch (error) {
        throw new Error(`Results never loaded on page ${currentPage}`);
      }

      await delay(2000);

      const { matchedCount, extractedJobs } = await page.evaluate(() => {
        const jobData = [];

        // Job hrefs are relative ("jobs/results/<id>-<slug>?..."), so match without a leading slash.
        // One <li> per job; reading the <h3> from it avoids the tooltip <h2>s inside each card.
        document.querySelectorAll('a[href*="jobs/results/"]').forEach((jobLink) => {
          const jobId = jobLink.href.match(/\/jobs\/results\/(\d+)/)?.[1];
          if (!jobId) return; // pagination / nav links

          const jobCard = jobLink.closest("li");
          const title = jobCard?.querySelector("h3")?.innerText.trim();
          if (!title) return;

          // The location line comes right after the "place" icon text
          const lines = jobCard.innerText.split("\n").map((line) => line.trim()).filter(Boolean);
          const placeIndex = lines.indexOf("place");
          const locationLine = placeIndex >= 0 ? lines[placeIndex + 1] : lines.find((line) => line.includes("India"));

          jobData.push({ id: jobId, title, location: locationLine || "India", url: jobLink.href });
        });

        const matchedText = document.body.innerText.match(/(\d+) jobs? matched/);
        return { matchedCount: matchedText ? Number(matchedText[1]) : null, extractedJobs: jobData };
      });

      if (totalJobsOnSite === null) totalJobsOnSite = matchedCount;
      log(`   Page ${currentPage} returned ${extractedJobs.length} jobs.`);

      if (extractedJobs.length === 0) {
        log(`   Reached the end of the results.`);
        break;
      }

      for (const job of extractedJobs) {
        totalJobsChecked++;

        if (!isSoftwareJob(job.title)) {
          notSoftwareCount++;
          continue;
        }

        matchingJobs.push({
          id: job.id,
          company: "Google",
          title: job.title,
          department: null, // not shown on the results page; null instead of a made-up value
          location: job.location,
          daysSincePosted: null, // not shown on the results page
          url: job.url,
        });
      }

      await delay(1000);
    }
  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  log(`   Checked ${totalJobsChecked} job cards (site says ${totalJobsOnSite ?? "?"} matched)`);
  log(`   Skipped: ${notSoftwareCount} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Google scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeGoogle();
    log(`✅ Google done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Google failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department || "N/A"})`);
    console.log(`   Location: ${job.location}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);

  // Hand the results back to whoever called main() (the common custom runner)
  return { allJobs, scrapeFailed, errorMessage };
}

// Run main() only when started directly (node custom/<file>.mjs),
// not when the common custom runner imports this file
const isRunDirectly = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) {
  await main();
}
