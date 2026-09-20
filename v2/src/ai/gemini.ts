// The one place Atlas talks to a model.
//
// SHAPE OF THE DEAL
//
// One call per message the person types. Never per file, never in the pipeline,
// never on a timer - the whole reason V1 was expensive is that it classified
// every file with a model call, and V2 does that with a dictionary instead.
// This is the assistant: you ask it something, it answers once.
//
// It is also NOT a tool-execution loop. It returns a reply plus a list of
// PROPOSED actions as structured JSON, exactly as V1's chat service did, and
// for the same reason: the model never touches anything. The browser runs the
// ones that only change what is on screen, and anything that changes the plan
// waits for a human to click Apply.
//
// The key lives in the process environment and never reaches the browser.
import { config } from "../config.ts";
import { log } from "../log.ts";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_RETRIES = 2;

export class AiError extends Error {}

export const aiAvailable = () => Boolean(config.ai.key);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Google answers a 429 with how long to wait; honour it rather than guessing. */
function retryDelay(body: string, attempt: number): number {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.ceil(Number(m[1]) * 1000) : 4000 * attempt;
}

export async function ask(system: string, input: string, schema: unknown, attempt = 1): Promise<unknown> {
  if (!config.ai.key) throw new AiError("No GEMINI_API_KEY: the assistant is off until one is set.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  let res: Response;
  const t0 = performance.now();
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": config.ai.key, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.ai.model,
        system_instruction: system,
        input,
        response_format: { type: "text", mime_type: "application/json", schema },
        generation_config: { thinking_level: "low" },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    throw new AiError(err.name === "AbortError" ? `The assistant did not answer within ${config.ai.timeoutMs} ms.` : `Could not reach the model: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429 && attempt <= MAX_RETRIES) {
      const wait = retryDelay(body, attempt);
      log.warn("ai rate limited", { wait, attempt });
      await sleep(wait);
      return ask(system, input, schema, attempt + 1);
    }
    throw new AiError(res.status === 429
      ? "The free Gemini quota is used up for now. It resets on Google's schedule."
      : `The model returned ${res.status}: ${body.slice(0, 300)}`);
  }

  // The interactions API answers with a list of steps; the model's words are in
  // the last model_output step.
  const interaction = await res.json() as { steps?: { type: string; content?: { type: string; text?: string }[] }[] };
  const outputs = (interaction.steps ?? []).filter((st) => st.type === "model_output");
  const text = (outputs[outputs.length - 1]?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  log.info("ai answered", { ms: Math.round(performance.now() - t0), chars: text.length });
  if (!text) throw new AiError("The model returned nothing.");
  try {
    return JSON.parse(text);
  } catch {
    // The schema is enforced by the API, so this is rare - but a model that
    // returns prose instead of JSON must not take the request down with it.
    throw new AiError("The model's answer was not in the expected form.");
  }
}
