// custom/meta.mjs | run: node custom/meta.mjs
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
const MAX_PAGES_TO_FETCH = 30;
const META_BASE_URL = "https://www.metacareers.com/jobsearch/?offices[0]=Mumbai%2C%20India&offices[1]=Gurgaon%2C%20India&offices[2]=Bangalore%2C%20India&offices[3]=Hyderabad%2C%20India&offices[4]=New%20Delhi%2C%20India&sort_by_new=true";

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

// ---------- Helpers ----------
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  const timeText = new Date().toLocaleTimeString();
  console.log(`[${timeText}] ${message}`);
}

function isSoftwareJob(title) {
  return SD_REGEX.test(title || "");
}

// ---------- Scraper Logic ----------
async function scrapeMeta() {
  log(`Launching Stealth Browser for Meta...`);
  
  const browser = await puppeteer.launch({ 
    headless: "new", 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  
  const matchingJobs = [];
  let notSoftwareCount = 0;
  let totalJobsChecked = 0;
  let totalJobsOnSite = null;
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    for (let currentPage = 1; currentPage <= MAX_PAGES_TO_FETCH; currentPage++) {
      log(`   Fetching Meta jobs page ${currentPage}...`);
      
      const pageUrl = `${META_BASE_URL}&page=${currentPage}`;
      
      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 })
        .catch(e => log(`   ⚠️ goto warning: ${e.message}`));
      
      // Wait for the results header ("24 Items"). It renders on pages past the end too,
      // so a missing header means the page failed to load, not that the results ran out
      try {
        await page.waitForFunction(
          () => /\d+\s+Items?\b/.test(document.body.innerText),
          { timeout: 15000 },
        );
      } catch (error) {
        throw new Error(`Results never loaded on page ${currentPage}`);
      }
      
      await delay(2000); 

      const { matchedCount, extractedJobs } = await page.evaluate(() => {
        const jobData = [];
        const jobLinks = document.querySelectorAll('a[href*="/profile/job_details/"]');
        
        jobLinks.forEach(link => {
          const h3 = link.querySelector('h3');
          const title = h3 ? h3.innerText.trim() : link.innerText.split('\n')[0].trim();
          
          if (!title) return; 

          // The job id is part of the link: /profile/job_details/<id>
          const jobId = link.href.match(/\/profile\/job_details\/(\d+)/)?.[1];
          if (!jobId) return;
          
          const lines = link.innerText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
          const locationLine = lines.find(line => 
            line.includes("India") || line.includes("Bengaluru") || line.includes("Bangalore") || 
            line.includes("Gurgaon") || line.includes("New Delhi") ||
            line.includes("Hyderabad") || line.includes("Mumbai")
          ) || "India";
          
          jobData.push({ id: jobId, title, location: locationLine, url: link.href });
        });
        
        const matchedText = document.body.innerText.match(/(\d+)\s+Items?\b/);
        return { matchedCount: matchedText ? Number(matchedText[1]) : null, extractedJobs: jobData };
      });

      if (totalJobsOnSite === null) totalJobsOnSite = matchedCount;
      log(`   Page ${currentPage} returned ${extractedJobs.length} jobs.`);

      if (extractedJobs.length === 0) {
        log(`   Reached the end of the results.`);
        break;
      }

      for (const job of extractedJobs) {
        totalJobsChecked++;

        if (!isSoftwareJob(job.title)) {
          notSoftwareCount++;
          continue;
        }

        matchingJobs.push({
          id: job.id,
          company: "Meta",
          title: job.title,
          department: null, // not shown on the results page; null instead of a made-up value
          location: job.location,
          daysSincePosted: null, // not shown on the results page
          url: job.url
        });
      }

      if (totalJobsOnSite !== null && totalJobsChecked >= totalJobsOnSite) break;

      await delay(1500); 
    }
  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  log(`   Checked ${totalJobsChecked} job cards (site says ${totalJobsOnSite ?? "?"} matched)`);
  // Fewer cards than the header promised means some pages were missed; say so instead of passing quietly
  if (totalJobsOnSite !== null && totalJobsChecked < totalJobsOnSite) {
    log(`   ⚠️ Only ${totalJobsChecked} of ${totalJobsOnSite} jobs were read`);
  }
  log(`   Skipped: ${notSoftwareCount} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
export async function main() {
  const startTime = Date.now();
  log(`Starting Meta scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;
  let errorMessage = null;

  try {
    allJobs = await scrapeMeta();
    log(`✅ Meta done`);
  } catch (error) {
    scrapeFailed = true;
    errorMessage = error.message;
    log(`❌ Meta failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, jobIndex) => {
    const postedText = typeof job.daysSincePosted === 'number' 
      ? (job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`) 
      : (job.daysSincePosted || "Recent");

    console.log(`${jobIndex + 1}. [${job.company}] ${job.title} (${job.department || "N/A"})`);
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
