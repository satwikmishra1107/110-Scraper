// custom/hsbc.mjs | run: node custom/hsbc.mjs

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 7;
const JOBS_PER_PAGE = 50;
const MAX_PAGES_TO_FETCH = 20; 
const REQUEST_TIMEOUT_MS = 15000;

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
  "c\\+\\+",
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

function isSoftwareJob(title, department) {
  return SD_REGEX.test(title || "") || SD_REGEX.test(department || "");
}

function isIndiaLocation(locationText) {
  if (!locationText) return false;
  const locLower = locationText.toLowerCase();
  
  if (locLower.includes("india")) return true;
  if (INDIA_LOCATIONS.some(city => locLower.includes(city))) return true;
  
  return false;
}

function getDaysSincePosted(timestampSeconds, currentTimeInMilliseconds) {
  if (!timestampSeconds) return 0;
  // Eightfold timestamps are in seconds, so we multiply by 1000 for JS
  const postedDate = new Date(timestampSeconds * 1000);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scraper Logic ----------
async function scrapeHSBC() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  
  let startOffset = 0;
  let totalJobsChecked = 0;
  let totalJobsInAPI = Infinity;

  for (let page = 0; page < MAX_PAGES_TO_FETCH && startOffset < totalJobsInAPI; page++) {
    log(`   Fetching page ${page + 1} (offset ${startOffset})...`);
    
    // The standard Eightfold search endpoint
    const apiUrl = `https://portal.careers.hsbc.com/api/apply/v2/jobs?domain=hsbc.com&location=India&start=${startOffset}&num=${JOBS_PER_PAGE}`;
    
    let response;
    let success = false;

    // 429 Retry Loop (Up to 3 attempts per page - Eightfold is strict!)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await fetch(apiUrl, {
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.status === 429) {
          log(`     ⚠️ 429 Rate Limited. Cooling down for ${attempt * 3} seconds...`);
          await delay(attempt * 3000);
          continue;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        success = true;
        break; 
      } catch (err) {
        if (attempt === 3) throw err;
      }
    }

    if (!success) throw new Error("Hit maximum 429 rate limits. Giving up.");

    const data = await response.json();
    const positions = data.positions || [];
    
    if (page === 0) {
      totalJobsInAPI = data.count || positions.length;
      log(`   API reports ${totalJobsInAPI} total jobs in India`);
    }

    if (positions.length === 0) break;

    for (const job of positions) {
      totalJobsChecked++;

      if (!isIndiaLocation(job.location)) {
        skipCounts.notIndia++;
        continue;
      }

      if (!isSoftwareJob(job.name, job.department)) {
        skipCounts.notSoftware++;
        continue;
      }
      
      const daysSincePosted = getDaysSincePosted(job.t_update, currentTime);

      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        continue;
      }

      const jobUrl = job.canonicalPositionUrl || `https://portal.careers.hsbc.com/careers/job/${job.id}`;

      matchingJobs.push({
        company: "HSBC",
        title: job.name,
        department: job.department || "N/A",
        location: job.location || "India",
        daysSincePosted: daysSincePosted,
        url: jobUrl
      });
    }

    startOffset += JOBS_PER_PAGE;
    if (startOffset < totalJobsInAPI) await delay(1000);
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTime = Date.now();
  log(`Starting HSBC scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeHSBC();
    log(`✅ HSBC done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ HSBC failed: ${error.message}`);
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