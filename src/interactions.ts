/**
 * Reverse-request handling: turn a server `question` into an `answer_question` payload.
 *
 * A permission request maps a selected offered option back to its `optionId`. An information or
 * elicitation request carries a JSON Schema; a flat, safely expressible object is aggregated into a
 * single `simple-form` question (or, for a plain free-form value, one `input` question) and validated
 * against the requested schema. When no interactive UI is available the router returns `undefined`
 * so the caller can surface `waiting_input` without inventing an answer; a user decision is never
 * inferred from free text, defaults, or a typed value we did not receive.
 *
 * The mapping mirrors the exact `ask_user` contract implemented in ../pi-ask-user (`src/types.ts`,
 * `src/schema.ts`, `src/answers.ts`):
 *
 *  - a `bool` field/answer carries a real boolean `value`, so `false` is preserved (never widened to
 *    a free true/false UI that could silently relax an `enum`/`const` restriction);
 *  - an `enum`/`const` property is a `single` (or `multi`, for `array` + `items.enum`/`const`) field
 *    whose option labels map back to the original typed values;
 *  - `number`/`integer`/free-form `array` values are collected as `input` text and converted back to
 *    typed JSON before Ajv validates the whole object;
 *  - a `simple-form` field's `name` is a literal safe key, its `label`/option labels are <= 80 chars,
 *    optional fields are omitted, and a schema-required array may legitimately be the empty array.
 *
 * Nothing decision-bearing is truncated: each field's full `description` (and the request message) is
 * carried by the option `preview` (<= 4000) or, for option-less fields, the `prompt` (<= 500).
 *
 * Degradation, in order:
 *  - a nested/combined schema, > 10 fields, or an unsafe field name becomes a whole-object JSON
 *    `input` whose prompt lists the expected fields and the raw schema;
 *  - a field with > 5 options (over `ask_user`'s option limit), or a required description that will
 *    not fit the allowed prompt/preview, falls back to the native UI — still per field, not JSON.
 */
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { isRecord } from "./config.ts";
import type { AskUserToolVerifier } from "./tool-trust.ts";

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

/** The four non-nesting field kinds a `simple-form` accepts (mirrors pi-ask-user's `FormFieldKind`). */
type FieldKind = "bool" | "single" | "multi" | "input";

interface FieldOption {
  label: string;
  value: unknown;
}

/** One flat, typed field the requested schema can be expressed as. */
interface FieldSpec {
  /** The literal JSON property name, used as the key in the final content object. */
  key: string;
  /** The form field name; always a safe literal key (validated against the `ask_user` contract). */
  name: string;
  /** Side label shown next to the field (<= 80 chars); the schema title, never the description. */
  label: string;
  /** The full schema description, kept verbatim so no decision-bearing text is truncated away. */
  description?: string;
  kind: FieldKind;
  /** Protocol-level requirement: a required bool/single/input must be non-empty; a required multi needs >= 1 option. */
  required: boolean;
  /** True when the schema lists this key as required but the empty array is a valid `multi` answer. */
  backfillEmpty: boolean;
  schema: Record<string, unknown>;
  /** Present for `single` and `multi`. */
  options?: FieldOption[];
}

type InfoPlan = { mode: "fields"; fields: FieldSpec[] } | { mode: "whole"; schema: Record<string, unknown> };

interface AskOption {
  label: string;
  preview?: string;
}
interface AskFormField {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: AskOption[];
}
interface AskQuestion {
  id: string;
  title: string;
  prompt?: string;
  kind: "single" | "input" | "simple-form";
  options?: AskOption[];
  fields?: AskFormField[];
}

// --- pi-ask-user contract limits (kept in lockstep with ../pi-ask-user/src/schema.ts) ----------------
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 5;
const MAX_FORM_FIELDS = 10;
const ASK_PROMPT_LIMIT = 500;
const ASK_PREVIEW_LIMIT = 4000;
const ASK_TITLE_LIMIT = 200;
const ASK_LABEL_LIMIT = 80;
const ASK_HEADER_LIMIT = 200;
const ASK_FIELD_NAME_LIMIT = 64;
/** Field names must be literal keys: letters/digits/`_`/`-`, starting with a letter or `_`. */
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/**
 * Native-only sentinel for "leave this optional field out". It starts with `(`, while every option
 * label starts with a number, so it can never collide with an offered choice.
 */
const SKIP_OPTION = "(skip optional field)";

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
(addFormats as unknown as (validator: Ajv) => void)(ajv);

