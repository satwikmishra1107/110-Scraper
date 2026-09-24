// custom/delhivery.mjs | run: node custom/delhivery.mjs

// ---------- Settings ----------
const MAX_POSTING_AGE_DAYS = 7;
const JOBS_PER_PAGE = 50; 
const MAX_PAGES_TO_FETCH = 20;
const REQUEST_TIMEOUT_MS = 15000;

// Darwinbox API endpoint used by Delhivery
const URL = "https://delhivery.darwinbox.in/ms/candidateapi/job/alljobs?companyId=main";

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
  if (job.officelocations_without_area && Array.isArray(job.officelocations_without_area)) {
    const cleanLocation = job.officelocations_without_area[0].replace(/[\r\n]+/g, ', ');
    return cleanLocation || "India";
  }
  return job.locations || job.country || "India";
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

  for (let page = 1; page <= MAX_PAGES_TO_FETCH; page++) {
    log(`   Fetching page ${page} from Delhivery (Darwinbox API)...`);

    // The exact payload from your screenshot, but dynamic
    const payload = {
      companyId: "main",
      page: page,
      sort_option: "new",
      limit: JOBS_PER_PAGE
    };

    const response = await fetch(URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching Delhivery API`);
    }

    const json = await response.json();
    const jobs = json.data || [];
    
    log(`   Page ${page} returned ${jobs.length} jobs`);
    
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
    if (jobs.length < (json.limit || JOBS_PER_PAGE)) {
      break;
    }

    await delay(500); // Polite delay between pages
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software, ${skipCounts.notIndia} not India`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTime = Date.now();
  log(`Starting Delhivery scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeDelhivery();
    log(`✅ Delhivery done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Delhivery failed: ${error.message}`);
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