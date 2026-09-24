// custom/netflix.mjs | run: node custom/netflix.mjs

const MAX_POSTING_AGE_DAYS = 7;
const JOBS_PER_PAGE = 50;
const MAX_PAGES_TO_FETCH = 20; 
const REQUEST_TIMEOUT_MS = 15000;

const SOFTWARE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, department) {
  return SOFTWARE_PATTERN.test(title || "") || SOFTWARE_PATTERN.test(department || "");
}

function getDaysSincePosted(timestampSeconds, currentTimeInMilliseconds) {
  if (!timestampSeconds) return 0;
  const postedDate = new Date(timestampSeconds * 1000);
  if (isNaN(postedDate.getTime())) return 0;
  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

async function scrapeNetflix() {
  const currentTime = Date.now();
  const matchingJobs = [];
  const skipCounts = { tooOld: 0, notSoftware: 0 };
  
  let startOffset = 0;
  let totalJobsChecked = 0;
  let totalJobsInAPI = Infinity;

  for (let page = 0; page < MAX_PAGES_TO_FETCH && startOffset < totalJobsInAPI; page++) {
    log(`   Fetching page ${page + 1} (offset ${startOffset})...`);
    
    const apiUrl = `https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&location=India&start=${startOffset}&num=${JOBS_PER_PAGE}`;
    
    let response;
    let success = false;

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
      
      const daysSincePosted = getDaysSincePosted(job.t_update, currentTime);

      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        continue;
      }

      if (!isSoftwareJob(job.name, job.department)) {
        skipCounts.notSoftware++;
        continue;
      }

      const jobUrl = job.canonicalPositionUrl || `https://jobs.netflix.com/jobs/${job.ats_job_id || job.id}`;

      matchingJobs.push({
        company: "Netflix",
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
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

async function main() {
  const startTime = Date.now();
  log(`Starting Netflix scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeNetflix();
    log(`✅ Netflix done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Netflix failed: ${error.message}`);
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