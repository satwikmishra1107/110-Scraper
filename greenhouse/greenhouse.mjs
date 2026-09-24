// greenhouse-scraper.mjs | run: node greenhouse-scraper.mjs
import fs from "node:fs"; 

// --- Configuration ---
const COMPANIES_FILE = "./greenhouse/greenhouse.json";

const MAX_POSTING_AGE_DAYS = 7;
const NOW = Date.now();

// Keywords to identify Indian locations
const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai"
];

// Keywords to identify Software/Tech domain jobs
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

function isIndiaLocation(locationName) {
  if (!locationName) return false;
  const locLower = locationName.toLowerCase();
  return INDIA_LOCATIONS.some(city => locLower.includes(city));
}

function isSoftwareDomain(title) {
  if (!title) return false;
  const titleLower = title.toLowerCase();
  return SD_KEYWORDS.some(kw => titleLower.includes(kw));
}

// Load companies
const COMPANIES = JSON.parse(fs.readFileSync(COMPANIES_FILE, "utf8"));

// --- Main Scraper Logic per Company ---
async function scrapeCompany(companyObj) {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${companyObj.slug}/jobs`;
  
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} - Invalid slug or private board`);
  }

  const data = await response.json();
  const allJobs = data.jobs || [];
  const recentIndiaTechJobs = [];

  for (const job of allJobs) {
    // 1. Filter by Location
    if (!isIndiaLocation(job.location?.name)) continue;

    // 2. Filter by Domain (Title)
    if (!isSoftwareDomain(job.title)) continue;

    // 3. Filter by Date
    const updatedDate = new Date(job.updated_at);
    const daysAgo = Math.floor((NOW - updatedDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysAgo <= MAX_POSTING_AGE_DAYS) {
      recentIndiaTechJobs.push({
        company: companyObj.company,
        title: job.title,
        location: job.location.name,
        daysAgo: daysAgo === 0 ? "Today" : `${daysAgo} days ago`,
        url: job.absolute_url
      });
    }
  }

  return recentIndiaTechJobs;
}

// --- Main Execution & Reporting ---
async function runAll() {
  console.log(`\nLoaded ${COMPANIES.length} companies from ${COMPANIES_FILE}.`);
  console.log(`Starting Greenhouse Scraper...\n`);
  
  const statusReport = [];
  const allRecentJobs = [];

  for (const company of COMPANIES) {
    console.log(`Processing: ${company.company}`);
    
    try {
      const jobs = await scrapeCompany(company);
      allRecentJobs.push(...jobs);
      
      statusReport.push({ 
        Company: company.company, 
        Status: "✅ Success", 
        "India SD Jobs": jobs.length,
        Details: "OK"
      });
      
      console.log(`  └─ Success: Found ${jobs.length} recent India SD jobs.\n`);

    } catch (error) {
      statusReport.push({ 
        Company: company.company, 
        Status: "❌ Failed", 
        "India SD Jobs": 0,
        Details: error.message.substring(0, 40)
      });
      console.log(`  └─ Failed: ${error.message}\n`);
    }

    // Wait 500ms between companies to respect Greenhouse's servers and avoid IP bans
    await delay(500); 
  }

  // 1. Display the Execution Table
  console.log("=== FINAL GREENHOUSE REPORT ===");
  console.table(statusReport);
  console.log(`\nTotal valid jobs collected across all companies: ${allRecentJobs.length}\n`);

  // 2. Display the Extracted Jobs Neatly
  if (allRecentJobs.length > 0) {
    console.log("=== RECENT INDIA TECH JOBS ===");
    allRecentJobs.forEach((job, index) => {
      console.log(`${index + 1}. [${job.company}] ${job.title}`);
      console.log(`   Location: ${job.location} | Updated: ${job.daysAgo}`);
      console.log(`   Link: ${job.url}\n`);
    });
  } else {
    console.log("No recent jobs found matching the criteria.");
  }
}

runAll();