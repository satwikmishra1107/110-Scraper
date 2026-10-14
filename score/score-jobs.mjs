// score/score-jobs.mjs | run from repo root: node score/score-jobs.mjs
// Runs after every scraper in the hourly workflow. Scores Board jobs against each person's resume,
// with that person's own Gemini key (both saved from the dashboard's "Resume match" panel).
//
//   1. Board jobs: found or reposted in the last 7 days, from the platforms and custom sites descriptions.mjs can read,
//      minus auto-hidden titles, "always hide" titles and archived jobs — same rules as the dashboard
//   2. Fetch the description of every one that doesn't have one yet → jobs.description
//   3. For each person with a resume and a key: score the jobs they have no score for yet, newest first → job_scores
import { pathToFileURL } from "node:url";
import { delay } from "../ats-common.mjs";
import { callGemini, parseGeminiJson } from "../gemini.mjs";
import { loadHiddenTitles, supabase } from "../store.mjs";
import { isAutoHiddenTitle, normalizeTitle } from "../telegram.mjs";
import { SOURCES_WITH_DESCRIPTIONS, canFetchDescription, fetchDescription } from "./descriptions.mjs";

const GEMINI_MODEL = "gemini-3.5-flash-lite"; // same model as workday.mjs
const BOARD_DAYS = 7;
const ROWS_PER_PAGE = 1000; // Supabase returns at most 1000 rows per request
const DESCRIPTION_RETRY_AFTER_MS = 6 * 60 * 60 * 1000; // a failed description fetch is tried again after 6 hours
const DESCRIPTION_FETCHES_AT_ONCE = 4;
// The first run has a week of jobs to catch up on; 40 an hour spreads that over a few runs and keeps each run short
const MAX_SCORES_PER_PERSON_PER_RUN = 40;
const DELAY_BETWEEN_SCORES_MS = 4000; // the free tier allows ~15 requests a minute
const MAX_DESCRIPTION_CHARS_IN_PROMPT = 12_000;
const MAX_SKILLS = 10;

const makeJobKey = (company, jobId) => `${company}::${jobId}`;
const getBoardTime = (job) => Date.parse(job.reposted_at ?? job.first_seen_at);

/** Every row a query returns, 1000 at a time. buildQuery must order by unique columns so paging never skips a row. */
async function fetchAllRows(buildQuery, label) {
  const allRows = [];
  for (let pageStart = 0; ; pageStart += ROWS_PER_PAGE) {
    const { data: pageOfRows, error } = await buildQuery().range(pageStart, pageStart + ROWS_PER_PAGE - 1);
    if (error) throw new Error(`Supabase ${label} load failed: ${error.message}`);
    allRows.push(...pageOfRows);
    if (pageOfRows.length < ROWS_PER_PAGE) return allRows;
  }
}

// ---- 1. Board jobs ----

