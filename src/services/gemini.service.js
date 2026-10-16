import { env } from "../config/env.js";
import { AppError, unavailable } from "../utils/errors.js";

// Thin client for the Gemini API (generateContent). Retries brief overloads, falls back to the next
// configured model, and turns Google's errors into messages an admin can act on. The API key is
// only ever sent from this server to Google.

const cfg = env.gemini;
const RETRYABLE = new Set([500, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isConfigured = () => Boolean(cfg.apiKey);

function requireKey() {
  if (!cfg.apiKey) throw unavailable("AI isn't configured. Set GEMINI_API_KEY in the backend's environment.");
}

/** Seconds Google asks us to wait (RetryInfo), if any. */
function retryDelaySeconds(error) {
  const info = error?.details?.find((d) => String(d["@type"]).endsWith("RetryInfo"));
  const s = Number.parseFloat(String(info?.retryDelay ?? ""));
  return Number.isFinite(s) ? Math.ceil(s) : undefined;
}

function toAppError(status, error, model) {
  const message = String(error?.message ?? "");
  if (status === 429) {
    // A quota of 0 on a free-tier key means the model needs billing: not a rate limit.
    if (/free_tier/i.test(message) && /limit:\s*0/.test(message)) {
      return new AppError(402, "AI_BILLING_REQUIRED", `${model} isn't included in the free tier of this Gemini API key. Enable billing on the key's Google AI / Cloud project, then try again.`, { model });
    }
    const wait = retryDelaySeconds(error);
    return new AppError(429, "AI_RATE_LIMITED", `The AI quota or rate limit was reached. Please try again${wait ? ` in about ${wait} seconds` : " in a minute"}.`, { model, retryAfterSeconds: wait });
  }
  if (status === 404) return new AppError(502, "AI_MODEL_UNAVAILABLE", `The AI model "${model}" isn't available to this API key. Update the GEMINI_* model settings on the backend.`, { model });
  if (status === 400 && /api key/i.test(message)) return new AppError(502, "AI_KEY_INVALID", "Google rejected the Gemini API key. Check GEMINI_API_KEY on the backend.");
  if (status === 401 || status === 403) return new AppError(502, "AI_KEY_INVALID", "The Gemini API key isn't allowed to use this model. Check the key and its project's API access.", { model });
  if (RETRYABLE.has(status)) return new AppError(503, "AI_UNAVAILABLE", "The AI service is busy right now. Please try again in a moment.", { model });
  return new AppError(502, "AI_ERROR", `The AI request failed${message ? `: ${message.slice(0, 200)}` : "."}`, { model });
}

async function postOnce(model, body, timeoutMs) {
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new AppError(504, "AI_TIMEOUT", "The AI took too long to respond. Please try again.", { model });
    throw new AppError(502, "AI_UNREACHABLE", "Couldn't reach the Gemini API. Check the server's internet connection.", { model });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(toAppError(res.status, data?.error, model), { upstreamStatus: res.status });
  return data;
}

/**
 * generateContent against each model in turn. Overloads (5xx) are retried twice per model before
 * moving on; rate limits, billing and key problems stop immediately (another model won't help).
 */
export async function generateContent(models, body, { timeoutMs = cfg.timeoutMs, log } = {}) {
  requireKey();
  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await postOnce(model, body, timeoutMs);
        return { model, data };
      } catch (err) {
        lastError = err;
        const retryable = RETRYABLE.has(err.upstreamStatus) || err.code === "AI_TIMEOUT" || err.code === "AI_UNREACHABLE";
        log?.warn({ model, attempt, code: err.code }, "Gemini request failed");
        if (!retryable) {
          if (err.code === "AI_MODEL_UNAVAILABLE") break; // try the next configured model
          throw err;
        }
        if (err.code === "AI_TIMEOUT") break; // a slow model won't be faster on retry
        if (attempt < 2) await sleep(1000 * 3 ** attempt);
      }
    }
  }
  throw lastError;
}

/** Why a response carries no usable output (safety block, refusal…), or null. */
export function blockedReason(data) {
  const block = data?.promptFeedback?.blockReason;
  if (block) return block;
  const finish = data?.candidates?.[0]?.finishReason;
  return finish && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(finish) ? finish : null;
}

export const parts = (data) => data?.candidates?.[0]?.content?.parts ?? [];

export const analysisModels = () => cfg.analysisModels;
