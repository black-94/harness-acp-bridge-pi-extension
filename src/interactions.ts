/**
 * Reverse-request handling: turn a server `question` into an `answer_question` payload.
 *
 * A permission request maps a selected offered option back to its `optionId`; an
 * information/elicitation request collects a typed object and validates it against the
 * requested JSON Schema. When no interactive UI is available, the router returns `undefined`
 * so the caller can surface `waiting_input` without inventing an answer. A user decision is
 * never inferred from free text or defaults.
 */
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { isRecord } from "./config.ts";

export type QuestionKind = "permission" | "information" | "elicitation";

export interface Question {
  request_id: string;
  kind: QuestionKind;
  title: string;
  message: string;
  options: Record<string, unknown>[];
  schema: Record<string, unknown> | null;
  raw?: Record<string, unknown>;
}

export type Decision =
  | { answer: "accept"; option_id: string }
  | { answer: "accept"; content: Record<string, unknown> }
  | { answer: "reject" | "timeout" | "cancel" };

interface Field {
  key: string;
  schema: Record<string, unknown>;
  required: boolean;
  choices?: unknown[];
  labels?: string[];
}
interface AskQuestion {
  id: string;
  title: string;
  prompt?: string;
  kind: "single" | "input";
  options?: { label: string; preview?: string }[];
  default?: string;
}

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
(addFormats as unknown as (validator: Ajv) => void)(ajv);

const shorten = (value: string, max: number): string => (value.length > max ? value.slice(0, max - 1) + "…" : value);

/**
 * `ask_user` enforces `prompt <= 500` and `preview <= 4000` characters and rejects a payload that
 * violates them. A server-provided message can be longer than 500 characters (e.g. a 700-character
 * authentication URL), so:
 *   - a single-choice field carries the FULL message as each option's `preview` (<=4000) and only
 *     a truncated `prompt`; the usable URL is never lost;
 *   - an input field has no option to carry the message, so it may only use `ask_user` when the
 *     entire prompt still fits in 500 characters; otherwise the router falls back to the native UI
 *     (no length limit) or, without UI, leaves the question pending as `waiting_input`.
 */
const ASK_PROMPT_LIMIT = 500;
const ASK_PREVIEW_LIMIT = 4000;

/** Tool input for display context, taken from the harness's original request frame. */
function rawInput(question: Question): Record<string, unknown> | null {
  const params = isRecord(question.raw) && isRecord(question.raw.params) ? question.raw.params : null;
  const toolCall = params && isRecord(params.toolCall) ? params.toolCall : null;
  return toolCall && isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
}
function defaults(question: Question): Record<string, unknown> | null {
  const params = isRecord(question.raw) && isRecord(question.raw.params) ? question.raw.params : null;
  return params && isRecord(params.defaults) ? params.defaults : null;
}

function fieldsFor(question: Question): { fields: Field[]; wholeObject: boolean } {
  const schema = question.schema ?? { type: "object" };
  const properties = schema.properties;
  const complex = ["oneOf", "anyOf", "allOf", "$ref", "if"].some(key => key in schema);
  if (complex || !isRecord(properties) || Object.keys(properties).length === 0) {
    return { fields: [{ key: "response", schema, required: true }], wholeObject: true };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    wholeObject: false,
    fields: Object.entries(properties).map(([key, value]) => {
      const fieldSchema = isRecord(value) ? value : {};
      const choices = Array.isArray(fieldSchema.enum) ? fieldSchema.enum
        : fieldSchema.type === "boolean" ? [true, false] : undefined;
      return {
        key, schema: fieldSchema, required: required.includes(key), choices,
        labels: choices?.map((choice, index) => shorten(`${index + 1}. ${JSON.stringify(choice)}`, 80)),
      };
    }),
  };
}

function parseField(value: string, field: Field): unknown {
  if (field.schema.type === "string" || (!field.schema.type && !field.choices)) return value;
  return JSON.parse(value);
}

function validate(question: Question, response: unknown): Record<string, unknown> {
  if (!isRecord(response)) throw new Error("ACP response must be a JSON object");
  if (question.schema) {
    const check = ajv.compile(question.schema);
    if (!check(response)) throw new Error(`Invalid ACP answer: ${ajv.errorsText(check.errors)}`);
  }
  return response;
}

