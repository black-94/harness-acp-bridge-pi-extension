/**
 * Core redaction rules: the sensitive-key classifier and the textual pattern matcher.
 *
 * Kept dependency-free so both the persistence layer and the bounded streaming redactor can
 * share exactly one definition of "what counts as sensitive". See `redact.ts` for the
 * higher-level `Redactor`/`StreamRedactor` wrappers.
 */
export declare const REDACTED = "[REDACTED]";
/** Literal secret values shorter than this are ignored to avoid masking ordinary words. */
export declare const MIN_SECRET_LENGTH = 8;
/** Normalize a key to lowercase alphanumerics: `accessToken` and `access_token` -> `accesstoken`. */
export declare function normalizeKey(name: string): string;
/**
 * True when an object key names a common credential.
 *
 * Exact matches plus a curated suffix set. The suffix set deliberately excludes `tokens`
 * (plural), so counters such as `max_tokens`/`token_count`/`input_tokens` are never masked,
 * and excludes a bare `key` suffix so `public_key`/`registry_key`/`monkey` are preserved.
 */
export declare function isSensitiveKeyName(name: string): boolean;
/**
 * How the streaming redactor finds the end of an over-long value it has already decided is
 * sensitive (so it can resume emitting the ordinary suffix right after the value, instead of
 * dropping the rest of the line).
 */
export type ValueUntil = {
    kind: "quote";
    quote: string;
} | {
    kind: "line";
} | {
    kind: "chars";
    stop: RegExp;
} | {
    kind: "container";
};
export interface Range {
    start: number;
    end: number;
    replacement: string;
    /**
     * Earliest offset that must also be held back while this match is still incomplete, so a value
     * split across a chunk boundary is re-detected together with its key. For a `key: value` or
     * `Authorization:` match this is the key/header start; callers that only mask `[start, end)` may
     * ignore it.
     */
    contextStart?: number;
    /** Terminator class for the value, used only by the bounded streaming redactor. */
    until?: ValueUntil;
}
/** Sorted, non-overlapping masked ranges for a text blob. */
export declare function matchRanges(text: string, secrets?: readonly string[]): Range[];
/** Apply already-computed, sorted, non-overlapping ranges without re-scanning the text. */
export declare function applyRanges(text: string, ranges: readonly Range[]): string;
/** Mask sensitive keys and patterns in a text blob, preserving everything else verbatim. */
export declare function redactText(text: string, secrets?: readonly string[]): string;
