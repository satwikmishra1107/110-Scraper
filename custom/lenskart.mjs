// custom/lenskart.mjs | run: node custom/lenskart.mjs
import { pathToFileURL } from "node:url";

// ---------- Settings ----------
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


// ---------- Helpers ----------
function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, category) {
  return SD_REGEX.test(title || "") || SD_REGEX.test(category || "");
}

// These boards are almost all India, so a job counts as India unless its location names only foreign places.
// A fixed list of Indian cities kept missing real ones (Gurugram, Bhiwadi, Ahmedabad, ...)
const INDIA_PLACES_REGEX =
  /\b(?:india|pan[- ]?india|ncr|delhi|new delhi|okhla|gurgaon|gurugram|noida|faridabad|bengaluru|bangalore|hyderabad|mumbai|pune|chennai|kolkata|ahmedabad)\b/i;
const FOREIGN_PLACES_REGEX =
  /\b(?:uae|dubai|abu dhabi|saudi|riyadh|qatar|doha|singapore|japan|tokyo|thailand|bangkok|indonesia|jakarta|malaysia|philippines|vietnam|spain|madrid|italy|milan|united kingdom|uk|london|usa|united states|germany|france|netherlands|australia|canada)\b/i;

function isIndiaLocation(locationText) {
  if (!locationText) return false;
  const text = String(locationText);
  // "Gurugram / Singapore / Dubai" mentions India, so it stays
  if (INDIA_PLACES_REGEX.test(text)) return true;
  return !FOREIGN_PLACES_REGEX.test(text);
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
  const skipCounts = { notSoftware: 0, notIndia: 0 };
  
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
  // A missing jobs array means the API shape changed; fail loudly instead of reporting 0 jobs
  if (!Array.isArray(json.jobs)) {
    throw new Error(`Unexpected API response: no jobs array`);
  }
  const jobs = json.jobs;
  
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

    
    // The API returns relative apply URLs, so we prepend the base domain
    const jobUrl = job.apply_url ? `https://ainterviews.com${job.apply_url}` : `https://ainterviews.com/job_board/lenskart_ho/job/${job.id}/`;

    matchingJobs.push({
      id: String(job.id),
      company: "Lenskart",
      title: job.title,
      department: job.category || "N/A",
      location: job.location || "India",
      daysSincePosted: daysSincePosted,
      url: jobUrl
    });
  }

  log(`   Checked ${jobs.length} jobs in total`);
  log(`   Skipped: ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Lenskart scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeLenskart();
    log(`✅ Lenskart done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Lenskart failed: ${error.message}`);
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
