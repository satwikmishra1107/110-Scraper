// custom/zoho.mjs | run: node custom/zoho.mjs
import { pathToFileURL } from "node:url";

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 1;
const REQUEST_TIMEOUT_MS = 15000;

// We check both the Global Corporate portal and the APAC regional portal
const ZOHO_ENDPOINTS = [
  "https://careers.zohocorp.com/recruit/v2/public/Job_Openings?pagename=Careers&source=CareerSite&extra_fields=%5B%22Remote_Job%22%2C%22Job_Description%22%5D",
  "https://zohoapac.zohorecruit.in/recruit/v2/public/Job_Openings?pagename=Careers&source=CareerSite&extra_fields=%5B%22Remote_Job%22%2C%22Job_Description%22%5D"
];

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

// Matches whole words, optionally ending with 's' or 'ing'
const SD_REGEX = new RegExp(`\\b(?:${SD_KEYWORDS.join("|")})(?:s|ing)?\\b`, "i");
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai"
];

// ---------- Helpers ----------
function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, description) {
  return SD_REGEX.test(title || "");
}

function isIndiaLocation(job) {
  // Zoho uses different location keys depending on the portal (Country, Country1, City, State)
  const locString = `${job.Country || ""} ${job.Country1 || ""} ${job.City || ""} ${job.State || ""}`.toLowerCase();
  
  if (locString.includes("india")) return true;
  if (INDIA_LOCATIONS.some(city => locString.includes(city))) return true;
  
  return false;
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  if (!dateString) return 0; // If Zoho doesn't provide a date, treat it as new/recent
  
  const postedDate = new Date(dateString);
  if (isNaN(postedDate.getTime())) return 0;
  
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scraper Logic ----------
async function scrapeZoho() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  let totalJobsChecked = 0;
  let failedPortalCount = 0;
  
  for (const apiUrl of ZOHO_ENDPOINTS) {
    const portalName = apiUrl.includes("zohoapac") ? "APAC Portal" : "Global Portal";
    log(`   Fetching all jobs from Zoho ${portalName}...`);

    const response = await fetch(apiUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      log(`   ⚠️ HTTP ${response.status} while fetching ${portalName}. Skipping...`);
      failedPortalCount++;
      continue;
    }

    const json = await response.json();
    const jobs = json.data || [];
    
    log(`   Found ${jobs.length} total jobs in ${portalName}`);

    for (const job of jobs) {
      totalJobsChecked++;

      // Filter by Location
      if (!isIndiaLocation(job)) {
        skipCounts.notIndia++;
        continue;
      }

      // Filter by Domain (Title)
      if (!isSoftwareJob(job.Posting_Title)) {
        skipCounts.notSoftware++;
        continue;
      }

      // Filter by Date (If available)
      const daysSincePosted = getDaysSincePosted(job.Date_Opened, currentTime);

      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        continue;
      }

      // Construct a clean location string for display
      const displayLocation = [job.City, job.State, job.Country || job.Country1]
        .filter(Boolean)
        .join(", ") || "India";

      matchingJobs.push({
        id: String(job.id),
        company: "Zoho",
        title: job.Posting_Title,
        department: job.Industry || "N/A",
        location: displayLocation,
        daysSincePosted: job.Date_Opened ? daysSincePosted : null, // null instead of a text label
        url: job.$url
      });
    }
  }

  // One portal failing is a warning; both failing means we saw nothing, so fail loudly
  if (failedPortalCount === ZOHO_ENDPOINTS.length) {
    throw new Error(`All ${ZOHO_ENDPOINTS.length} Zoho portals failed`);
  }

  log(`   Checked ${totalJobsChecked} jobs in total across all portals`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Zoho scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeZoho();
    log(`✅ Zoho done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Zoho failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    // null means Zoho gave no date
    const postedText = typeof job.daysSincePosted === 'number' 
      ? (job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`) 
      : "Recent";

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
