// custom/lever.mjs | run: node custom/lever.mjs
import fs from "node:fs";

const COMPANIES_FILE = "./lever/lever.json";
const COMPANIES = JSON.parse(fs.readFileSync(COMPANIES_FILE, "utf8"));

const MAX_POSTING_AGE_DAYS = 7;
const NOW = Date.now();

const INDIA_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", 
  "mumbai", "pune", "gurgaon", "noida", "delhi", "chennai", "remote"
];

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
  
  if (INDIA_LOCATIONS.some(city => locLower.includes(city) && city !== "remote")) return true;
  if (locLower.includes("remote") && locLower.includes("india")) return true;
  return false;
}

function isSoftwareDomain(title) {
  if (!title) return false;
  const titleLower = title.toLowerCase();
  return SD_KEYWORDS.some(kw => titleLower.includes(kw));
}

// --- Main Scraper Logic per Company ---
async function scrapeLeverCompany(companyObj) {
  // The magic ?mode=json parameter transforms the HTML into clean JSON
  const apiUrl = `https://api.lever.co/v0/postings/${companyObj.slug}?mode=json`;
  
  const response = await fetch(apiUrl, {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} - Invalid slug or private board`);
  }

  const jobs = await response.json();
  const recentIndiaTechJobs = [];

  for (const job of jobs) {
    const location = job.categories?.location || "Unknown";
    
    // 1. Filter by Location
    if (!isIndiaLocation(location)) continue;

    // 2. Filter by Domain (Title)
    if (!isSoftwareDomain(job.text)) continue;

    // 3. Filter by Date (Lever provides createdAt in exact milliseconds)
    const daysAgo = Math.floor((NOW - job.createdAt) / (1000 * 60 * 60 * 24));

    if (daysAgo <= MAX_POSTING_AGE_DAYS) {
      recentIndiaTechJobs.push({
        company: companyObj.company,
        title: job.text,
        location: location,
        department: job.categories?.department || "N/A",
        daysAgo: daysAgo === 0 ? "Today" : `${daysAgo} days ago`,
        url: job.hostedUrl
      });
    }
  }

  return recentIndiaTechJobs;
}

// --- Main Execution & Reporting ---
async function runAll() {
  console.log(`\nStarting Lever Scraper for ${COMPANIES.length} companies...\n`);
  
  const statusReport = [];
  const allRecentJobs = [];

  for (const company of COMPANIES) {
    console.log(`Processing: ${company.company}`);
    
    try {
      const jobs = await scrapeLeverCompany(company);
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

    await delay(500); // Polite delay between companies
  }

  // 1. Display the Execution Table
  console.log("=== FINAL LEVER REPORT ===");
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