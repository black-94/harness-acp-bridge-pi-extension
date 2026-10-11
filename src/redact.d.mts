export { REDACTED, isSensitiveKeyName, redactText, matchRanges } from "./redact-core.mjs";
export declare const MIN_SECRET_LENGTH = 8;
/** A nested record value with credential-named keys and textual secrets masked. */
export declare function redactValue<T>(value: T, secrets?: readonly string[]): T;
/** True when an environment/config key names a value that must never be persisted. */
export declare function isSensitiveName(name: unknown): boolean;
/** Collect literal secret values from sensitive-named environment and harness environment keys. */
export declare function collectSecrets(env?: NodeJS.ProcessEnv, harnesses?: Record<string, {
    env?: Record<string, string>;
}>): string[];
/** Redact a persisted byte blob. Valid UTF-8 is round-tripped exactly when untouched. */
export declare function redactBytes(buffer: Buffer, secrets: readonly string[]): Buffer;
/**
 * A redactor bound to a fixed set of literal secrets. Cheap to construct; the secret set is
 * kept in memory only and never written to disk.
 */
export declare class Redactor {
    readonly secrets: readonly string[];
    constructor(secrets?: readonly string[]);
    text(value: string): string;
    value<T>(value: T): T;
    bytes(buffer: Buffer): Buffer;
    /** A bounded, cross-chunk redactor for streamed diagnostics (stderr, oversized fragments). */
    stream(charset?: "utf8" | "latin1"): StreamRedactor;
}
/**
 * A bounded streaming redactor for chunked diagnostics.
 *
 * Callers feed arbitrary chunks; it returns the redacted bytes that are safe to persist, holding
 * back a bounded tail so a secret or multi-line construct split across chunk boundaries is never
 * emitted half-redacted. `flush()` releases the tail at EOF.
 *
 * Memory is hard-bounded. When a *confirmed* sensitive value (a quoted/unquoted credential value,
 * an Authorization value, a runaway provider token, or an unterminated PRIVATE KEY body) grows
 * past the hold budget without terminating, the redactor masks the value and then, guided by the
 * value's real terminator (closing quote / delimiter / non-token byte / end-of-line), resumes
 * emitting the ordinary suffix right after it. The field key/prefix before the value is preserved,
 * so the rest of the line is never dropped.
 */
export declare class StreamRedactor {
    private carry;
    private inPem;
    /** Inside an over-long confirmed value: `until` describes how to find its real end. */
    private mask;
    private maskEscaped;
    /** Nesting depth and string state while consuming a `container` value. */
    private containerDepth;
    private containerQuoted;
    private readonly hold;
    private readonly utf8Secrets;
    private readonly latin1Secrets;
    private readonly charset;
    constructor(secrets: readonly string[], charset?: "utf8" | "latin1");
    push(chunk: Buffer): Buffer;
    flush(): Buffer;
    /**
     * Drop masked value bytes until the terminator. Returns the remainder (the terminator itself is
     * kept for `quote`/`chars`/`line`, dropped for `container` since the close belongs to the
     * placeholder), or null when the terminator has not arrived yet.
     */
    private consumeMask;
    /**
     * Longest valid prefix of the carry plus how to re-encode it. When the bytes are not valid UTF-8
     * the view is decoded as latin1 (`encoding: "latin1"`) so the untouched bytes round-trip exactly
     * rather than being mojibake'd by a later utf8 re-encode.
     */
    private decodeView;
    /** Emit `text[0..cut)` (redacted), consume its bytes from the carry, and return the encoded bytes. */
    private emitPrefix;
    /**
     * The hold budget is exhausted by a confirmed sensitive value. Emit everything before the value
     * (the field key and separator, plus the opening quote for a quoted value), a single placeholder,
     * then consume the buffered value content up to its real terminator and resume emitting the
     * ordinary suffix — never dropping the rest of the line and never leaking the value.
     */
    private enterMask;
    /** Mask exactly `[blocker.start, blocker.end)` (a complete match) and resume after it. */
    private replaceFinite;
    private drain;
}
