// custom/delhivery.mjs | run: node custom/delhivery.mjs
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 1;
const JOBS_PER_PAGE = 50; 
const MAX_PAGES_TO_FETCH = 20;
const REQUEST_TIMEOUT_MS = 15000;

// The frontend page we visit first, so Cloudflare accepts the browser (same approach as airtel.mjs)
const DELHIVERY_CAREERS_URL = "https://delhivery.darwinbox.in/ms/candidate/careers";
// The API we then call from inside that page. Relative, so it goes to the same site the page is on
const API_URL = "/ms/candidateapi/job/alljobs?companyId=main";

const SD_KEYWORDS = [
  "software", "engineer", "engineering", "technical", "developer",
  "backend", "frontend", "back-end", "front-end", "full stack",
  "full-stack", "system", "architect", "ui", "ux", "sde", "sdet"
];

// Matches whole words, optionally ending with 's' or 'ing'
const SD_REGEX = new RegExp(`\\b(?:${SD_KEYWORDS.join("|")})(?:s|ing)?\\b`, "i");
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai", "goa"
];

// ---------- Helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, department) {
  return SD_REGEX.test(title || "") || SD_REGEX.test(department || "");
}

function parseDarwinboxLocation(job) {
  const officeLocations = job.officelocations_without_area;
  // Check the array actually has a first entry before calling .replace on it
  if (Array.isArray(officeLocations) && officeLocations.length > 0 && officeLocations[0]) {
    return officeLocations[0].replace(/[\r\n]+/g, ', ');
  }
  // No "India" default: an unknown location should fail the India check, not pass it
  return job.locations || job.country || "";
}

function isIndiaLocation(locationText, countryCode) {
  if (countryCode && countryCode.toLowerCase() === "india") return true;
  if (!locationText) return false;
  
  const locLower = locationText.toLowerCase();
  
  if (locLower.includes("india")) return true;
  if (INDIA_LOCATIONS.some(city => locLower.includes(city))) return true;
  
  return false;
}

function getDaysSincePosted(timestampSeconds, currentTimeInMilliseconds) {
  if (!timestampSeconds) return 0; 
  const postedDate = new Date(timestampSeconds * 1000);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scraper Logic ----------
async function scrapeDelhivery() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  let totalJobsChecked = 0;

  log(`   Launching stealth browser to get past Cloudflare...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    log(`   Opening Delhivery careers page...`);
    // Wait for the network to settle so Cloudflare has finished and set its cookies
    await page.goto(DELHIVERY_CAREERS_URL, { waitUntil: "networkidle2", timeout: 45000 })
      .catch(gotoError => log(`   ⚠️ goto warning: ${gotoError.message}`));

    for (let pageNumber = 1; pageNumber <= MAX_PAGES_TO_FETCH; pageNumber++) {
      log(`   Fetching page ${pageNumber} via in-browser API request...`);

      // This function runs INSIDE Chromium, so the request carries the browser's cookies and fingerprint.
      // It returns the status and raw text instead of calling res.json(): if Cloudflare still blocks us,
      // res.json() on its HTML page would only give "Unexpected token <", which hides the real reason.
      const apiResult = await page.evaluate(async (apiEndpoint, requestedPage, limitAmount, timeoutMs) => {
        try {
          const res = await fetch(apiEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify({
              companyId: "main",
              page: requestedPage,
              sort_option: "new",
              limit: limitAmount,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          return { status: res.status, ok: res.ok, server: res.headers.get("server"), bodyText: await res.text() };
        } catch (fetchError) {
          return { fetchError: fetchError.message };
        }
      }, API_URL, pageNumber, JOBS_PER_PAGE, REQUEST_TIMEOUT_MS);

      if (apiResult.fetchError) {
        throw new Error(`In-browser fetch failed on page ${pageNumber}: ${apiResult.fetchError}`);
      }

      if (!apiResult.ok) {
        // Say who refused and what they sent back, so the health tab shows more than just "403"
        const pageTitle = apiResult.bodyText.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
        const responsePreview = pageTitle || apiResult.bodyText.replace(/\s+/g, " ").slice(0, 200);
        throw new Error(`HTTP ${apiResult.status} while fetching Delhivery API (${apiResult.server || "unknown server"}): ${responsePreview}`);
      }

      const jsonResponse = JSON.parse(apiResult.bodyText);

      // A missing data array means the API shape changed; fail loudly instead of reporting 0 jobs
      if (!Array.isArray(jsonResponse.data)) {
        throw new Error(`Unexpected API response on page ${pageNumber}: no data array`);
      }
      const jobs = jsonResponse.data;
    
      log(`   Page ${pageNumber} returned ${jobs.length} jobs`);
    
      if (jobs.length === 0) break;

      let foundOldJob = false;

      for (const job of jobs) {
        totalJobsChecked++;

        const daysSincePosted = getDaysSincePosted(job.posted_on, currentTime);

        // Jobs are sorted by "new", so we break when we hit old jobs
        if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
          skipCounts.tooOld++;
          foundOldJob = true;
          continue;
        }

        const locationText = parseDarwinboxLocation(job);

        if (!isIndiaLocation(locationText, job.country)) {
          skipCounts.notIndia++;
          continue;
        }

        const jobTitle = job.title || job.designation_name;
        const department = job.department_name_only || job.department_name;

        if (!isSoftwareJob(jobTitle, department)) {
          skipCounts.notSoftware++;
          continue;
        }
      
        const jobUrl = `https://delhivery.darwinbox.in/ms/candidate/job/job_detail/id/${job.id}`;

        matchingJobs.push({
          id: String(job.id),
          company: "Delhivery",
          title: jobTitle,
          department: department || "N/A",
          location: locationText,
          daysSincePosted: daysSincePosted,
          url: jobUrl
        });
      }

      if (foundOldJob) {
        log(`   Reached jobs older than ${MAX_POSTING_AGE_DAYS} days. Stopping pagination.`);
        break;
      }

      // Stop if the API returns fewer jobs than the limit (end of results)
      // (Note: if Delhivery forces a max limit of 10 despite us asking for 50, it will loop normally)
      if (jobs.length < (jsonResponse.limit || JOBS_PER_PAGE)) {
        break;
      }

      await delay(500); // Polite delay between pages
    }
  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Delhivery scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeDelhivery();
    log(`✅ Delhivery done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Delhivery failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = typeof job.daysSincePosted === 'number' 
      ? (job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`) 
      : job.daysSincePosted;

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
