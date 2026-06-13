import type {
  AssistantMessage,
  BashToolUseMessageContent,
  EditToolUseMessageContent,
  GlobToolUseMessageContent,
  GrepToolUseMessageContent,
  ReadToolUseMessageContent,
  RunResult,
  SkillToolUseMessageContent,
  ToolUseMessageContent,
  WebFetchToolUseMessageContent,
  WebSearchToolUseMessageContent,
  WriteToolUseMessageContent,
} from "@/sys";

import type {
  Card,
  CollapsiblePanel,
  DivElement,
  MarkdownElement,
} from "./types";

const MAX_PROGRESS_CHARS = 60;

export type LiveCardState = "running" | "done" | "error";

export interface LiveCardOptions {
  progressLines: string[];
  finalText?: string;
  elapsedMs: number;
  state: LiveCardState;
  runResult?: RunResult;
  effortLevel?: string;
  sessionId?: string;
}

/**
 * Build a live-streaming card per design spec:
 *  - Header: "⏳ 处理中 · 已耗时 Xs" / "✅ 完成 · 总耗时 Xs" / "⚠️ 已中断 · 耗时 Xs"
 *  - Body (running): collapsible_panel expanded=true with markdown progress_body
 *  - Body (done):    collapsible_panel expanded=false + markdown result_body + footer
 */
export function buildLiveCard(opts: LiveCardOptions): Card {
  const { progressLines, finalText, elapsedMs, state, runResult, effortLevel, sessionId } =
    opts;

  const elapsedStr = _formatElapsed(elapsedMs);
  const isRunning = state === "running";
  const headerEmoji =
    state === "running" ? "⏳ 处理中" : state === "error" ? "⚠️ 已中断" : "✅ 完成";
  const timeLabel = isRunning ? "已耗时" : "总耗时";
  const headerTitle = `${headerEmoji} · ${timeLabel} ${elapsedStr}`;

  // Join with a markdown hard line break (trailing two spaces + newline)
  // rather than a blank line; blank lines render as paragraph breaks and leave
  // the collapsible panel visually too airy.
  const progressContent = progressLines.join("  \n");

  const card: Card = {
    schema: "2.0",
    config: {
      ...(isRunning ? { streaming_mode: true, update_multi: true } : {}),
      enable_forward: true,
      enable_forward_interaction: true,
      width_mode: "fill",
      summary: { content: headerTitle },
    },
    header: {
      title: { tag: "plain_text", content: headerTitle },
      template: isRunning ? "blue" : state === "error" ? "red" : "green",
    },
    body: {
      elements: [],
    },
  };

  if (progressContent.length > 0) {
    const progressPanel: CollapsiblePanel = {
      tag: "collapsible_panel",
      element_id: "progress_panel",
      expanded: isRunning,
      border: { color: "grey-300", corner_radius: "6px" },
      vertical_spacing: "4px",
      header: {
        title: {
          tag: "plain_text",
          text_color: "grey",
          text_size: "notation",
          content: isRunning ? "执行过程" : "查看执行过程",
        },
        icon: {
          tag: "standard_icon",
          token: "right_outlined",
          color: "grey",
        },
        icon_position: "right",
        icon_expanded_angle: 90,
      },
      elements: [
        {
          tag: "markdown",
          element_id: "progress_body",
          content: progressContent,
        } satisfies MarkdownElement,
      ],
    };
    card.body.elements.push(progressPanel);
  }

  if (!isRunning && finalText && finalText.trim().length > 0) {
    card.body.elements.push({
      tag: "markdown",
      element_id: "result_body",
      content: finalText,
    } satisfies MarkdownElement);
    card.config!.summary.content = _summaryFromText(finalText);
  }

  if (!isRunning && (runResult || sessionId)) {
    card.body.elements.push(_renderFooter(sessionId, runResult, effortLevel));
  }

  if (isRunning) {
    // "…" affordance so user sees something live even before first patch lands
    card.body.elements.push({
      tag: "div",
      icon: {
        tag: "standard_icon",
        token: "more_outlined",
        color: "grey",
      },
    } satisfies DivElement);
  }

  if (card.body.elements.length === 0) {
    card.body.elements.push({
      tag: "div",
      text: { tag: "plain_text", content: "" },
    } satisfies DivElement);
  }

  return card;
}

/**
 * Take an already-rendered "final" card (produced by `renderMessageCard` in
 * non-streaming mode, which has already uploaded images, extracted chart blocks,
 * and split tables) and decorate it with live-card chrome:
 *   - a header (✅ 完成 / ⚠️ 已中断 + elapsed)
 *   - a progress panel (💭/🛠️ progressLines) inserted at the top of the body
 *
 * The caller is responsible for sending any `remainingChunks` and file
 * attachments that `renderMessageCard`'s split pipeline produced.
 */
