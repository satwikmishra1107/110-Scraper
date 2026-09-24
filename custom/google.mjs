// custom/google.mjs | run: node custom/google.mjs
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
const MAX_PAGES_TO_FETCH = 30;
const GOOGLE_BASE_URL =
  "https://www.google.com/about/careers/applications/jobs/results/?location=India&degree=BACHELORS&sort_by=date&target_level=EARLY&target_level=MID";

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
  "c++",
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
  const skipCounts = { duplicate: 0, notSoftware: 0 };
  let totalJobsChecked = 0;
  const seenJobs = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    let currentPage = 1;

    while (currentPage <= MAX_PAGES_TO_FETCH) {
      log(`   Fetching Google jobs page ${currentPage}...`);

      const pageUrl = `${GOOGLE_BASE_URL}&page=${currentPage}`;
      
      await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 45000 })
        .catch(e => log(`   ⚠️ goto warning: ${e.message}`));

      try {
        await page.waitForFunction(
          () => document.body.innerText.includes("Learn more"),
          { timeout: 15000 },
        );
      } catch (error) {
        log(`   No jobs found on page ${currentPage} (or timed out). Ending pagination.`);
        break;
      }

      await delay(2000); 

      const extractedJobs = await page.evaluate(() => {
        const jobData = [];
        const headings = document.querySelectorAll("h2, h3");

        headings.forEach((heading) => {
          const title = heading.innerText.trim();
          if (!title) return;

          let cardNode = heading;
          let jobCard = null;

          while (cardNode && cardNode.parentElement) {
            cardNode = cardNode.parentElement;
            if (cardNode.innerText && cardNode.innerText.includes("Learn more")) {
              jobCard = cardNode;
              break;
            }
          }

          if (jobCard) {
            const lines = jobCard.innerText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
            const locationLine = lines.find((line) => line.includes("India")) || "India";
            const aTag = jobCard.querySelector("a");
            const url = aTag ? aTag.href : window.location.href;

            jobData.push({ title, location: locationLine, url });
          }
        });

        return jobData;
      });

      let newJobsFoundOnPage = 0;

      for (const job of extractedJobs) {
        totalJobsChecked++;
        const jobIdentifier = `${job.title} - ${job.url}`;

        if (seenJobs.has(jobIdentifier)) {
          skipCounts.duplicate++;
          continue;
        }

        seenJobs.add(jobIdentifier);
        newJobsFoundOnPage++;

        if (!isSoftwareJob(job.title)) {
          skipCounts.notSoftware++;
          continue;
        }

        matchingJobs.push({
          company: "Google",
          title: job.title,
          department: "Engineering / gTech",
          location: job.location.replace("Google | ", ""),
          daysSincePosted: "Recent (Sorted by Date)",
          url: job.url,
        });
      }

      log(`   Page ${currentPage} returned ${newJobsFoundOnPage} new distinct jobs.`);

      if (newJobsFoundOnPage === 0) {
        log(`   Hit a page with only duplicate jobs. Stopping pagination.`);
        break;
      }

      currentPage++;
      await delay(1000);
    }
  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  log(`   Checked ${totalJobsChecked} raw job cards in total`);
  log(`   Skipped: ${skipCounts.duplicate} duplicate, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTime = Date.now();
  log(`Starting Google scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeGoogle();
    log(`✅ Google done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Google failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, i) => {
    // Handle string-based visual dates instead of numbers
    const postedText = typeof job.daysSincePosted === 'number' 
      ? (job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`) 
      : (job.daysSincePosted || "Recent");

    console.log(`${i + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);
}

await main();