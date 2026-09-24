// custom/lenskart.mjs | run: node custom/lenskart.mjs

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15000;

// AInterviews API endpoint used by Lenskart
const URL = "https://ainterviews.com/api/job_board/lenskart_ho/jobs/";

const SD_KEYWORDS = [
  "software", "engineer", "engineering", "technical", "developer",
  "backend", "frontend", "back-end", "front-end", "full stack",
  "full-stack", "system", "architect", "ui", "ux", "sde", "sdet",
  "react", "node", "java", "c\\+\\+", "typescript", "mongo", "tech"
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
async function scrapeLenskart() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0, notIndia: 0 };
  
  log(`   Fetching all jobs from Lenskart (AInterviews API)...`);

  const response = await fetch(URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching Lenskart API`);
  }

  const json = await response.json();
  const jobs = json.jobs || [];
  
  log(`   API reports ${jobs.length} total jobs in system`);

  for (const job of jobs) {
    if (!isIndiaLocation(job.location)) {
      skipCounts.notIndia++;
      continue;
    }

    if (!isSoftwareJob(job.title, job.category)) {
      skipCounts.notSoftware++;
      continue;
    }

    const daysSincePosted = getDaysSincePosted(job.posted_date, currentTime);

    if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
      skipCounts.tooOld++;
      continue;
    }
    
    // The API returns relative apply URLs, so we prepend the base domain
    const jobUrl = job.apply_url ? `https://ainterviews.com${job.apply_url}` : `https://ainterviews.com/job_board/lenskart_ho/job/${job.id}/`;

    matchingJobs.push({
      company: "Lenskart",
      title: job.title,
      department: job.category || "N/A",
      location: job.location || "India",
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
  log(`Starting Lenskart scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeLenskart();
    log(`✅ Lenskart done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Lenskart failed: ${error.message}`);
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