// custom/uber.mjs | run: node custom/uber.mjs
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { htmlToText } from "../score/descriptions.mjs";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
// countries=India filters on Uber's side. "pagesize" must be lowercase: the API ignores "pageSize" and returns 10 per page
const PAGE_SIZE = 100;
// Safety cap only: India had 23 jobs when this was written, so one page is normally enough
const MAX_PAGES_TO_FETCH = 10;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_DESCRIPTION_CHARS = 20_000; // same cap as score/descriptions.mjs

// Cloudflare checks the TLS fingerprint, so Node's fetch gets a 403 "Just a moment..." page even with a
// browser User-Agent (curl gets through, Node doesn't). So we open this page in a real browser first,
// then call the API from inside it (same approach as delhivery.mjs)
const UBER_CAREERS_URL = "https://jobs.uber.com/en/";
// Relative, so it goes to the same site the page is on and carries its cookies
const API_PATH = "/api/jobs/search/";

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad",
  "mumbai", "pune", "gurgaon", "gurugram", "noida", "delhi", "chennai"
];

// ---------- Helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

// Teams is "Engineer" for engineering roles, which the pattern matches as a whole word
function isSoftwareJob(title, teams) {
  return SOFTWARE_PATTERN.test(title || "") || SOFTWARE_PATTERN.test(teams || "");
}

// countries=India is applied by the API, but check each job too (same as Netflix), whole words only
const INDIA_LOCATION_REGEX = new RegExp(`\\b(?:${INDIA_LOCATIONS.join("|")})\\b`, "i");

function isIndiaLocation(locationText) {
  if (!locationText) return false;
  return INDIA_LOCATION_REGEX.test(String(locationText));
}

// A job can list several offices, e.g. "Hyderabad, Bengaluru"
function getLocationText(job) {
  const locations = Array.isArray(job.Locations) ? job.Locations : [];
  return locations.map(location => location.City || location.Address || location.Country).filter(Boolean).join(", ");
}

function getDaysSincePosted(isoDate, currentTimeInMilliseconds) {
  if (!isoDate) return 0;
  const postedDate = new Date(isoDate);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

async function fetchPage(page, pageNumber) {
  const apiUrl = `${API_PATH}?countries=India&pagesize=${PAGE_SIZE}&page=${pageNumber}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    // This function runs INSIDE Chromium, so the request carries the browser's cookies and fingerprint.
    // It returns the status and raw text instead of calling res.json(): if Cloudflare still blocks us,
    // res.json() on its HTML page would only give "Unexpected token <", which hides the real reason.
    const apiResult = await page.evaluate(async (apiEndpoint, timeoutMs) => {
      try {
        const res = await fetch(apiEndpoint, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, ok: res.ok, bodyText: await res.text() };
      } catch (fetchError) {
        return { fetchError: fetchError.message };
      }
    }, apiUrl, REQUEST_TIMEOUT_MS);

    if (apiResult.ok) return JSON.parse(apiResult.bodyText);

    const pageTitle = apiResult.bodyText?.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    const problem = apiResult.fetchError || `HTTP ${apiResult.status}${pageTitle ? ` (${pageTitle})` : ""}`;
    if (attempt === 3) throw new Error(`In-browser fetch failed on page ${pageNumber}: ${problem}`);

    log(`     ⚠️ ${problem}, retrying in ${attempt * 3} seconds...`);
    await delay(attempt * 3000);
  }
}

// ---------- Scraper Logic ----------
async function scrapeUber() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { notSoftware: 0, notIndia: 0 };
  let totalJobsChecked = 0;
  let totalPages = 1;

  log(`   Launching stealth browser to get past Cloudflare...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    log(`   Opening Uber careers page...`);
    // Wait for the network to settle so Cloudflare has finished and set its cookies
    await page.goto(UBER_CAREERS_URL, { waitUntil: "networkidle2", timeout: 45000 })
      .catch(gotoError => log(`   ⚠️ goto warning: ${gotoError.message}`));

    // Results are only roughly newest-first (older jobs show up between new ones), so read every page
    for (let pageNumber = 1; pageNumber <= Math.min(totalPages, MAX_PAGES_TO_FETCH); pageNumber++) {
      log(`   Fetching page ${pageNumber} via in-browser API request...`);
      const data = await fetchPage(page, pageNumber);

      // A missing jobs array means the API shape changed; fail loudly instead of reporting 0 jobs
      if (!Array.isArray(data.jobs)) {
        throw new Error(`Unexpected API response on page ${pageNumber}: no jobs array`);
      }

      if (pageNumber === 1) {
        totalPages = data.totalPages || 1;
        log(`   API reports ${data.totalJobs} total jobs in India across ${totalPages} page(s)`);
      }

      if (data.jobs.length === 0) break;

      for (const job of data.jobs) {
        totalJobsChecked++;

        const locationText = getLocationText(job);
        if (!isIndiaLocation(locationText)) {
          skipCounts.notIndia++;
          continue;
        }

        const teams = (job.Teams || []).join(", ");
        if (!isSoftwareJob(job.Title, teams)) {
          skipCounts.notSoftware++;
          continue;
        }

        const jobPath = job.Urls?.find(url => url.IsDefault)?.Url || job.Urls?.[0]?.Url || `/en/jobs/${job.Id}/`;

        matchingJobs.push({
          id: String(job.Id),
          company: "Uber",
          title: job.Title,
          department: teams || "N/A",
          location: locationText || "India",
          daysSincePosted: getDaysSincePosted(job.DisplayDate, currentTime),
          url: `https://jobs.uber.com${jobPath}`,
          // The search API includes the full description, so it's kept here for scoring (see run-all.mjs)
          description: htmlToText(job.Description).slice(0, MAX_DESCRIPTION_CHARS) || null
        });
      }

      if (pageNumber < totalPages) await delay(1000);
    }
  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Uber scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeUber();
    log(`✅ Uber done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Uber failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;
    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
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