async function loadBoardJobs() {
  const since = new Date(Date.now() - BOARD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [jobs, archivedRows, hiddenTitles] = await Promise.all([
    fetchAllRows(
      () =>
        supabase
          .from("jobs")
          .select("source, company, job_id, title, location, url, first_seen_at, reposted_at, description, description_checked_at")
          .in("source", SOURCES_WITH_DESCRIPTIONS)
          .or(`first_seen_at.gte."${since}",reposted_at.gte."${since}"`)
          .order("company")
          .order("job_id"),
      "jobs",
    ),
    fetchAllRows(
      () => supabase.from("job_tracking").select("company, job_id").eq("archived", true).order("company").order("job_id"),
      "archived jobs",
    ),
    loadHiddenTitles(),
  ]);

  const archivedKeys = new Set(archivedRows.map((row) => makeJobKey(row.company, row.job_id)));
  return jobs
    .filter(
      (job) =>
        canFetchDescription(job) &&
        !isAutoHiddenTitle(job.title) &&
        !hiddenTitles.has(normalizeTitle(job.title)) &&
        !archivedKeys.has(makeJobKey(job.company, job.job_id)),
    )
    .sort((firstJob, secondJob) => getBoardTime(secondJob) - getBoardTime(firstJob)); // newest first
}

// ---- 2. Descriptions ----

async function fillMissingDescriptions(jobs) {
  const jobsToFetch = jobs.filter(
    (job) =>
      !job.description &&
      (!job.description_checked_at || Date.now() - Date.parse(job.description_checked_at) > DESCRIPTION_RETRY_AFTER_MS),
  );
  console.log(`Descriptions: fetching ${jobsToFetch.length} (of ${jobs.length} Board jobs)`);

  let failedCount = 0;
  let nextIndex = 0;
  // A few at a time: each worker takes the next job until none are left
  const fetchUntilDone = async () => {
    while (nextIndex < jobsToFetch.length) {
      const job = jobsToFetch[nextIndex++];
      let description = null;
      try {
        description = await fetchDescription(job);
      } catch (error) {
        failedCount += 1;
        console.log(`  └─ ${job.source} · ${job.company} – ${job.title}: ${error.message}`);
      }
      const { error } = await supabase
        .from("jobs")
        .update({ description, description_checked_at: new Date().toISOString() })
        .eq("company", job.company)
        .eq("job_id", job.job_id);
      if (error) console.error(`Supabase description save failed (${job.company} – ${job.title}): ${error.message}`);
      else job.description = description;
    }
  };
  await Promise.all(Array.from({ length: DESCRIPTION_FETCHES_AT_ONCE }, fetchUntilDone));
  if (jobsToFetch.length) console.log(`Descriptions: saved ${jobsToFetch.length - failedCount}, failed ${failedCount}`);
}

// ---- 3. Scoring ----

/** Everyone who has both a key and a resume: [{ person, apiKey, resume: { version, resume_text } }] */
async function loadPeopleToScoreFor() {
  const [settingsResult, resumesResult] = await Promise.all([
    supabase.from("resume_settings").select("person, gemini_api_key").not("gemini_api_key", "is", null),
    supabase.from("resumes").select("person, version, resume_text").order("version", { ascending: false }),
  ]);
  if (settingsResult.error) throw new Error(`Supabase resume_settings load failed: ${settingsResult.error.message}`);
  if (resumesResult.error) throw new Error(`Supabase resumes load failed: ${resumesResult.error.message}`);

  const latestResumeByPerson = new Map();
  for (const resume of resumesResult.data) {
    if (!latestResumeByPerson.has(resume.person)) latestResumeByPerson.set(resume.person, resume); // newest version comes first
  }
  return settingsResult.data
    .filter((settings) => settings.gemini_api_key.trim() && latestResumeByPerson.has(settings.person))
    .map((settings) => ({
      person: settings.person,
      apiKey: settings.gemini_api_key.trim(),
      resume: latestResumeByPerson.get(settings.person),
    }));
}

async function loadScoredJobKeys(people) {
  const rows = await fetchAllRows(
    () =>
      supabase
        .from("job_scores")
        .select("company, job_id, person")
        .in("person", people.map(({ person }) => person))
        .order("company")
        .order("job_id")
        .order("person"),
    "job_scores",
  );
  return new Set(rows.map((row) => `${row.person}|${makeJobKey(row.company, row.job_id)}`));
}

// The model fills these in this order: the skills and reason first, so the score is based on them
const SCORE_SCHEMA = {
  type: "OBJECT",
  properties: {
    skills_matched: { type: "ARRAY", items: { type: "STRING" } },
    skills_missing: { type: "ARRAY", items: { type: "STRING" } },
    reason: { type: "STRING" },
    score: { type: "INTEGER" },
  },
  required: ["skills_matched", "skills_missing", "reason", "score"],
  propertyOrdering: ["skills_matched", "skills_missing", "reason", "score"],
};

function buildScoringPrompt(job, resumeText) {
  return (
    `You are screening one job for one candidate. Compare the candidate's resume with the job description and judge how well they fit.\n\n` +
    `How to score (0-100):\n` +
    `- Years of experience come first: if the job asks for clearly more years than the resume shows that is 2 years, the score must be below 50.\n` +
    `- Then the required skills, tech stack and kind of work (backend, frontend, mobile, embedded, data, testing…).\n` +
    `- Nice-to-have skills count only a little.\n` +
    `- 80 or more means the candidate meets the experience bar and has most of the required skills.\n\n` +
    `skills_matched: skills or technologies the job asks for that the resume shows (at most ${MAX_SKILLS}, short names like "Java", "Kubernetes").\n` +
    `skills_missing: skills or technologies the job asks for that the resume doesn't show (at most ${MAX_SKILLS}). Only list what the job actually asks for.\n` +
    `reason: one sentence under 25 words with the main reason for the score, e.g. "Asks for 5+ years of backend Java; resume shows 2 years, mostly React."\n` +
    `Use only what is written in the resume and the job description. Don't guess.\n\n` +
    `<resume>\n${resumeText}\n</resume>\n\n` +
    `<job>\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location ?? "not given"}\n\n` +
    `${job.description.slice(0, MAX_DESCRIPTION_CHARS_IN_PROMPT)}\n</job>`
  );
}

const cleanSkills = (skills) =>
  (Array.isArray(skills) ? skills : [])
    .filter((skill) => typeof skill === "string" && skill.trim())
    .map((skill) => skill.trim().slice(0, 60))
    .slice(0, MAX_SKILLS);

export async function scoreJob(job, { apiKey, resume }) {
  const responseData = await callGemini({
    apiKey,
    model: GEMINI_MODEL,
    prompt: buildScoringPrompt(job, resume.resume_text),
    generationConfig: { temperature: 0, responseSchema: SCORE_SCHEMA },
    maxAttempts: 3,
  });
  const result = parseGeminiJson(responseData);
  const score = Math.round(Number(result.score));
  if (!Number.isFinite(score)) throw new Error(`Gemini gave no score: ${JSON.stringify(result).slice(0, 200)}`);
  return {
    score: Math.min(100, Math.max(0, score)),
    reason: String(result.reason ?? "").trim().slice(0, 300) || null,
    skills_matched: cleanSkills(result.skills_matched),
    skills_missing: cleanSkills(result.skills_missing),
  };
}

// A rejected key won't work on the next job either; anything else may be a one-off
function isKeyProblem(error) {
  return error.status === 401 || error.status === 403 || (error.status === 400 && /api key/i.test(error.message));
}

/** What the dashboard's panel shows: when scoring last worked, or why the key failed. */
async function saveKeyStatus(person, keyError) {
  const changes = keyError ? { key_error: keyError.slice(0, 300) } : { key_error: null, last_scored_at: new Date().toISOString() };
  const { error } = await supabase.from("resume_settings").update(changes).eq("person", person);
  if (error) console.error(`Supabase key status save failed (${person}): ${error.message}`);
}

async function scoreJobsForPerson(personToScoreFor, jobsToScore) {
  const { person, resume } = personToScoreFor;
  console.log(`Scoring for ${person} (resume v${resume.version}): ${jobsToScore.length} job(s) this run`);
  let scoredCount = 0;

  for (const [jobIndex, job] of jobsToScore.entries()) {
    if (jobIndex > 0) await delay(DELAY_BETWEEN_SCORES_MS);
    try {
      const result = await scoreJob(job, personToScoreFor);
      const { error } = await supabase.from("job_scores").upsert(
        {
          company: job.company,
          job_id: job.job_id,
          person,
          resume_version: resume.version,
          ...result,
          scored_at: new Date().toISOString(),
        },
        { onConflict: "company,job_id,person" },
      );
      if (error) throw new Error(`Supabase score save failed: ${error.message}`);
      scoredCount += 1;
    } catch (error) {
      if (isKeyProblem(error)) {
        console.log(`  └─ ${person}: key rejected — ${error.message}`);
        await saveKeyStatus(person, `Gemini rejected the API key: ${error.message}`);
        return;
      }
      if (error.isDailyQuota) {
        console.log(`  └─ ${person}: today's free Gemini requests are used up — the rest wait for tomorrow`);
        break;
      }
      // This job is tried again next run
      console.log(`  └─ ${person}: ${job.company} – ${job.title}: ${error.message}`);
    }
  }

  console.log(`  └─ ${person}: scored ${scoredCount} of ${jobsToScore.length}`);
  if (scoredCount > 0) await saveKeyStatus(person, null);
}

async function scoreForEveryone(boardJobs) {
  const people = await loadPeopleToScoreFor();
  if (people.length === 0) {
    console.log("Scoring: nobody has saved both a resume and a Gemini key yet.");
    return;
  }

  const scoredJobKeys = await loadScoredJobKeys(people);
  const jobsWithDescription = boardJobs.filter((job) => job.description);

  // Each person has their own key and quota, so everyone is scored at the same time
  await Promise.all(
    people.map((personToScoreFor) => {
      const jobsToScore = jobsWithDescription
        .filter((job) => !scoredJobKeys.has(`${personToScoreFor.person}|${makeJobKey(job.company, job.job_id)}`))
        .slice(0, MAX_SCORES_PER_PERSON_PER_RUN);
      return scoreJobsForPerson(personToScoreFor, jobsToScore);
    }),
  );
}

// Runs only when started directly (node score/score-jobs.mjs), not when imported
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const boardJobs = await loadBoardJobs();
    await fillMissingDescriptions(boardJobs);
    await scoreForEveryone(boardJobs);
  } catch (error) {
    console.error(`Scoring failed: ${error.message}`);
    process.exitCode = 1;
  }
}