const shorten = (value: string, max: number): string => (value.length > max ? value.slice(0, max - 1) + "…" : value);

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

// `enum` and `const` are conjunctive JSON Schema constraints; neither overrides the other. `enum`
// supplies the candidate labels here, and a conflicting `const` is still enforced by the final Ajv
// validation of the assembled object.
function enumValues(schema: Record<string, unknown>): { present: boolean; values: unknown[] } {
  if (Array.isArray(schema.enum)) return { present: true, values: schema.enum };
  if ("const" in schema) return { present: true, values: [schema.const] };
  return { present: false, values: [] };
}

/** A stable, unique, <= 80-char label for one enumerated value; `null` when it cannot be labeled. */
function optionLabel(value: unknown, index: number): string | null {
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return shorten(`${index + 1}. ${json}`, ASK_LABEL_LIMIT);
}

function deriveOptions(values: unknown[]): FieldOption[] | null {
  if (values.length === 0) return null;
  const options: FieldOption[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const label = optionLabel(values[index], index);
    // A duplicate label would make the returned selection ambiguous; refuse rather than guess.
    if (label === null || seen.has(label)) return null;
    seen.add(label);
    options.push({ label, value: values[index] });
  }
  return options;
}

function labelFor(key: string, schema: Record<string, unknown>): string | null {
  const title = typeof schema.title === "string" && schema.title.trim() !== "" ? schema.title : key;
  // The description is carried separately (see the question/prompt builders); it must never be
  // flattened into this 80-char label, which would silently truncate decision-bearing text.
  const label = shorten(title, ASK_LABEL_LIMIT);
  return label.trim() === "" ? null : label;
}

/** The full, un-truncated field heading used by the native UI (which has no length limit). */
function completeFieldTitle(field: FieldSpec): string {
  const title = typeof field.schema.title === "string" && field.schema.title.trim() !== "" ? field.schema.title : field.key;
  return field.description ? `${title}\n${field.description}` : title;
}

/** Every numbered candidate with its exact original value, for a native text-input fallback. */
function candidateLines(options: FieldOption[]): string {
  return options.map((option, index) => `  ${index + 1}. ${JSON.stringify(option.value)}`).join("\n");
}

/** A compact, complete description of the requested object schema for the whole-object fallback. */
function schemaHint(schema: Record<string, unknown>): string {
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const fieldLines = Object.entries(properties).map(([key, value]) => {
    const rule = isRecord(value) ? value : {};
    const type = typeof rule.type === "string" ? rule.type : "JSON";
    const mark = required.includes(key) ? " (required)" : "";
    return `  - ${key}: ${type}${mark}`;
  });
  const header = fieldLines.length > 0 ? `Expected fields:\n${fieldLines.join("\n")}` : "Expected value: a JSON object.";
  // Include the raw schema so the user can see every constraint, not just a type summary.
  return `${header}\nSchema: ${JSON.stringify(schema)}`;
}

/** Keywords whose presence makes a property inexpressible as a single typed field. */
const UNSUPPORTED_FIELD_KEYWORDS = ["$ref", "$defs", "definitions", "oneOf", "anyOf", "allOf", "not", "if", "then", "else"];

function buildField(key: string, raw: unknown, required: boolean): FieldSpec | null {
  if (!isRecord(raw)) return null;
  // A form field name is a literal output key; an unrepresentable name forces the whole-object fallback.
  if (key.length === 0 || key.length > ASK_FIELD_NAME_LIMIT || !SAFE_FIELD_NAME.test(key) || UNSAFE_OBJECT_KEYS.has(key)) return null;
  for (const keyword of UNSUPPORTED_FIELD_KEYWORDS) if (keyword in raw) return null;
  if (raw.type !== undefined && typeof raw.type !== "string") return null;
  const label = labelFor(key, raw);
  if (label === null) return null;
  const description = typeof raw.description === "string" && raw.description.trim() !== "" ? raw.description : undefined;
  const base = { key, name: key, label, ...(description ? { description } : {}), required, backfillEmpty: false, schema: raw };
  const en = enumValues(raw);
  if (en.present) {
    const options = deriveOptions(en.values);
    // An enum/const restriction (including a restricted boolean) stays a selection; it is never
    // widened into a free bool UI that could admit a value the schema forbids.
    return options ? { ...base, kind: "single", options } : null;
  }
  if (raw.type === "boolean") return { ...base, kind: "bool" };
  if (raw.type === "string" || raw.type === "number" || raw.type === "integer") return { ...base, kind: "input" };
  if (raw.type === "array") {
    const itemEnum = isRecord(raw.items) ? enumValues(raw.items) : { present: false, values: [] as unknown[] };
    if (itemEnum.present) {
      const options = deriveOptions(itemEnum.values);
      if (options) {
        const minItems = typeof raw.minItems === "number" ? raw.minItems : 0;
        // A schema-required array whose empty form is valid must still surface the key; backfill [].
        const backfillEmpty = required && minItems <= 0;
        return { ...base, kind: "multi", required: required && minItems > 0, backfillEmpty, options };
      }
    }
    // A free-form array is carried as JSON text and validated by Ajv, preserving items/minItems/uniqueItems.
    return { ...base, kind: "input" };
  }
  // Nested objects, null, union types, and untyped/ambient schemas are not a flat typed field.
  return null;
}

