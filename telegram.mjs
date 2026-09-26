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

  const jobsToAlert = jobs.filter((job) => !hiddenTitles.has(normalizeTitle(job.title)));
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
