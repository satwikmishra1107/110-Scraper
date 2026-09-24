// custom/servicenow.mjs | run: node custom/servicenow.mjs
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

// ---------- Settings ----------
const MAX_PAGES_TO_FETCH = 30;
const SERVICENOW_BASE_URL = "https://careers.servicenow.com/jobs/?search=&country=India&pagesize=50";

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
async function scrapeServiceNow() {
  log(`Launching Stealth Browser for ServiceNow...`);
  
  const browser = await puppeteer.launch({ 
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  
  const matchingJobs = [];
  const skipCounts = { duplicate: 0, notSoftware: 0 };
  let totalJobsChecked = 0;
  const seenJobs = new Set();
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    let currentPage = 1;

    while (currentPage <= MAX_PAGES_TO_FETCH) {
      log(`   Fetching ServiceNow jobs page ${currentPage}...`);
      
      const pageUrl = `${SERVICENOW_BASE_URL}&page=${currentPage}`;
      
      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 })
        .catch(e => log(`   ⚠️ goto warning: ${e.message}`));
      
      try {
        await page.waitForFunction(
          () => [...document.querySelectorAll("a")].some(a => /\/jobs?\/[^/?#]+/.test(a.href)),
          { timeout: 15000 }
        );
      } catch (error) {
        log(`   No jobs found on page ${currentPage} (or timed out). Ending pagination.`);
        break; 
      }
      
      await delay(2000); 

      const extractedJobs = await page.evaluate(() => {
        const jobData = [];
        
        const allLinks = Array.from(document.querySelectorAll('a'));
        const jobLinks = allLinks.filter(a =>
          /\/jobs?\/[^/?#]+/.test(a.href) && a.innerText.trim().length > 5
        );
        
        jobLinks.forEach(link => {
          const title = link.innerText.trim().split("\n")[0].trim();
          const card = link.closest('li') || link.closest('div') || link.parentElement.parentElement;
          
          if (card) {
            const lines = card.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const locationLine = lines.find(line => 
              line.includes("India") || line.includes("Hyderabad") || 
              line.includes("Bengaluru") || line.includes("Bangalore") ||
              line.includes("Remote")
            ) || "India";

            const dateLine = lines.find(l => /\bposted\b|\bago\b/i.test(l)) || "Recent";
            
            jobData.push({ title, location: locationLine, date: dateLine, url: link.href });
          }
        });
        
        return jobData;
      });

      let newJobsFoundOnPage = 0;

      for (const job of extractedJobs) {
        totalJobsChecked++;
        const jobIdentifier = `${job.title} - ${job.url}`;
        
        if (seenJobs.has(jobIdentifier)) {
          skipCounts.duplicate++;
          continue;
        }

        seenJobs.add(jobIdentifier);
        newJobsFoundOnPage++;

        if (!isSoftwareJob(job.title)) {
          skipCounts.notSoftware++;
          continue;
        }

        matchingJobs.push({
          company: "ServiceNow",
          title: job.title,
          department: "Engineering", 
          location: job.location,
          daysSincePosted: job.date, 
          url: job.url
        });
      }

      log(`   Page ${currentPage} returned ${newJobsFoundOnPage} new distinct jobs.`);

      if (newJobsFoundOnPage === 0) {
        log(`   Hit a page with only duplicate jobs. Stopping pagination.`);
        break;
      }

      currentPage++;
      await delay(1500); 
    }
  } finally {
    log(`   Closing browser...`);
    await browser.close();
  }

  log(`   Checked ${totalJobsChecked} raw job cards in total`);
  log(`   Skipped: ${skipCounts.duplicate} duplicate, ${skipCounts.notSoftware} not software`);
  log(`   Kept: ${matchingJobs.length}`);

  return matchingJobs;
}

// ---------- Main ----------
async function main() {
  const startTime = Date.now();
  log(`Starting ServiceNow scraper...`);
  console.log("");

  let allJobs = [];
  let scrapeFailed = false;

  try {
    allJobs = await scrapeServiceNow();
    log(`✅ ServiceNow done`);
  } catch (error) {
    scrapeFailed = true;
    log(`❌ ServiceNow failed: ${error.message}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${allJobs.length} jobs found`);
  console.log("=".repeat(60));

  allJobs.forEach((job, i) => {
    const postedText = typeof job.daysSincePosted === 'number' 
      ? (job.daysSincePosted <= 0 ? "Today" : `${job.daysSincePosted} days ago`) 
      : (job.daysSincePosted || "Recent");

    console.log(`${i + 1}. [${job.company}] ${job.title} (${job.department})`);
    console.log(`   Location: ${job.location} | Posted: ${postedText}`);
    console.log(`   Link: ${job.url}\n`);
  });

  log(`Finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
  if (scrapeFailed) log(`⚠️ Scraper failed to finish correctly.`);
}

await main();