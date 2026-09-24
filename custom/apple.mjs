// custom/apple.mjs | run: node custom/apple.mjs

// ---------- Settings you can change ----------
const MAX_POSTING_AGE_DAYS = 7;
const MAX_PAGES_TO_FETCH = 20;    // safety limit so the loop can never run forever
const REQUEST_TIMEOUT_MS = 15000;
const URL = "https://jobs.apple.com/api/v1/search";

// Matches whole words only. Includes Apple-specific keywords like infrastructure & machine learning
const SOFTWARE_TITLE_PATTERN =
  /\b(software|engineers?|engineering|technical|developers?|developer|sde|sdet|backend|back-end|frontend|front-end|full[- ]?stack|systems?|architect|ui|ux|react|node|java|c\+\+|typescript|mongo)\b/i;
const MILLISECONDS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

// ---------- Small helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title, team) {
  return SOFTWARE_TITLE_PATTERN.test(title || "") || SOFTWARE_TITLE_PATTERN.test(team || "");
}

function getDaysSincePosted(dateString, currentTimeInMilliseconds) {
  const postedDate = new Date(dateString);

  // If the date cannot be read, treat the job as brand new instead of dropping it
  if (isNaN(postedDate.getTime())) return 0;

  return Math.floor((currentTimeInMilliseconds - postedDate.getTime()) / MILLISECONDS_IN_ONE_DAY);
}

// ---------- Scrape Apple (all pages) ----------
async function scrapeApple() {
  const currentTimeInMilliseconds = Date.now();
  const matchingJobs = [];

  const skipCounts = { tooOld: 0, notSoftware: 0 };
  let totalJobsChecked = 0;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES_TO_FETCH; pageNumber++) {
    log(`   Fetching page ${pageNumber}...`);

    const payload = {
      query: "",
      filters: {
        locations: ["postLocation-INDC"] // Apple's internal ID for "India"
      },
      page: pageNumber,
      locale: "en-in",
      sort: "newest", // Force sorting by newest
      format: {
        longDate: "MMMM D, YYYY",
        mediumDate: "MMM D, YYYY"
      }
    };

    const response = await fetch(URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://jobs.apple.com",
        "Referer": "https://jobs.apple.com/en-in/search?location=india-INDC",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching page ${pageNumber}`);
    }

    const data = await response.json();
    const searchResults = data.res?.searchResults || [];

    log(`   Page ${pageNumber} returned ${searchResults.length} jobs`);

    // If the array is empty, we've hit the end of the pages
    if (searchResults.length === 0) break;

    let foundJobOlderThanLimit = false;

    for (const job of searchResults) {
      totalJobsChecked++;

      const daysSincePosted = getDaysSincePosted(job.postDateInGMT, currentTimeInMilliseconds);

      // Jobs are sorted newest first. Once we see an old one, mark it so we can break early
      if (daysSincePosted > MAX_POSTING_AGE_DAYS) {
        skipCounts.tooOld++;
        foundJobOlderThanLimit = true;
        continue;
      }

      const teamName = job.team?.teamName || "";
      
      if (!isSoftwareJob(job.postingTitle, teamName)) {
        skipCounts.notSoftware++;
        continue;
      }

      const locationName = job.locations?.[0]?.name || "India";

      matchingJobs.push({
        id: job.positionId,
        company: "Apple",
        title: job.postingTitle,
        department: teamName,
        location: locationName,
        daysSincePosted: daysSincePosted,
        url: `https://jobs.apple.com/en-in/details/${job.positionId}/${job.transformedPostingTitle}`
      });
    }

    if (foundJobOlderThanLimit) {
      log(`   Reached jobs older than ${MAX_POSTING_AGE_DAYS} days, stopping.`);
      break;
    }

    // Small delay to prevent rate limits, only if we intend to pull the next page
    if (pageNumber < MAX_PAGES_TO_FETCH) {
      await delay(1000); 
    }
  }

  log(`   Checked ${totalJobsChecked} jobs in total`);
  log(`   Skipped: ${skipCounts.tooOld} too old, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTimeInMilliseconds = Date.now();

  log(`Starting Apple scraper`);
  log(`Looking for India software jobs posted in the last ${MAX_POSTING_AGE_DAYS} days`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  log(`▶ Apple (jobs.apple.com)`);

  try {
    const jobsFromThisCompany = await scrapeApple();
    allJobs.push(...jobsFromThisCompany);
    log(`✅ Apple done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ Apple failed: ${error.message}`);
  }

  console.log("");
  console.log("=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`;

    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}`);
    console.log("");
  });

  const secondsTaken = ((Date.now() - startTimeInMilliseconds) / 1000).toFixed(1);
  log(`Finished in ${secondsTaken} seconds`);

  if (scrapeFailed) {
    log(`⚠️ Apple scraper failed to finish correctly.`);
  }
}

await main();