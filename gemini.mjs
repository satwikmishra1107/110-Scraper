// gemini.mjs — one Gemini call with retries, shared by workday.mjs (facet picking) and score/score-jobs.mjs (resume matching).
// Lives next to store.mjs.

const MAX_GEMINI_RETRY_WAIT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function getGeminiRetryDelayMs(geminiError) {
  const retryInfo = geminiError.details?.find((d) => d["@type"]?.endsWith("RetryInfo"));
  const fromDetails = retryInfo?.retryDelay?.match(/^([\d.]+)s$/);
  if (fromDetails) return Math.ceil(Number(fromDetails[1]) * 1000);

  const fromMessage = geminiError.message?.match(/retry in ([\d.]+)s/i);
  if (fromMessage) return Math.ceil(Number(fromMessage[1]) * 1000);

  return null;
}

// A 429 is either "too many per minute" (worth waiting for) or "used up today's free requests" (not worth retrying).
function isDailyQuotaError(geminiError) {
  const quotaFailure = geminiError.details?.find((d) => d["@type"]?.endsWith("QuotaFailure"));
  return Boolean(quotaFailure?.violations?.some((violation) => /PerDay/i.test(violation.quotaId ?? "")));
}

/**
 * Sends one prompt and returns Gemini's raw response JSON. Retries 429 / 5xx / network errors.
 * A thrown error carries .status (HTTP status, if any) and .isDailyQuota (today's free requests are used up).
 */
export async function callGemini({ apiKey, model, prompt, generationConfig = {}, maxAttempts = 4 }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", ...generationConfig },
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      if (response.ok) return response.json();

      const body = await response.text();
      let reason = body.slice(0, 300);
      let serverRetryDelayMs = null;
      let isDailyQuota = false;
      try {
        const parsed = JSON.parse(body).error ?? {};
        reason = parsed.message ?? reason;
        serverRetryDelayMs = getGeminiRetryDelayMs(parsed);
        isDailyQuota = response.status === 429 && isDailyQuotaError(parsed);
      } catch {}
      lastError = new Error(`Gemini API Error ${response.status}: ${reason}`);
      lastError.status = response.status;
      lastError.retryDelayMs = serverRetryDelayMs;
      lastError.isDailyQuota = isDailyQuota;

      const retryable = (response.status === 429 && !isDailyQuota) || response.status >= 500;
      if (!retryable) throw lastError;
    } catch (error) {
      if (error === lastError) throw error;
      lastError = new Error(`Gemini request failed: ${error.name === "TimeoutError" ? "timed out after 60s" : error.message}`);
    }

    if (attempt < maxAttempts) {
      const waitMs = lastError.retryDelayMs
        ? Math.min(lastError.retryDelayMs + 1000, MAX_GEMINI_RETRY_WAIT_MS)
        : 5000 * attempt;
      console.log(`  └─ ${lastError.message} — retrying in ${waitMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
      await delay(waitMs);
    }
  }
  const finalError = new Error(`${lastError.message} (gave up after ${maxAttempts} attempts)`);
  finalError.status = lastError.status;
  throw finalError;
}

/** Gemini's answer as a parsed JSON object. Throws if it isn't valid JSON. */
export function parseGeminiJson(responseData) {
  const generatedText =
    responseData.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .join("") ?? "";
  try {
    return JSON.parse(generatedText.replace(/```json|```/g, "").trim());
  } catch {
    throw new Error(
      `Gemini returned invalid JSON (finishReason: ${responseData.candidates?.[0]?.finishReason ?? "unknown"}): ` +
        `${generatedText.slice(0, 200) || "<empty response>"}`,
    );
  }
}
