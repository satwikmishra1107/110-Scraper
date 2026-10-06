// telegram.mjs — sends one Telegram message per new or updated job.
// Lives next to store.mjs. Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the environment.
import { loadHiddenTitles } from "./store.mjs";

const DELAY_BETWEEN_MESSAGES_MS = 1000; // Telegram allows about 1 message per second per chat

const SOURCE_LABELS = {
  workday: "Workday",
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
};

// A ping is stricter than the board: the title must pass all three word checks below.
// Whole words only: "lead" skips "Tech Lead" but not "Leading..."; "sr" also catches "Sr." and "Sr".

// 1. Kept off the board too. Keep in step with AUTO_HIDE_WORDS in job-board/src/lib/constants.js.
const AUTO_HIDE_WORDS = [
  "senior", "sr", "lead", "leadership", "staff", "principal", "director", "manager", "mgr", "head",
  "architect", "vp", "vice president", "distinguished", "fellow", "iv",
  "smts", "lmts", "pmts", // Salesforce's Senior / Lead / Principal Member of Technical Staff
  "intern", "internship", "campus hire",
  "ai", "ml", "ai/ml", "machine learning", "llm", "genai", "gen ai", "generative",
  "deep learning", "data scientist", "nlp", "computer vision",
  "salesforce", "servicenow", "sap", "cpq", "certinia", "consultant", "escalation",
  "professional services", "technology operations", "network security",
];
// 2. Shown on the board, but not worth a ping: testing, ops and low-level/embedded work
const NO_PING_WORDS = [
  "tester", "test", "testing", "qa", "sdet", "automation", "sre", "site reliability", "devops",
  "embedded", "firmware", "kernel", "driver", "drivers", "dsp", "modem", "wlan", "silicon",
];
// 3. A ping needs at least one of these
const PING_WORDS = [
  "software", "sde", "swe", "developer", "development engineer", "mts", "member of technical staff",
  "backend", "back-end", "back end", "frontend", "front-end", "front end", "full stack", "full-stack", "fullstack",
  "web", "java", "python", "node", "nodejs", "react", "angular", "golang", "typescript", "ios", "android",
];
const wordPattern = (words) => new RegExp(`\\b(${words.join("|")})\\b`, "i");
const AUTO_HIDE_PATTERN = wordPattern(AUTO_HIDE_WORDS);
const NO_PING_PATTERN = wordPattern(NO_PING_WORDS);
const PING_PATTERN = wordPattern(PING_WORDS);

// Same India check as workday.mjs. "3 Locations" or no location can't be checked, so they pass.
const INDIA_LOCATION_PATTERN =
  /\b(india|bengaluru|bangalore|hyderabad|mumbai|pune|gurgaon|gurugram|noida|delhi|chennai|kolkata|ahmedabad|nashik|hosur|bidadi|gangaikondan|bhiwadi|karnataka|telangana|telengana|maharashtra|tamil nadu|haryana|rajasthan|oberoi garden city)\b/i;
const MULTIPLE_LOCATIONS_PATTERN = /^\d+ Locations$/i;

// A company's first run saves every open job, some posted months ago. Only ping recent postings.
const MAX_PING_POSTING_AGE_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Returns why a job gets no ping, or null if it should get one
function getSkipReason(job) {
  // "Engineer, Staff_CE" → "Engineer, Staff CE": "_" counts as part of a word, which would hide "Staff"
  const title = (job.title || "").replace(/_/g, " ");
  if (AUTO_HIDE_PATTERN.test(title) || NO_PING_PATTERN.test(title) || !PING_PATTERN.test(title)) return "title";

  const location = (job.location || "").trim();
  if (location && !INDIA_LOCATION_PATTERN.test(location) && !MULTIPLE_LOCATIONS_PATTERN.test(location)) return "not India";

  const postedTime = Date.parse(job.posted_date);
  if (Number.isFinite(postedTime) && Date.now() - postedTime > MAX_PING_POSTING_AGE_DAYS * MILLISECONDS_PER_DAY) return "old posting";

  return null;
}

// Same rule as the dashboard: "  Talent  Acquisition " → "talent acquisition"
function normalizeTitle(title) {
  return (title || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Messages use Telegram's HTML mode, so <, > and & in job text must be escaped
function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// One job → one message, filled into a fixed template
function formatJobMessage(job, source) {
  const sourceLabel = SOURCE_LABELS[source] ?? source;
  const openingLine = job.is_update
    ? `Hey Satwik 👋\nA ${sourceLabel} job you've seen before was just reposted (🔄 updated).`
    : `Hey Satwik 👋\nA new ${sourceLabel} job has been posted (🆕 new).`;
  const locationLine = job.location ? `\n<b>Location:</b> ${escapeHtml(job.location)}` : "";

  return (
    `${openingLine}\n\n` +
    `<b>Company:</b> ${escapeHtml(job.company)}\n` +
    `<b>Title:</b> ${escapeHtml(job.title)}` +
    `${locationLine}\n` +
    `<b>Apply:</b> ${escapeHtml(job.url)}\n\n` +
    `Do check it out if it matches what you're looking for.`
  );
}

async function sendMessage(botToken, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true, // no big link previews under every message
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} — ${await response.text()}`);
}

// Never throws: a failed alert is logged, and the scraper run carries on.
export async function sendTelegramAlerts(source, jobs) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.log("Telegram: token or chat ID missing — skipping alerts.");
    return;
  }

  // If the hidden list can't load, alert anyway: an extra ping beats a missed job
  let hiddenTitles = new Set();
  try {
    hiddenTitles = await loadHiddenTitles();
  } catch (error) {
    console.error(`Telegram: ${error.message} — sending without the hidden-title filter.`);
  }

  const jobsToAlert = [];
  const skipCounts = {};
  for (const job of jobs) {
    const skipReason = hiddenTitles.has(normalizeTitle(job.title)) ? "hidden title" : getSkipReason(job);
    if (skipReason) skipCounts[skipReason] = (skipCounts[skipReason] ?? 0) + 1;
    else jobsToAlert.push(job);
  }
  const skippedCount = jobs.length - jobsToAlert.length;
  if (skippedCount > 0) console.log(`Telegram: skipped ${skippedCount} job(s) — ${JSON.stringify(skipCounts)}`);
  if (jobsToAlert.length === 0) return;

  let failedCount = 0;
  for (const [jobIndex, job] of jobsToAlert.entries()) {
    try {
      await sendMessage(botToken, chatId, formatJobMessage(job, source));
    } catch (error) {
      failedCount += 1; // one bad message shouldn't stop the others
      console.error(`Telegram send failed (${job.company} – ${job.title}): ${error.message}`);
    }
    if (jobIndex < jobsToAlert.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_MESSAGES_MS));
    }
  }
  console.log(`Telegram: sent ${jobsToAlert.length - failedCount} of ${jobsToAlert.length} job alerts.`);
}