export function decorateFinalLiveCard(
  renderedCard: Card,
  opts: {
    progressLines: string[];
    elapsedMs: number;
    state: Exclude<LiveCardState, "running">;
  },
): Card {
  const { progressLines, elapsedMs, state } = opts;
  const elapsedStr = _formatElapsed(elapsedMs);
  const headerEmoji = state === "error" ? "⚠️ 已中断" : "✅ 完成";
  const headerTitle = `${headerEmoji} · 总耗时 ${elapsedStr}`;

  // Clone shallowly so we don't mutate the caller's card reference.
  const card: Card = {
    ...renderedCard,
    header: {
      title: { tag: "plain_text", content: headerTitle },
      template: state === "error" ? "red" : "green",
    },
    body: { ...renderedCard.body, elements: [...renderedCard.body.elements] },
  };

  // renderMessageCard already puts its own collapsible_panel of _renderStep()
  // items at position 0 (or omits it when empty). Drop it so our consolidated
  // progress panel can take its place — the two would otherwise duplicate the
  // same thought/tool activity in two different formats.
  if (card.body.elements[0]?.tag === "collapsible_panel") {
    card.body.elements.shift();
  }

  const progressContent = progressLines.join("  \n");
  if (progressContent.length > 0) {
    const progressPanel: CollapsiblePanel = {
      tag: "collapsible_panel",
      element_id: "progress_panel",
      expanded: false,
      border: { color: "grey-300", corner_radius: "6px" },
      vertical_spacing: "4px",
      header: {
        title: {
          tag: "plain_text",
          text_color: "grey",
          text_size: "notation",
          content: "查看执行过程",
        },
        icon: {
          tag: "standard_icon",
          token: "right_outlined",
          color: "grey",
        },
        icon_position: "right",
        icon_expanded_angle: 90,
      },
      elements: [
        {
          tag: "markdown",
          element_id: "progress_body",
          content: progressContent,
        } satisfies MarkdownElement,
      ],
    };
    card.body.elements.unshift(progressPanel);
  }

  return card;
}

/**
 * Turn a single assistant content block into one progress line per design spec.
 * Returns null if the block should be filtered.
 *
 *  - text / thinking  → "💭 <first sentence, trimmed to 60 chars>"
 *  - tool_use         → "🛠️ <tool-specific summary>"
 *  - other            → null
 */
export function extractProgressLine(
  block: AssistantMessage["content"][number],
): { category: "thought" | "tool"; key: string; line: string } | null {
  if (block.type === "thinking") {
    const line = _formatThought(block.thinking);
    if (!line) return null;
    return { category: "thought", key: line, line };
  }
  if (block.type === "tool_use") {
    const line = _formatToolUse(block);
    if (!line) return null;
    return { category: "tool", key: `${block.name}:${line}`, line };
  }
  // `text` blocks are the assistant's final answer — they already appear in
  // the result body; do not duplicate them into the progress panel.
  return null;
}

function _formatThought(text: string): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const firstSentence = _firstSentence(cleaned);
  return `💭 ${_truncate(firstSentence, MAX_PROGRESS_CHARS)}`;
}

/**
 * Extract the first sentence from a cleaned single-line string.
 *
 *   - Chinese sentence ends (。！？) always split.
 *   - English sentence ends (.!?) split only when followed by whitespace or EOS,
 *     so file paths like `/Users/chenhao/.claude/...` stay intact.
 */
function _firstSentence(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "。" || c === "！" || c === "？") {
      return text.slice(0, i + 1);
    }
    if (c === "." || c === "!" || c === "?") {
      const next = text[i + 1];
      if (!next || /\s/.test(next)) {
        return text.slice(0, i + 1);
      }
    }
  }
  return text;
}

function _formatToolUse(content: ToolUseMessageContent): string | null {
  switch (content.name) {
    case "Agent":
    case "Task":
      return "🛠️ Sub-agent";
    case "Bash": {
      const c = content as BashToolUseMessageContent;
      const desc = c.input.description ?? c.input.command ?? "";
      return `🛠️ Bash: ${_truncate(desc, MAX_PROGRESS_CHARS)}`;
    }
    case "Edit": {
      const c = content as EditToolUseMessageContent;
      return `🛠️ Edit ${_basename(c.input.file_path)}`;
    }
    case "Read": {
      const c = content as ReadToolUseMessageContent;
      return `🛠️ Read ${_basename(c.input.file_path)}`;
    }
    case "Write": {
      const c = content as WriteToolUseMessageContent;
      return `🛠️ Write ${_basename(c.input.file_path)}`;
    }
    case "Glob": {
      const c = content as GlobToolUseMessageContent;
      return `🛠️ Glob "${_truncate(c.input.pattern, 40)}"`;
    }
    case "Grep": {
      const c = content as GrepToolUseMessageContent;
      return `🛠️ Grep "${_truncate(c.input.pattern, 40)}"`;
    }
    case "WebFetch": {
      const c = content as WebFetchToolUseMessageContent;
      return `🛠️ WebFetch ${_truncate(c.input.url, 50)}`;
    }
    case "WebSearch": {
      const c = content as WebSearchToolUseMessageContent;
      return `🛠️ WebSearch "${_truncate(c.input.query, 40)}"`;
    }
    case "Skill": {
      const c = content as SkillToolUseMessageContent;
      return `🛠️ Skill ${c.input.skill}`;
    }
    case "ToolSearch":
      return null;
    default:
      return `🛠️ ${content.name}`;
  }
}

function _renderFooter(sessionId?: string, runResult?: RunResult, effortLevel?: string): DivElement {
  const parts: string[] = [];
  if (runResult) {
    const { model, cost_usd, usage, context_window, context_used } = runResult;
    const totalInput =
      usage.input_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens;
    const totalOutput = usage.output_tokens;
    const costStr = cost_usd < 0.001 ? "<$0.001" : `$${cost_usd.toFixed(3)}`;
    const effortStr = effortLevel ? ` · effort: ${effortLevel}` : "";
    let ctxStr = "";
    if (context_window && context_used != null && context_window > 0) {
      const pct = Math.round((context_used / context_window) * 100);
      ctxStr = ` · ctx:${pct}%`;
    }
    parts.push(`${model}${effortStr} · ↑ ${totalInput.toLocaleString()} ↓ ${totalOutput.toLocaleString()} tokens · ${costStr}${ctxStr}`);
  }
  if (sessionId) {
    parts.push(`sid:${sessionId.slice(0, 8)}`);
  }
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content: parts.join(" · "),
    },
  };
}

function _formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${mm.toString().padStart(2, "0")}m`;
}

function _truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function _basename(p: string): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function _summaryFromText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return _truncate(cleaned, 80);
}
