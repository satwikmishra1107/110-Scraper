// custom/nike.mjs | run: node custom/nike.mjs
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { htmlToText } from "../score/descriptions.mjs";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
// The API returns 10 jobs per page whatever is asked for. India had 82 jobs (9 pages) when this was written
const MAX_PAGES_TO_FETCH = 40;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_DESCRIPTION_CHARS = 20_000; // same cap as score/descriptions.mjs

// Akamai answers 403 "Access Denied" to anything but a real browser, and the API also wants the "ct" session cookie
// that this search page sets. So we open the page first, then call the API from inside it (same idea as uber.mjs)
const NIKE_JOBS_PAGE_URL = "https://careers.nike.com/jobs?location_name=India&location_type=4";
// Relative, so it goes to the same site the page is on and carries its cookies. POST, not GET: GET gets a 403
const API_PATH = "/api/get-jobs?radius=15&location_type=4&location_name=India&enable_kilometers=false";
// The body the site itself sends (languages trimmed to English)
const API_BODY = { disable_switch_search_mode: false, site_available_languages: ["en"] };

// Every job here is also on Nike's Workday board (workday.json), which workday.mjs scrapes. The job id is the Workday
// path ("/job/Karnataka-India/…_R-92767"), the same id workday.mjs saves, so a job found by both is one row, not two
const WORKDAY_BOARD_URL = "https://nike.wd1.myworkdayjobs.com/nke";

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "karnataka", "hyderabad",
  "mumbai", "pune", "gurgaon", "gurugram", "noida", "delhi", "chennai"
];

// ---------- Helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

// Job family is e.g. "Software Engineering", "Information Security Platform Engineering", "Stores"
function isSoftwareJob(title, jobFamily) {
  return SOFTWARE_PATTERN.test(title || "") || SOFTWARE_PATTERN.test(jobFamily || "");
}

// location_name=India is applied by the API, but check each job too (same as Netflix), whole words only
const INDIA_LOCATION_REGEX = new RegExp(`\\b(?:${INDIA_LOCATIONS.join("|")})\\b`, "i");

function isIndiaLocation(locationText) {
  if (!locationText) return false;
  return INDIA_LOCATION_REGEX.test(String(locationText));
}

// Bengaluru jobs come as city "Karnataka", state "Karnataka", so repeats are dropped: "Karnataka, India"
function getLocationText(job) {
  const location = job.locations?.[0] || {};
  return [...new Set([location.city, location.state, location.country].filter(Boolean))].join(", ");
}

const getCustomField = (job, fieldKey) => job.customFields?.find(field => field.cfKey === fieldKey)?.value;

async function fetchPage(page, pageNumber) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // This function runs INSIDE Chromium, so the request carries the browser's cookies and fingerprint.
    // It returns the status and raw text instead of calling res.json(), so a block page shows up as a clear error
    const apiResult = await page.evaluate(async (apiUrl, requestBody, timeoutMs) => {
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, ok: res.ok, bodyText: await res.text() };
      } catch (fetchError) {
        return { fetchError: fetchError.message };
      }
    }, `${API_PATH}&page_number=${pageNumber}`, API_BODY, REQUEST_TIMEOUT_MS);

    if (apiResult.ok) return JSON.parse(apiResult.bodyText);

    const problem = apiResult.fetchError || `HTTP ${apiResult.status}: ${apiResult.bodyText.replace(/\s+/g, " ").slice(0, 100)}`;
    if (attempt === 3) throw new Error(`In-browser fetch failed on page ${pageNumber}: ${problem}`);

    log(`     ⚠️ ${problem}, retrying in ${attempt * 3} seconds...`);
    await delay(attempt * 3000);
  }
}

// ---------- Scraper Logic ----------
async function scrapeNike() {
  const matchingJobs = [];
  const skipCounts = { notSoftware: 0, notIndia: 0, noWorkdayLink: 0 };
  let totalJobsChecked = 0;
  let totalJobsInAPI = null;

  log(`   Launching stealth browser to get past Akamai...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    log(`   Opening Nike careers search page...`);
    // Wait for the network to settle so the session cookie is set
    await page.goto(NIKE_JOBS_PAGE_URL, { waitUntil: "networkidle2", timeout: 60000 })
      .catch(gotoError => log(`   ⚠️ goto warning: ${gotoError.message}`));

    for (let pageNumber = 1; pageNumber <= MAX_PAGES_TO_FETCH; pageNumber++) {
      log(`   Fetching page ${pageNumber} via in-browser API request...`);
      const data = await fetchPage(page, pageNumber);

      // A missing jobs array means the API shape changed; fail loudly instead of reporting 0 jobs
      if (!Array.isArray(data.jobs)) {
        throw new Error(`Unexpected API response on page ${pageNumber}: no jobs array`);
      }

      if (pageNumber === 1) {
        totalJobsInAPI = Number(data.totalJob) || null;
        log(`   API reports ${totalJobsInAPI ?? "?"} jobs in India`);
      }

      if (data.jobs.length === 0) break;

      for (const job of data.jobs) {
        totalJobsChecked++;

        const locationText = getLocationText(job);
        if (!isIndiaLocation(locationText)) {
          skipCounts.notIndia++;
          continue;
        }

        const jobFamily = getCustomField(job, "cf_job_family");
        if (!isSoftwareJob(job.title, jobFamily)) {
          skipCounts.notSoftware++;
          continue;
        }

        // e.g. https://nike.wd1.myworkdayjobs.com/nke/job/Karnataka-India/Software-Engineer-II--ITC_R-86716/apply.
        // workday.mjs saves the job's page path, without the trailing "/apply"
        const workdayPath = job.applyURL?.startsWith(WORKDAY_BOARD_URL)
          ? job.applyURL.slice(WORKDAY_BOARD_URL.length).replace(/\/apply\/?$/, "")
          : null;
        if (!workdayPath) {
          // Without it the job can't share an id with workday.mjs, and would be saved (and pinged) twice
          skipCounts.noWorkdayLink++;
          log(`   ⚠️ "${job.title}" has no Workday link (${job.applyURL}), skipped`);
          continue;
        }

        matchingJobs.push({
          id: workdayPath,
          company: "Nike",
          title: job.title,
          department: jobFamily || "N/A",
          location: locationText || "India",
          daysSincePosted: null, // the API has no posted date (workday.mjs saves it for the jobs it finds first)
          url: `https://careers.nike.com/${job.originalURL}`,
          // The list includes the full description, so it's kept here for scoring (see run-all.mjs)
          description: htmlToText(job.description).slice(0, MAX_DESCRIPTION_CHARS) || null
        });
      }

      // Every job is read: stop once the API's own count is reached, or on a short page
      if (totalJobsInAPI !== null && totalJobsChecked >= totalJobsInAPI) break;
      if (data.jobs.length < 10) break;

      await delay(1000);
    }
  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  // Fewer jobs than the API promised means pages were missed; say so instead of passing quietly
  if (totalJobsInAPI !== null && totalJobsChecked < totalJobsInAPI) {
    log(`   ⚠️ Only ${totalJobsChecked} of ${totalJobsInAPI} jobs were read`);
  }
  log(`   Skipped: ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India, ${skipCounts.noWorkdayLink} without a Workday link`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Nike scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeNike();
    log(`✅ Nike done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Nike failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: Date not shown`);
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
