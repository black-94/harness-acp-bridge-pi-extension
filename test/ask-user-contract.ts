/**
 * A self-contained, strict mirror of the `ask_user` request contract.
 *
 * This intentionally duplicates the limits and rules of the sibling `../pi-ask-user`
 * (`src/schema.ts` `AskUserParams` + `normalizeAskUserRequest`) so the default `npm test` suite
 * has **no dependency on that checkout** and can run in an isolated `pi-extension` clone. The real
 * normalizer is still exercised by `npm run test:protocol` (`test/protocol/`), which is opt-in.
 *
 * Source of truth (kept in lockstep): `../pi-ask-user/src/schema.ts`.
 */
const LIMITS = { title: 200, prompt: 500, label: 80, description: 240, preview: 4000, defaultValue: 500, header: 200, fieldName: 64 };
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 5;
const MAX_FORM_FIELDS = 10;
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const QUESTION_KINDS = new Set(["single", "multi", "input", "bool", "simple-form"]);
const FIELD_KINDS = new Set(["bool", "single", "multi", "input"]);
const REQUEST_FIELDS = new Set(["questions", "header", "displayMode", "timeoutPerQuestionMs", "allowFreeText"]);
const QUESTION_FIELDS = new Set(["id", "title", "prompt", "kind", "options", "default", "fields"]);
const FORM_FIELD_FIELDS = new Set(["name", "label", "kind", "required", "options", "default"]);
const OPTION_FIELDS = new Set(["label", "description", "preview"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(`ask_user contract violation: ${message}`);
}
function knownKeys(record: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${where} has an unknown field "${key}"`);
}
function text(value: unknown, where: string, max: number): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  if (value.trim() === "") fail(`${where} must not be empty`);
  if (value.length > max) fail(`${where} exceeds the ${max}-character limit`);
  return value;
}

function checkOptions(value: unknown[], where: string): void {
  if (value.length === 0) fail(`${where} must have at least one option`);
  if (value.length > MAX_OPTIONS) fail(`${where} has more than ${MAX_OPTIONS} options`);
  const seen = new Set<string>();
  for (const [index, option] of value.entries()) {
    if (!isRecord(option)) fail(`${where} option ${index + 1} must be an object`);
    knownKeys(option, OPTION_FIELDS, `${where} option ${index + 1}`);
    const label = text(option.label, `${where} option ${index + 1} label`, LIMITS.label);
    if (seen.has(label)) fail(`${where} has a duplicate option "${label}"`);
    seen.add(label);
    if (option.description !== undefined && (typeof option.description !== "string" || option.description.length > LIMITS.description)) {
      fail(`${where} option ${index + 1} description is invalid`);
    }
    if (option.preview !== undefined && (typeof option.preview !== "string" || option.preview.length > LIMITS.preview)) {
      fail(`${where} option ${index + 1} preview is invalid`);
    }
  }
}

function checkFormField(value: unknown, where: string): void {
  if (!isRecord(value)) fail(`${where} must be an object`);
  knownKeys(value, FORM_FIELD_FIELDS, where);
  const name = text(value.name, `${where} name`, LIMITS.fieldName);
  if (!SAFE_FIELD_NAME.test(name)) fail(`${where} name must be a literal key`);
  if (UNSAFE_OBJECT_KEYS.has(name)) fail(`${where} name "${name}" is reserved`);
  text(value.label, `${where} label`, LIMITS.label);
  if (typeof value.kind !== "string" || !FIELD_KINDS.has(value.kind)) fail(`${where} kind is invalid`);
  if (value.required !== undefined && typeof value.required !== "boolean") fail(`${where} required must be boolean`);
  const options = Array.isArray(value.options) ? value.options : undefined;
  if ((value.kind === "bool" || value.kind === "input") && options !== undefined) fail(`${where} is ${value.kind} and must not have options`);
  if (value.kind === "single" || value.kind === "multi") {
    if (options === undefined) fail(`${where} is ${value.kind} and needs options`);
    checkOptions(options, where);
  }
  if (value.default !== undefined) fail(`${where} must not carry a schema default`);
}

function checkQuestion(value: unknown, index: number): void {
  const where = `question ${index + 1}`;
  if (!isRecord(value)) fail(`${where} must be an object`);
  knownKeys(value, QUESTION_FIELDS, where);
  text(value.title, `${where} title`, LIMITS.title);
  if (value.id !== undefined) text(value.id, `${where} id`, 64);
  if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length > LIMITS.prompt)) fail(`${where} prompt is invalid`);
  if (typeof value.kind !== "string" || !QUESTION_KINDS.has(value.kind)) fail(`${where} kind is invalid`);
  const options = Array.isArray(value.options) ? value.options : undefined;
  if ((value.kind === "bool" || value.kind === "simple-form") && options !== undefined) fail(`${where} is ${value.kind} and must not have options`);
  if (value.kind === "single" || value.kind === "multi") {
    if (options === undefined) fail(`${where} is ${value.kind} and needs options`);
    checkOptions(options, where);
  }
  if (value.kind === "simple-form") {
    if (!Array.isArray(value.fields)) fail(`${where} simple-form needs a fields array`);
    if (value.fields.length === 0 || value.fields.length > MAX_FORM_FIELDS) fail(`${where} has ${value.fields.length} fields`);
    if (value.default !== undefined) fail(`${where} simple-form must not have a top-level default`);
    value.fields.forEach((field, fieldIndex) => checkFormField(field, `${where} field ${fieldIndex + 1}`));
  } else if (value.fields !== undefined) {
    fail(`${where} is ${value.kind} and must not have fields`);
  }
}

/** Throws when `payload` is not an exact, minimal, protocol-legal `ask_user` argument object. */
export function assertAskUserContract(payload: unknown): void {
  if (!isRecord(payload)) fail("request must be an object");
  knownKeys(payload, REQUEST_FIELDS, "request");
  if (!Array.isArray(payload.questions)) fail("request needs a questions array");
  if (payload.questions.length === 0 || payload.questions.length > MAX_QUESTIONS) fail(`request has ${payload.questions.length} questions`);
  if (payload.header !== undefined && (typeof payload.header !== "string" || payload.header.length > LIMITS.header)) fail("header is invalid");
  if (payload.displayMode !== undefined) fail("displayMode must not be set by the bridge");
  if (payload.allowFreeText !== undefined && typeof payload.allowFreeText !== "boolean") fail("allowFreeText must be boolean");
  payload.questions.forEach((question, index) => checkQuestion(question, index));
}
