// smartrecruiters.mjs | run: node smartrecruiters.mjs
import fs from "node:fs";

const COMPANIES_FILE = "./smartrecruiters/smartrecruiters.json";
const MAX_POSTING_AGE_DAYS = 7;
const NOW = Date.now();

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
// --- Utility Functions ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const COMPANIES = JSON.parse(fs.readFileSync(COMPANIES_FILE, "utf8"));

function isSoftwareDomain(title, department) {
  const titleLower = (title || "").toLowerCase();
  const deptLower = (department || "").toLowerCase();
  
  if (SD_KEYWORDS.some(kw => titleLower.includes(kw))) return true;
  if (deptLower.includes("engineering") || deptLower.includes("infrastructure")) return true;
  return false;
}

// --- Main Scraper Logic ---
async function scrapeSmartRecruiters(companyObj) {
  let offset = 0;
  const limit = 100; // SmartRecruiters allows fetching 100 jobs at a time
  let totalFound = Infinity;
  const recentIndiaTechJobs = [];

  while (offset < totalFound) {
    const apiUrl = `https://api.smartrecruiters.com/v1/companies/${companyObj.slug}/postings?limit=${limit}&offset=${offset}`;
    
    const response = await fetch(apiUrl, { headers: { "Accept": "application/json" } });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} - Invalid slug or private board`);
    }

    const data = await response.json();
    totalFound = data.totalFound || 0; // The API tells us exactly how many jobs exist
    const jobs = data.content || [];

    if (jobs.length === 0) break;

    for (const job of jobs) {
      // 1. Filter by Location (SmartRecruiters provides structured location data!)
      const countryCode = (job.location?.country || "").toLowerCase();
      const city = (job.location?.city || "").toLowerCase();
      
      // 'in' is the country code for India
      const isIndia = countryCode === "in" || countryCode === "india" || city.includes("bengaluru") || city.includes("bangalore") || city.includes("mumbai") || city.includes("hyderabad");
      
      if (!isIndia) continue;

      // 2. Filter by Domain
      const department = job.department?.label || "N/A";
      if (!isSoftwareDomain(job.name, department)) continue;

      // 3. Filter by Date
      const postedDate = new Date(job.releasedDate);
      const daysAgo = Math.floor((NOW - postedDate.getTime()) / (1000 * 60 * 60 * 24));

      if (daysAgo <= MAX_POSTING_AGE_DAYS) {
        recentIndiaTechJobs.push({
          company: companyObj.company,
          title: job.name,
          department: department,
          location: job.location?.city || "India",
          daysAgo: daysAgo <= 0 ? "Today" : `${daysAgo} days ago`,
          // Standard SmartRecruiters URL format
          url: `https://jobs.smartrecruiters.com/${companyObj.slug}/${job.id}`
        });
      }
    }

    offset += limit;
    await delay(500); // Polite rate-limiting between pagination
  }

  return recentIndiaTechJobs;
}

// --- Main Execution & Reporting ---
async function runAll() {
  console.log(`\nLoaded ${COMPANIES.length} companies from ${COMPANIES_FILE}.`);
  console.log(`Starting SmartRecruiters Scraper...\n`);
  
  const statusReport = [];
  const allRecentJobs = [];

  for (const company of COMPANIES) {
    console.log(`Processing: ${company.company}`);
    
    try {
      const jobs = await scrapeSmartRecruiters(company);
      allRecentJobs.push(...jobs);
      
      statusReport.push({ 
        Company: company.company, 
        Status: "✅ Success", 
        "India SD Jobs": jobs.length
      });
      console.log(`  └─ Success: Found ${jobs.length} recent India SD jobs.\n`);

    } catch (error) {
      statusReport.push({ 
        Company: company.company, 
        Status: "❌ Failed", 
        "India SD Jobs": 0
      });
      console.log(`  └─ Failed: ${error.message}\n`);
    }

    await delay(1000); // Wait 1s between companies
  }

  // 1. Display the Execution Table
  console.log("=== FINAL SMARTRECRUITERS REPORT ===");
  console.table(statusReport);

  // 2. Display the Extracted Jobs Neatly
  if (allRecentJobs.length > 0) {
    console.log("\n=== RECENT INDIA TECH JOBS ===");
    allRecentJobs.forEach((job, index) => {
      console.log(`${index + 1}. [${job.company}] ${job.title} (${job.department})`);
      console.log(`   Location: ${job.location} | Posted: ${job.daysAgo}`);
      console.log(`   Link: ${job.url}\n`);
    });
  } else {
    console.log("\nNo recent tech jobs found matching the criteria.");
  }
}

runAll();