// custom/airtel.mjs | run: node custom/airtel.mjs
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
const JOBS_PER_PAGE = 50;
// Safety cap only: pagination normally ends when every job the API counts has been read
const MAX_PAGES_TO_FETCH = 100;

// The frontend URL we visit to clear Cloudflare. Airtel itself, not "bhartifoundation" (the charity's board)
const AIRTEL_CAREERS_URL = "https://airtel.darwinbox.in/ms/candidate/careers";
// The API URL we will query from inside the browser
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
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai", "ranchi"
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
    // Raw values look like "Gurgaon, Haryana\r, India": the comma is already there, so just drop the line break
    return officeLocations[0].replace(/[\r\n]+/g, "");
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
async function scrapeAirtel() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { notSoftware: 0, notIndia: 0 };
  let totalJobsChecked = 0;
  let totalJobsInAPI = null;

  log(`   Launching Stealth Browser to bypass Cloudflare...`);

  const browser = await puppeteer.launch({ 
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    log(`   Navigating to Airtel (Bharti) careers page...`);
    
    // Visit the frontend page. Wait for network to settle so Cloudflare cookies are set.
    await page.goto(AIRTEL_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 45000 })
      .catch(e => log(`   ⚠️ goto warning: ${e.message}`));

    // Now that we are cleared by Cloudflare, we run a loop to fetch jobs directly inside the browser!
    for (let pageNum = 1; pageNum <= MAX_PAGES_TO_FETCH; pageNum++) {
      log(`   Fetching page ${pageNum} via in-browser API request...`);

      // Execute the fetch request INSIDE the Chromium browser context
      const jsonResponse = await page.evaluate(async (apiEndpoint, pageNumber, limitAmount) => {
        try {
          const res = await fetch(apiEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "XMLHttpRequest"
            },
            body: JSON.stringify({
              companyId: "main",
              page: pageNumber,
              sort_option: "new",
              limit: limitAmount
            })
          });
          return await res.json();
        } catch (e) {
          return { error: e.message };
        }
      }, API_URL, pageNum, JOBS_PER_PAGE);

      if (jsonResponse.error) {
        throw new Error(`In-browser fetch failed: ${jsonResponse.error}`);
      }

      // A missing data array means the API shape changed; fail loudly instead of reporting 0 jobs
      if (!Array.isArray(jsonResponse.data)) {
        throw new Error(`Unexpected API response on page ${pageNum}: no data array`);
      }
      const jobs = jsonResponse.data;
      if (totalJobsInAPI === null) {
        totalJobsInAPI = Number(jsonResponse.job_counts) || null;
        log(`   API reports ${totalJobsInAPI ?? "?"} open jobs`);
      }
      log(`   Page ${pageNum} returned ${jobs.length} jobs`);

      if (jobs.length === 0) break;

      for (const job of jobs) {
        totalJobsChecked++;

        const daysSincePosted = getDaysSincePosted(job.posted_on, currentTime);
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
        
        const jobUrl = `https://airtel.darwinbox.in/ms/candidate/job/job_detail/id/${job.id}`;

        matchingJobs.push({
          id: String(job.id),
          company: "Airtel (Bharti)",
          title: jobTitle,
          department: department || "N/A",
          location: locationText,
          daysSincePosted: daysSincePosted,
          url: jobUrl
        });
      }

      // Every job is read: stop once the API's own count is reached, or on a short page
      if (totalJobsInAPI !== null && totalJobsChecked >= totalJobsInAPI) break;
      if (jobs.length < JOBS_PER_PAGE) break;

      await delay(1000); 
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
  log(`Starting Airtel scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeAirtel();
    log(`✅ Airtel done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Airtel failed: ${error.message}`);
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
