// custom/atlassian.mjs | run: node custom/atlassian.mjs

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15000;
const URL = "https://www.atlassian.com/endpoint/careers/listings";

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

function isSoftwareJob(title, category) {
  return SD_REGEX.test(title || "") || SD_REGEX.test(category || "");
}

function isIndiaLocation(locations) {
  if (!locations || !Array.isArray(locations)) return false;
  
  return locations.some(loc => {
    const locLower = loc.toLowerCase();
    
    // Check for exact Indian cities
    if (INDIA_LOCATIONS.some(city => locLower.includes(city))) return true;
    
    // Catch cases like "Remote - India - Remote"
    if (locLower.includes("india")) return true;
    
    return false;
  });
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  if (!dateString) return 0;
  
  // Parses dates like "2026-09-22 12:42 AM"
  const postedDate = new Date(dateString);
  if (isNaN(postedDate.getTime())) return 0;
  
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scraper Logic ----------
async function scrapeAtlassian() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  
  log(`   Fetching all jobs from Atlassian...`);

  const response = await fetch(URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching Atlassian API`);

  const jobs = await response.json();
  
  if (!Array.isArray(jobs)) {
    throw new Error(`Unexpected API response. Expected an array but got ${typeof jobs}`);
  }

  log(`   Found ${jobs.length} total globally in system`);

  for (const job of jobs) {
    if (!isIndiaLocation(job.locations)) {
      skipCounts.notIndia++;
      continue;
    }

    if (!isSoftwareJob(job.title, job.category)) {
      skipCounts.notSoftware++;
      continue;
    }

    const dateStr = job.portalJobPost?.updatedDate;
    const daysSincePosted = getDaysSincePosted(dateStr, currentTime);

    if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
      skipCounts.tooOld++;
      continue;
    }

    // Grab the first matched location string to display
    const primaryLocation = job.locations && job.locations.length > 0 ? job.locations[0] : "India";
    
    // Use the portalUrl so the applicant can view the job description before applying
    const jobUrl = job.portalJobPost?.portalUrl || job.applyUrl || `https://www.atlassian.com/company/careers/detail/${job.id}`;

    matchingJobs.push({
      company: "Atlassian",
      title: job.title,
      department: job.category || "N/A",
      location: primaryLocation,
      daysSincePosted: daysSincePosted,
      url: jobUrl
    });
  }

  log(`   Checked ${jobs.length} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTime = Date.now();
  log(`Starting Atlassian scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeAtlassian();
    log(`✅ Atlassian done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Atlassian failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, i) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;
    console.log(`${i + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);
}

await main();