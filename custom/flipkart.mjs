// custom/flipkart.mjs | run: node custom/flipkart.mjs
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 1;

// The correct TurboHire frontend URL
const FLIPKART_JOBS_URL = "https://flipkart.turbohire.co/dashboardv2?orgId=4d757ba0-3d57-448a-b82c-238ed87ac90f&type=0"; 
const API_INTERCEPT_TARGET = "/api/careerpagev2/filteredjobs"; 

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
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai", "ludhiana"
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

function parseFlipkartLocation(locString) {
  // No "India" default: an unknown location should fail the India check, not pass it
  if (!locString) return "";
  try {
    const parsed = JSON.parse(locString);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(locationEntry => locationEntry.Address).join(" | ");
    }
  } catch (parseError) {
    // Not JSON: fall through and check the raw text instead
  }
  return String(locString);
}

function isIndiaLocation(locationText) {
  if (!locationText) return false;
  const locLower = locationText.toLowerCase();
  
  if (locLower.includes("india")) return true;
  if (INDIA_LOCATIONS.some(city => locLower.includes(city))) return true;
  
  return false;
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  if (!dateString) return 0; 
  
  const postedDate = new Date(dateString);
  if (isNaN(postedDate.getTime())) return 0;
  
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scraper Logic ----------
async function scrapeFlipkart() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  
  log(`   Launching Stealth Browser to intercept Flipkart API...`);

  const browser = await puppeteer.launch({ 
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });

  let capturedJobs = [];
  let reportedTotalJobs = 0;
  let apiIntercepted = false;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // 1. Set up the network interceptor BEFORE navigating
    page.on('response', async (response) => {
      // Look for the specific TurboHire API POST request
      if (response.url().includes(API_INTERCEPT_TARGET) && response.request().method() === 'POST') {
        try {
          const json = await response.json();
          if (json && json.Result) {
            capturedJobs = json.Result;
            reportedTotalJobs = json.Total || capturedJobs.length;
            apiIntercepted = true;
            log(`   ✅ Successfully intercepted TurboHire API! Found ${json.Total || capturedJobs.length} raw jobs.`);
          }
        } catch (e) {
          // Ignore parse errors on pre-flight checks (OPTIONS requests)
        }
      }
    });

    log(`   Navigating to TurboHire frontend...`);
    
    // 2. Go to the page (the frontend will automatically generate the Bearer token and fetch the jobs)
    await page.goto(FLIPKART_JOBS_URL, { waitUntil: 'networkidle2', timeout: 45000 })
      .catch(e => log(`   ⚠️ goto warning: ${e.message}`));

    // 3. Wait safely until the API interception triggers (max 15 seconds)
    let waitTime = 0;
    while (!apiIntercepted && waitTime < 15000) {
      await delay(1000);
      waitTime += 1000;
    }

  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  if (capturedJobs.length === 0) {
    throw new Error("Failed to intercept job data. The API might have timed out or structure changed.");
  }

  // The frontend only requests the first page; warn when the API says there are more
  if (reportedTotalJobs > capturedJobs.length) {
    log(`   ⚠️ API reports ${reportedTotalJobs} jobs but only ${capturedJobs.length} were captured. Later pages are being missed.`);
  }

  log(`   Filtering intercepted jobs...`);

  for (const job of capturedJobs) {
    const locationText = parseFlipkartLocation(job.Location);

    if (!isIndiaLocation(locationText)) {
      skipCounts.notIndia++;
      continue;
    }

    if (!isSoftwareJob(job.JobTitle, job.Department)) {
      skipCounts.notSoftware++;
      continue;
    }

    // PublishedDate only: falling back to UpdatedDate would make every edit look like a repost
    const daysSincePosted = getDaysSincePosted(job.PublishedDate, currentTime);

    if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
      skipCounts.tooOld++;
      continue;
    }
    
    // Use the TurboHire domain for the job link
    const jobUrl = `https://flipkart.turbohire.co/job/${job.JobIdObfuscated || job.JobId}`;

    matchingJobs.push({
      id: String(job.JobId),
      company: "Flipkart",
      title: job.JobTitle,
      department: job.Department || "N/A",
      location: locationText,
      daysSincePosted: daysSincePosted,
      url: jobUrl
    });
  }

  log(`   Checked ${capturedJobs.length} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Flipkart scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeFlipkart();
    log(`✅ Flipkart done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Flipkart failed: ${error.message}`);
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
