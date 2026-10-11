/**
 * UI-only rendering for the synchronous `acp_send_message` / `acp_wait` tools.
 *
 * Pi's default tool renderer never shows `details`, so a preview that only lived in
 * `details.preview` would be invisible. This renderer draws the rolling preview (and, on
 * settle, the final answer) in the transcript UI. Renderer output is presentation only: it is
 * never part of the tool result `content`/`structuredContent`/`details` and never reaches the
 * model context.
 *
 * Width handling uses the pi-tui text utilities (`wrapTextWithAnsi`, `truncateToWidth`,
 * `visibleWidth`) so ANSI escapes are preserved but not counted as width, wide CJK/emoji count
 * as two columns, and every returned line satisfies `visibleWidth(line) <= width`.
 */
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isRecord } from "./config.ts";

const MAX_PREVIEW_LINES = 12;
const ELLIPSIS = "…";

function wrapLine(text: string, width: number): string[] {
  if (text === "") return [""];
  const wrapped = wrapTextWithAnsi(text, width);
  return wrapped.length ? wrapped : [""];
}

function component(theme: Theme, header: string, body: string): { render(width: number): string[]; invalidate(): void } {
  return {
    render(width: number): string[] {
      const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      if (safeWidth <= 0) return [""];
      const lines = [truncateToWidth(theme.fg("dim", header), safeWidth, ELLIPSIS)];
      const bodyLines: string[] = [];
      for (const raw of body === "" ? [] : body.split("\n")) {
        for (const piece of wrapLine(theme.fg("toolOutput", raw), safeWidth)) bodyLines.push(piece);
      }
      for (const line of bodyLines.slice(-MAX_PREVIEW_LINES)) lines.push(line);
      // Defensive: guarantee the invariant even if a helper ever overshoots.
      return lines.map(line => (visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, ELLIPSIS)));
    },
    invalidate(): void { /* stateless */ },
  };
}

function finalText(result: AgentToolResult<Record<string, unknown>>): string {
  const details = isRecord(result.details) ? result.details : {};
  const inner = isRecord(details.result) ? details.result : null;
  if (inner && typeof inner.text === "string") return inner.text;
  return (result.content ?? [])
    .filter(isRecord)
    .filter(part => part.type === "text")
    .map(part => String(part.text ?? ""))
    .join("\n");
}

/** Custom Pi tool renderer: preview while running, final answer once settled. */
export function renderAcpResult(
  result: AgentToolResult<Record<string, unknown>>,
  options: { isPartial: boolean },
  theme: Theme,
): { render(width: number): string[]; invalidate(): void } {
  const details = isRecord(result.details) ? result.details : {};
  const state = typeof details.state === "string" ? details.state : options.isPartial ? "running" : "done";
  if (options.isPartial) {
    return component(theme, `ACP ${state}`, typeof details.preview === "string" ? details.preview : "");
  }
  return component(theme, `ACP ${state}`, finalText(result));
}
