import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } },
);

const BATCH_SIZE = 500;

// Inserts jobs; rows that already exist (same company + job_id) are skipped by the DB.
// Returns ONLY the rows that were actually inserted = the genuinely new jobs.
export async function saveJobsAndGetNew(jobs) {
  // Drop duplicates inside this batch (same job seen on two pages)
  const unique = [...new Map(jobs.map((j) => [`${j.company}|${j.job_id}`, j])).values()];
  const rows = unique.map(({ scraped_at, ...row }) => row); // scraped_at isn't a column

  const newJobs = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert(rows.slice(i, i + BATCH_SIZE), {
        onConflict: "company,job_id",
        ignoreDuplicates: true, // ON CONFLICT DO NOTHING
      })
      .select();
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    newJobs.push(...data);
  }
  return newJobs;
}