/** Express the requested schema as flat fields, or fall back to a whole-object JSON answer. */
function buildInfoPlan(question: Question): InfoPlan {
  const schema = question.schema ?? { type: "object" };
  if (question.schema === null) return { mode: "whole", schema };
  for (const keyword of ["$ref", "$defs", "definitions", "oneOf", "anyOf", "allOf", "not", "if", "then", "else"]) {
    if (keyword in schema) return { mode: "whole", schema };
  }
  const properties = schema.properties;
  const keys = isRecord(properties) ? Object.keys(properties) : [];
  if (keys.length === 0 || keys.length > MAX_FORM_FIELDS) return { mode: "whole", schema };
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const fields: FieldSpec[] = [];
  for (const key of keys) {
    const field = buildField(key, (properties as Record<string, unknown>)[key], required.includes(key));
    if (!field) return { mode: "whole", schema };
    fields.push(field);
  }
  return { mode: "fields", fields };
}

function convertInput(schema: Record<string, unknown>, text: string): unknown {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === undefined || type === "string") return text;
  // number/integer/array/object values arrive as text and are restored as typed JSON; Ajv verifies.
  return JSON.parse(text);
}

function convertFieldValue(field: FieldSpec, raw: unknown): unknown {
  if (field.kind === "bool") {
    if (typeof raw !== "boolean") throw new Error(`ask_user returned a non-boolean for ${field.key}`);
    return raw;
  }
  if (field.kind === "single") {
    if (typeof raw !== "string") throw new Error(`ask_user returned no option label for ${field.key}`);
    const option = field.options!.find(candidate => candidate.label === raw);
    if (!option) throw new Error(`No offered option was selected for ${field.key}`);
    return option.value;
  }
  if (field.kind === "multi") {
    if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string")) throw new Error(`ask_user returned no option labels for ${field.key}`);
    return raw.map(label => {
      const option = field.options!.find(candidate => candidate.label === label);
      if (!option) throw new Error(`No offered option was selected for ${field.key}`);
      return option.value;
    });
  }
  if (typeof raw !== "string") throw new Error(`ask_user returned no text for ${field.key}`);
  return convertInput(field.schema, raw);
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

  private readonly trustWarnings = new Set<string>();
  constructor(private readonly timeoutMs: number, private readonly verifier?: AskUserToolVerifier) {}

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
    const permission = question.kind === "permission";
    const permissionOptions = (question.options ?? []).filter(o => typeof o.optionId === "string");
    const labels = permissionOptions.map((o, i) => shorten(`${i + 1}. ${String(o.name ?? o.optionId)} [${String(o.kind ?? o.optionId)}]`, 80));
    const plan = permission ? null : buildInfoPlan(question);

    // Each field's full context + schema description is carried wherever the `ask_user` contract
    // allows it: an option-bearing field carries it in its option `preview` (<= 4000); a bool/input
    // field has no option, so the form may only be asked while the whole prompt (context + those
    // fields' titles/descriptions) still fits in 500. If a decision-bearing description cannot be
    // carried, the question falls back to the native UI (no length limit) rather than truncating it.
    const previewFor = (field: FieldSpec): string => [context, field.description].filter(Boolean).join("\n");
    let questions: AskQuestion[];
    let carrierOk: boolean;
    if (permission) {
      const permissionPreview = context.length <= ASK_PREVIEW_LIMIT ? context : null;
      questions = [{
        id: "permission", title: shorten(question.title || "ACP permission", ASK_TITLE_LIMIT), kind: "single",
        options: labels.map(label => ({ label, ...(permissionPreview !== null ? { preview: permissionPreview } : {}) })),
      }];
      carrierOk = permissionPreview !== null && labels.length > 0 && labels.length <= MAX_OPTIONS;
    } else if (plan!.mode === "fields") {
      const promptCarriers = plan!.fields.filter(field => field.kind === "bool" || field.kind === "input");
      const promptText = [context, ...promptCarriers.map(field => completeFieldTitle(field))].filter(Boolean).join("\n");
      questions = [{
        id: "form", title: shorten(question.title || "ACP request", ASK_TITLE_LIMIT),
        prompt: shorten(promptText, ASK_PROMPT_LIMIT), kind: "simple-form",
        fields: plan!.fields.map((field): AskFormField => {
          const base = { name: field.name, label: field.label, ...(field.required ? { required: true } : {}) };
          if (field.kind === "bool" || field.kind === "input") return { ...base, kind: field.kind };
          const text = previewFor(field);
          const preview = text.length <= ASK_PREVIEW_LIMIT ? text : null;
          return { ...base, kind: field.kind, options: field.options!.map(o => ({ label: o.label, ...(preview !== null ? { preview } : {}) })) };
        }),
      }];
      // bool/input fields depend on the prompt carrying the context; option fields carry it themselves.
      carrierOk = (promptCarriers.length === 0 || promptText.length <= ASK_PROMPT_LIMIT)
        && plan!.fields.every(field => (field.kind !== "single" && field.kind !== "multi") || previewFor(field).length <= ASK_PREVIEW_LIMIT);
    } else {
      // A whole-object JSON answer shows the actual expected fields and schema so the box is not bare.
      const fullPrompt = [context, schemaHint(plan!.schema)].filter(Boolean).join("\n");
      questions = [{
        id: "response", title: shorten(question.title || "ACP request", ASK_TITLE_LIMIT),
        prompt: shorten(fullPrompt, ASK_PROMPT_LIMIT), kind: "input",
      }];
      carrierOk = fullPrompt.length <= ASK_PROMPT_LIMIT;
    }

    const promptOk = questions.every(q => q.prompt === undefined || q.prompt.length <= ASK_PROMPT_LIMIT);
    const shapeOk = questions.length <= MAX_QUESTIONS && questions.every(q => {
      if (q.kind === "simple-form") {
        return Array.isArray(q.fields) && q.fields.length >= 1 && q.fields.length <= MAX_FORM_FIELDS && q.fields.every(field =>
          field.name.length <= ASK_FIELD_NAME_LIMIT && field.label.length <= ASK_LABEL_LIMIT &&
          (!field.options || (field.options.length >= 1 && field.options.length <= MAX_OPTIONS)));
      }
      return !q.options || (q.options.length >= 1 && q.options.length <= MAX_OPTIONS);
    });
    const fitsAsk = carrierOk && promptOk && shapeOk;

    const toolName = this.verifier?.toolName ?? "ask_user";
    const ask = toolCtx?.tools?.find(tool => tool.name === toolName);
    // The callable list contains no provenance. Use Pi's metadata registry, not the tool's
    // description or self-reported results. Failure happens before invoking any unknown UI.
    const trust = ask && fitsAsk && typeof toolCtx?.executeTool === "function"
      ? this.verifier?.verify() ?? { trusted: false as const, reason: "tool source verifier is unavailable" }
      : undefined;
    if (trust && !trust.trusted && !this.trustWarnings.has(trust.reason)) {
      this.trustWarnings.add(trust.reason);
      try { ctx.ui.notify(`ACP bridge: ${toolName} was not called: ${trust.reason}. Using native UI when available.`, "warning"); }
      catch { /* A diagnostic UI failure must not prevent the native fallback. */ }
    }
    if (ask && fitsAsk && trust?.trusted && typeof toolCtx?.executeTool === "function") {
      const outcome = await toolCtx.executeTool(toolName, {
        header: shorten(question.title || "ACP request", ASK_HEADER_LIMIT), questions,
        // Option labels are the only accepted answer: free text may never supplement or override a decision.
        allowFreeText: false,
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
        const get = (id: string, index: number) => answers.find(a => a.id === id) ?? answers[index];
        if (permission) {
          const selected = get("permission", 0)?.selections;
          const index = Array.isArray(selected) && selected.length === 1 ? labels.indexOf(String(selected[0])) : -1;
          if (index < 0) throw new Error("No offered permission option was explicitly selected");
          return { answer: "accept", option_id: String(permissionOptions[index].optionId) };
        }
        if (plan!.mode === "fields") {
          const answer = get("form", 0);
          const value = answer && isRecord(answer.value) ? answer.value : null;
          if (!value) throw new Error("ask_user returned no typed form value");
          const response: Record<string, unknown> = {};
          for (const field of plan!.fields) {
            // `hasOwn` keeps a real `false` or an empty array distinct from an omission.
            if (!Object.prototype.hasOwnProperty.call(value, field.name)) {
              if (field.backfillEmpty) response[field.key] = [];
              else if (field.required) throw new Error(`ask_user omitted required field ${field.key}`);
              continue;
            }
            response[field.key] = convertFieldValue(field, value[field.name]);
          }
          return { answer: "accept", content: validate(question, response) };
        }
        const answer = get("response", 0);
        if (!answer || typeof answer.freeText !== "string") throw new Error("ask_user returned no text answer");
        return { answer: "accept", content: validate(question, JSON.parse(answer.freeText)) };
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
    if (plan!.mode === "fields") {
      for (const field of plan!.fields) {
        const hint = knownDefaults?.[field.key] ?? field.schema.default;
        const heading = completeFieldTitle(field);
        const typeHint = `(${String(field.schema.type ?? "string")}${field.required ? ", required" : ", optional: empty to omit"})`;
        if (field.kind === "bool") {
          const choices = field.required ? ["1. true", "2. false"] : ["1. true", "2. false", SKIP_OPTION];
          const value = await native(`${question.title}\n${context}\n${heading} ${typeHint}`, choices);
          if (typeof value !== "string") return value;
          if (!field.required && value === SKIP_OPTION) continue;
          if (value === "1. true") response[field.key] = true;
          else if (value === "2. false") response[field.key] = false;
          else throw new Error(`Invalid boolean selection for ${field.key}`);
        } else if (field.kind === "single") {
          const optionLabels = field.options!.map(option => option.label);
          // An optional selection gets a real skip entry so omission behaves the same on both routes.
          if (optionLabels.includes(SKIP_OPTION)) throw new Error(`Reserved native skip label collides with an option for ${field.key}`);
          const choices = field.required ? optionLabels : [...optionLabels, SKIP_OPTION];
          const value = await native(`${question.title}\n${context}\n${heading} ${typeHint}`, choices);
          if (typeof value !== "string") return value;
          if (!field.required && value === SKIP_OPTION) continue;
          const option = field.options!.find(candidate => candidate.label === value);
          if (!option) throw new Error(`Invalid field selection for ${field.key}`);
          response[field.key] = option.value;
        } else if (field.kind === "multi") {
          // The user types option numbers, so every numbered candidate (with its exact original
          // value) must be visible in the box title; a truncated label would be unusable here.
          const title = `${question.title}\n${context}\n${heading} ${typeHint}\nChoose one or more:\n${candidateLines(field.options!)}`;
          const value = await native(title, undefined, "option numbers, e.g. 1,3");
          if (typeof value !== "string") return value;
          if (value.trim() === "") {
            if (field.backfillEmpty) response[field.key] = [];
            else if (field.required) throw new Error(`No option selected for required field ${field.key}`);
            continue;
          }
          const selected = new Set<unknown>();
          for (const token of value.trim().split(/[,\uFF0C\u3001\s]+/).filter(Boolean)) {
            if (!/^\d+$/.test(token)) throw new Error(`Invalid option number for ${field.key}`);
            const index = Number.parseInt(token, 10) - 1;
            if (index < 0 || index >= field.options!.length) throw new Error(`Option out of range for ${field.key}`);
            selected.add(field.options![index].value);
          }
          response[field.key] = [...selected];
        } else {
          const value = await native(`${question.title}\n${context}\n${heading} ${typeHint}`, undefined, hint === undefined ? undefined : String(typeof hint === "string" ? hint : JSON.stringify(hint)));
          if (typeof value !== "string") return value;
          if (value.trim() === "") {
            if (field.required) throw new Error(`No answer for required field ${field.key}`);
            continue;
          }
          response[field.key] = convertInput(field.schema, value);
        }
      }
      return { answer: "accept", content: validate(question, response) };
    }
    // A whole-object JSON answer shows the expected fields and the raw schema (the native title has no limit).
    const value = await native(`${question.title}\n${context}\n${schemaHint(plan!.schema)}`.trim(), undefined, undefined);
    if (typeof value !== "string") return value;
    return { answer: "accept", content: validate(question, JSON.parse(value)) };
  }
}