function unpackResult(result: { details?: unknown; structuredContent?: unknown; content: unknown }): Record<string, unknown> {
  for (const data of [result.structuredContent, result.details]) {
    if (isRecord(data) && typeof data.status === "string") return data;
  }
  if (Array.isArray(result.content)) {
    const text = result.content.filter(isRecord).filter(c => c.type === "text").map(c => c.text).join("\n");
    try {
      const data: unknown = JSON.parse(text);
      if (isRecord(data) && typeof data.status === "string") return data;
    } catch { /* Human-readable output is not an answer. */ }
  }
  throw new Error("ask_user returned no structured answer; refusing to infer a decision from text");
}

/** Serialize dialogs across bridge sessions, without retaining a finished tool context. */
export class InteractionRouter {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly timeoutMs: number) {}

  resolve(question: Question, ctx: ExtensionContext, signal: AbortSignal, toolCtx?: ExtensionToolContext): Promise<Decision | undefined> {
    const result = this.tail.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      return this.prompt(question, ctx, signal, toolCtx);
    });
    this.tail = result;
    return result;
  }

  private async prompt(question: Question, ctx: ExtensionContext, signal: AbortSignal, toolCtx?: ExtensionToolContext): Promise<Decision | undefined> {
    const input = rawInput(question);
    const context = [question.message, input ? JSON.stringify(input, null, 2) : ""].filter(Boolean).join("\n");
    const plan = fieldsFor(question);
    const permission = question.kind === "permission";
    const permissionOptions = (question.options ?? []).filter(o => typeof o.optionId === "string");
    const labels = permissionOptions.map((o, i) => shorten(`${i + 1}. ${String(o.name ?? o.optionId)} [${String(o.kind ?? o.optionId)}]`, 80));
    const fields = plan.fields;
    // The complete message is representable as an option `preview` only while it fits the limit;
    // otherwise the whole message must stay in a (shorter) prompt, which is only possible for an
    // input field small enough to fit — never by truncating the only usable URL.
    const preview = context.length <= ASK_PREVIEW_LIMIT ? context : null;
    type FieldPlan = { field: Field; index: number; fullPrompt: string; usesPreview: boolean };
    const fieldPlans: FieldPlan[] = fields.map((field, index) => ({
      field, index, usesPreview: Boolean(field.choices),
      fullPrompt: [context, field.schema.description, `Type: ${String(field.schema.type ?? "string")}${field.required ? " (required)" : " (optional; empty to omit)"}`].filter(Boolean).join("\n"),
    }));
    const questions: AskQuestion[] = permission ? [{
      id: "permission", title: shorten(question.title || "ACP permission", 200), kind: "single",
      options: labels.map(label => ({ label, ...(preview !== null ? { preview } : {}) })),
    }] : fieldPlans.map(({ field, index, fullPrompt, usesPreview }) => ({
      id: `field_${index}`, title: shorten(String(field.schema.title ?? field.key), 200),
      // The prompt is capped at the `ask_user` limit; a choice field's full message lives in the
      // option `preview`, and an input field is only asked through `ask_user` when it fully fits.
      prompt: shorten(fullPrompt, ASK_PROMPT_LIMIT),
      kind: field.choices ? "single" : "input",
      options: field.choices ? field.labels?.map(label => ({ label, ...(preview !== null ? { preview } : {}) })) : undefined,
      ...(!field.required && !field.choices ? { default: "" } : {}),
    }));

    const ask = toolCtx?.tools?.find(tool => tool.name === "ask_user");
    const carrierOk = permission
      ? preview !== null
      : fieldPlans.every(plan => plan.usesPreview ? preview !== null : plan.fullPrompt.length <= ASK_PROMPT_LIMIT);
    const promptOk = questions.every(q => q.prompt === undefined || q.prompt.length <= ASK_PROMPT_LIMIT);
    const shapeOk = questions.length <= 5
      && questions.every(q => !q.options || (q.options.length > 0 && q.options.length <= 5));
    const fitsAsk = carrierOk && promptOk && shapeOk;
    if (ask && fitsAsk && typeof toolCtx?.executeTool === "function") {
      const outcome = await toolCtx.executeTool("ask_user", {
        header: shorten(question.title || "ACP request", 200), questions,
        timeoutPerQuestionMs: this.timeoutMs,
      }, { signal });
      signal.throwIfAborted();
      const data = unpackResult(outcome.result);
      if (data.status === "aborted") return { answer: "cancel" };
      if (data.status === "timeout") return { answer: "timeout" };
      if (data.status === "error" || outcome.isError) {
        const error = isRecord(data.error) ? data.error : {};
        if (!["unsupported_mode", "not_initialized"].includes(String(error.code))) {
          throw new Error(`ask_user failed: ${String(error.message ?? "tool execution failed")}`);
        }
        // UI was never entered; native UI is an explicit fallback, not a re-ask.
      } else if (data.status === "answered" && Array.isArray(data.answers)) {
        const answers = data.answers.filter(isRecord);
        const get = (index: number) => answers.find(a => a.id === questions[index].id) ?? answers[index];
        if (permission) {
          const selected = get(0)?.selections;
          const index = Array.isArray(selected) && selected.length === 1 ? labels.indexOf(String(selected[0])) : -1;
          if (index < 0) throw new Error("No offered permission option was explicitly selected");
          return { answer: "accept", option_id: String(permissionOptions[index].optionId) };
        }
        const response: Record<string, unknown> = {};
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i];
          const answer = get(i);
          if (!answer) throw new Error(`ask_user omitted ${field.key}`);
          const selections = Array.isArray(answer.selections) ? answer.selections : [];
          if (field.choices) {
            const index = selections.length === 1 ? field.labels!.indexOf(String(selections[0])) : -1;
            if (index < 0) throw new Error(`No valid option selected for ${field.key}`);
            response[field.key] = field.choices[index];
          } else {
            if (typeof answer.freeText !== "string") {
              if (!field.required && answer.usedDefault === true) continue;
              throw new Error(`No text answer for ${field.key}`);
            }
            if (!field.required && answer.freeText === "") continue;
            response[field.key] = plan.wholeObject ? JSON.parse(answer.freeText) : parseField(answer.freeText, field);
          }
        }
        return { answer: "accept", content: validate(question, plan.wholeObject ? response.response : response) };
      } else throw new Error("Unrecognized ask_user result");
    }
    if (!ctx.hasUI) return undefined; // Leave waiting_input available for a manual answer.
    if (permission && labels.length === 0) throw new Error("Permission request offers no valid options");
    const knownDefaults = defaults(question);
    const response: Record<string, unknown> = {};
    const native = async (title: string, options?: string[], placeholder?: string): Promise<string | Decision> => {
      signal.throwIfAborted();
      const deadline = Date.now() + this.timeoutMs;
      const value = options
        ? await ctx.ui.select(title, options, { signal, timeout: this.timeoutMs })
        : await ctx.ui.input(title, placeholder, { signal, timeout: this.timeoutMs });
      signal.throwIfAborted();
      return value === undefined ? { answer: Date.now() >= deadline ? "timeout" : "cancel" } : value;
    };
    if (permission) {
      const value = await native(`${question.title}\n${context}`, labels);
      if (typeof value !== "string") return value;
      const index = labels.indexOf(value);
      if (index < 0) throw new Error("Invalid permission selection");
      return { answer: "accept", option_id: String(permissionOptions[index].optionId) };
    }
    for (const field of fields) {
      const hint = knownDefaults?.[field.key] ?? field.schema.default;
      const value = await native(
        `${question.title}\n${context}\n${String(field.schema.title ?? field.key)}: ${String(field.schema.description ?? "")} (${String(field.schema.type ?? "JSON")}${field.required ? ", required" : ", optional: empty to omit"})`,
        field.labels, hint === undefined ? undefined : String(typeof hint === "string" ? hint : JSON.stringify(hint)),
      );
      if (typeof value !== "string") return value;
      if (field.choices) {
        const index = field.labels!.indexOf(value);
        if (index < 0) throw new Error("Invalid field selection");
        response[field.key] = field.choices[index];
      } else if (value !== "" || field.required) {
        response[field.key] = plan.wholeObject ? JSON.parse(value) : parseField(value, field);
      }
    }
    return { answer: "accept", content: validate(question, plan.wholeObject ? response.response : response) };
  }
}
