// custom/amd.mjs | run: node custom/amd.mjs

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES_TO_FETCH = 20;

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
// Matches whole words, optionally ending with 's' or 'ing'
const SD_REGEX = new RegExp(`\\b(?:${SD_KEYWORDS.join("|")})(?:s|ing)?\\b`, "i");
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai"
];

// ---------- Helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, category) {
  return SD_REGEX.test(title || "") || SD_REGEX.test(category || "");
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
async function scrapeAMD() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  let totalJobsChecked = 0;
  
  let currentPage = 1;

  while (currentPage <= MAX_PAGES_TO_FETCH) {
    log(`   Fetching AMD jobs page ${currentPage}...`);

    // The API natively sorts by posted_date (descending) and limits to Engineering + India
    const apiUrl = `https://careers.amd.com/api/jobs?country=India&page=${currentPage}&categories=Engineering&sortBy=posted_date&limit=100&descending=true&internal=false`;

    const response = await fetch(apiUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching AMD API`);
    }

    const json = await response.json();
    const jobs = json.jobs || [];

    log(`   Page ${currentPage} returned ${jobs.length} jobs`);

    if (jobs.length === 0) break;

    for (const job of jobs) {
      const jobData = job.data;
      if (!jobData) continue;

      totalJobsChecked++;

      if (!isIndiaLocation(jobData.full_location || jobData.country)) {
        skipCounts.notIndia++;
        continue;
      }

      // Department usually comes in an array format inside category or categories
      const department = (jobData.category && jobData.category[0]) || 
                         (jobData.categories && jobData.categories[0]?.name) || "Engineering";

      if (!isSoftwareJob(jobData.title, department)) {
        skipCounts.notSoftware++;
        continue;
      }

      const daysSincePosted = getDaysSincePosted(jobData.posted_date, currentTime);

      // Not breaking early just in case AMD's API sorting is buggy, we'll scan the whole array
      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        continue;
      }

      matchingJobs.push({
        company: "AMD",
        title: jobData.title,
        department: department.trim(),
        location: jobData.full_location || jobData.city || "India",
        daysSincePosted: daysSincePosted,
        url: jobData.canonical_url || jobData.apply_url
      });
    }

    // Stop if the page isn't full (we've reached the absolute end of the list)
    if (jobs.length < 100) {
      log(`   Reached end of results. Stopping pagination.`);
      break;
    }

    currentPage++;
    await delay(1000); // 1-second pause to prevent rate limits
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTime = Date.now();
  log(`Starting AMD scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeAMD();
    log(`✅ AMD done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ AMD failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, i) => {
    const postedText = typeof job.daysSincePosted === 'number' 
      ? (job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`) 
      : job.daysSincePosted;

    console.log(`${i + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);
}

await main();