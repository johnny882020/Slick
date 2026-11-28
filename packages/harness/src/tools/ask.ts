// ask_user: the model asks the person one question mid-run and waits for the answer.
// Offered only when the run has someone to ask (RunOptions.onQuestion); pinned apps and
// schedules run unattended, so the model never sees this tool there.

import type { QuestionHandler } from "@oneseat/contracts";
import { AbortError, errorMessage, newId, raceAbort, type Redactor } from "../util.js";
import type { RegisteredTool } from "./registry.js";

export const ASK_USER_TOOL = "ask_user";
export const MAX_QUESTION_OPTIONS = 6;
const MAX_QUESTION_CHARS = 1000;
const MAX_OPTION_CHARS = 120;

export const SKIPPED_ANSWER = "The person skipped this question.";

export const ASK_USER_DESCRIPTION = [
  "Ask the person one question and wait for their answer.",
  "Use it only when you truly cannot go on: required information is missing (and not in the database, memory or workspace),",
  "or there is a real choice only they can make. Do not ask to confirm something you can reasonably assume, and do not ask for approval:",
  "actions that send, pay or delete already ask the person themselves.",
  "Ask one short, plain question at a time. When there are natural choices, give them as options (2 to 6 short labels);",
  "the person can still type their own answer. The result is their answer, or a note that they skipped it.",
].join(" ");

function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const o of raw) {
    if (typeof o !== "string") continue;
    const t = o.replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_QUESTION_OPTIONS);
}

/**
 * The ask_user tool for one run. Questions and answers are redacted like approval
 * summaries: a known key, or anything that looks like a credential, never shows in the
 * question card, the event log or the conversation.
 */
export function createAskUserTool(onQuestion: QuestionHandler, redactor: Redactor): RegisteredTool {
  return {
    definition: {
      name: ASK_USER_TOOL,
      description: ASK_USER_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS, description: "One short, plain question for the person." },
          options: {
            type: "array",
            maxItems: MAX_QUESTION_OPTIONS,
            description: "Optional short answer choices (2 to 6) when there are natural ones.",
            // Blank or repeated options are dropped rather than refused.
            items: { type: "string", maxLength: MAX_OPTION_CHARS },
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      effects: [],
      source: "builtin",
    },
    summarize: (input) => `Ask the person: ${redactor.redact(String(input["question"]).replace(/\s+/g, " ").trim()).slice(0, 160)}`,
    async run(input, ctx) {
      const question = redactor.redact(String(input["question"]).trim());
      if (!question) return { content: "The question is empty. Ask something specific.", isError: true };
      const options = cleanOptions(input["options"]).map((o) => redactor.redact(o));
      const questionId = newId("q");
      const req = { questionId, question, ...(options.length > 0 ? { options } : {}) };
      // Register the waiter before anyone can see the question, so an instant answer is never lost.
      const pending = onQuestion(req);
      ctx.emit({ type: "question", ...req });
      let answer = "";
      try {
        const raw = await raceAbort(pending, ctx.signal);
        answer = typeof raw === "string" ? redactor.redact(raw.trim()) : "";
      } catch (e) {
        // Cancelled: nobody answered. The run's done event closes the question.
        if (e instanceof AbortError || ctx.signal.aborted) return { content: "The run was cancelled before the person answered.", isError: true };
        // The run goes on, so close the question as unanswered.
        ctx.emit({ type: "question_answered", questionId, answer: "" });
        return { content: `Could not ask the person: ${errorMessage(e)}`, isError: true };
      }
      ctx.emit({ type: "question_answered", questionId, answer });
      return { content: answer || SKIPPED_ANSWER };
    },
  };
}
