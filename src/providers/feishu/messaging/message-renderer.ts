import fs from "node:fs";
import nodePath from "node:path";

import {
  config,
  getEnv,
  type AssistantMessage,
  type RunResult,
  type BashToolUseMessageContent,
  type EditToolUseMessageContent,
  type GlobToolUseMessageContent,
  type GrepToolUseMessageContent,
  type ReadToolUseMessageContent,
  type SkillToolUseMessageContent,
  type ToolUseMessageContent,
  type WebFetchToolUseMessageContent,
  type WebSearchToolUseMessageContent,
  type WriteToolUseMessageContent,
} from "@/sys";

import type {
  Card,
  ChartElement,
  CollapsiblePanel,
  DivElement,
  MarkdownElement,
} from "./types";

/**
 * Render assistant message content as a Feishu interactive card.
 * @param messageContent - Array of content blocks (thinking, tool_use, text).
 * @param options - Rendering options (streaming mode).
 * @returns Feishu Card object for API payload.
 */
export async function renderMessageCard(
  messageContent: AssistantMessage["content"],
  {
    streaming,
    uploadImage,
    runResult,
    sessionId,
  }: {
    streaming: boolean;
    uploadImage: (path: string) => Promise<string>;
    runResult?: RunResult;
    sessionId?: string;
  },
): Promise<Card> {
  const stepPanel: CollapsiblePanel = {
    tag: "collapsible_panel",
    expanded: false,
    border: {
      color: "grey-300",
      corner_radius: "6px",
    },
    vertical_spacing: "2px",
    header: {
      title: {
        tag: "plain_text",
        text_color: "grey",
        text_size: "notation",
        content: "",
      },
      icon: {
        tag: "standard_icon",
        token: "right_outlined",
        color: "grey",
      },
      icon_position: "right",
      icon_expanded_angle: 90,
    },
    elements: [],
  };
  const card: Card = {
    schema: "2.0",
    config: {
      ...(streaming ? { streaming_mode: true, update_multi: true } : {}),
      enable_forward: true,
      enable_forward_interaction: true,
      width_mode: "fill",
      summary: {
        content: "",
      },
    },
    body: {
      elements: [stepPanel],
    },
  };
  for (const content of messageContent) {
    if (content.type === "thinking") {
      stepPanel.elements.push(_renderStep(content.thinking, "robot_outlined"));
    } else if (content.type === "tool_use") {
      _renderTool(content, stepPanel);
    }
  }
  if (!streaming) {
    // Find the last text block (final response), not all text blocks
    const lastTextContent = messageContent.findLast((c) => c.type === "text");
    if (lastTextContent) {
      const markdownContent = await _uploadMessageResource(
        lastTextContent.text,
        {
          uploadImage,
        },
      );

      // Extract chart code blocks → interleaved Markdown + Chart elements
      const contentElements = _extractChartElements(markdownContent);
      // Set summary to plain text (strip chart blocks for notification preview)
      card.config!.summary.content = markdownContent.replace(
        CHART_BLOCK_REGEX,
        "[chart]",
      );
      for (const element of contentElements) {
        card.body.elements.push(element);
      }
    }

    if (runResult || sessionId) {
      card.body.elements.push(_renderFooter(sessionId, runResult));
    }
  }

  const stepCount = stepPanel.elements.length;
  if (stepCount > 0) {
    const stepCountText =
      stepCount + " " + (stepCount === 1 ? "step" : "steps");
    if (streaming) {
      stepPanel.header.title.content = `Working on it (${stepCountText})`;
      card.config!.summary.content = `Working on it (${stepCountText})`;
    } else {
      stepPanel.header.title.content = `Show ${stepCountText}`;
    }
  } else {
    // No steps, remove the collapsible panel if it exists
    if (card.body.elements[0]?.tag === "collapsible_panel") {
      card.body.elements.splice(0, 1);
    }
    if (card.body.elements.length === 0) {
      card.body.elements.push({
        tag: "div",
        text: {
          tag: "plain_text",
          content: "",
        },
      });
    }
  }
  if (streaming) {
    card.body.elements.push({
      tag: "div",
      icon: {
        tag: "standard_icon",
        token: "more_outlined",
        color: "grey",
      },
    });
  }
  return card;
}

async function _uploadMessageResource(
  text: string,
  {
    uploadImage,
  }: {
    uploadImage: (path: string) => Promise<string>;
  },
): Promise<string> {
  const images = text.match(/!\[.*?\]\((.*?)\)/g);
  if (images) {
    for (const image of images) {
      let imagePath = image.match(/!\[.*?\]\((.*?)\)/)?.[1];
      if (imagePath) {
        if (imagePath.startsWith("http:") || imagePath.startsWith("https:")) {
          try {
            // Bound this download — a stalled image URL would otherwise hang the
            // whole turn (and the serial queue) forever; on timeout it throws and
            // the catch below skips the image, leaving the reply intact.
            const response = await fetch(imagePath, {
              signal: AbortSignal.timeout(
                parseInt(getEnv("CLARK_IMG_FETCH_TIMEOUT_MS", "15000"), 10),
              ),
            });
            const imageBuffer = await response.arrayBuffer();
            const imageName = imagePath.split("/").pop();
            const downloadPath = nodePath.join(config.workspaceDir, "downloads");
            if (!fs.existsSync(downloadPath)) {
              fs.mkdirSync(downloadPath, { recursive: true });
            }
            if (imageName) {
              fs.writeFileSync(
                nodePath.join(downloadPath, imageName),
                Buffer.from(imageBuffer),
              );
              imagePath = nodePath.join("downloads", imageName);
            }
          } catch {
            text = text.replaceAll(image, `[${imagePath}](${imagePath})`);
          }
        }
        if (fs.existsSync(nodePath.join(config.workspaceDir, imagePath))) {
          const imageKey = await uploadImage(imagePath);
          text = text.replaceAll(image, `![image](${imageKey})`);
        } else {
          text = text.replaceAll(image, "");
        }
      }
    }
  }
  return text;
}

/** Render a single tool use step into the collapsible panel. */
function _renderTool(
  content: ToolUseMessageContent,
  stepPanel: CollapsiblePanel,
) {
  switch (content.name) {
    case "Agent":
    case "Task":
      stepPanel.elements.push(_renderStep("Run sub-agent", "robot_outlined"));
      break;
    case "Bash":
      const bashContent = content as BashToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          bashContent.input.description ?? bashContent.input.command,
          "computer_outlined",
        ),
      );
      break;
    case "Edit":
      const editContent = content as EditToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(`Edit "${editContent.input.file_path}"`, "edit_outlined"),
      );
      break;
    case "Glob":
      const globContent = content as GlobToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Search files by pattern "${globContent.input.pattern}"`,
          "card-search_outlined",
        ),
      );
      break;
    case "Grep":
      const grepContent = content as GrepToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Search text by pattern "${grepContent.input.pattern}" in "${grepContent.input.glob}"`,
          "doc-search_outlined",
        ),
      );
      break;
    case "WebFetch":
      const webFetchContent = content as WebFetchToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Fetch web page from "${webFetchContent.input.url}"`,
          "language_outlined",
        ),
      );
      break;
    case "WebSearch":
      const webSearchContent = content as WebSearchToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Search web for "${webSearchContent.input.query}"`,
          "search_outlined",
        ),
      );
      break;
    case "Read":
      const readContent = content as ReadToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Read file "${readContent.input.file_path}"`,
          "file-link-bitable_outlined",
        ),
      );
      break;
    case "Write":
      const writeContent = content as WriteToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Write file "${writeContent.input.file_path}"`,
          "edit_outlined",
        ),
      );
      break;
    case "Skill":
      const skillContent = content as SkillToolUseMessageContent;
      stepPanel.elements.push(
        _renderStep(
          `Load skill "${skillContent.input.skill}"`,
          "file-link-mindnote_outlined",
        ),
      );
      break;
    case "ToolSearch":
      // Ignore ToolSearch for now
      break;
    default:
      stepPanel.elements.push(
        _renderStep(content.name, "setting-inter_outlined"),
      );
  }
}

function _renderFooter(sessionId?: string, runResult?: RunResult): DivElement {
  const parts: string[] = [];
  if (runResult) {
    const { model, effort, usage, context_window, context_used } = runResult;
    const totalInput = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    const totalOutput = usage.output_tokens;
    const effortStr = effort ? ` · effort: ${effort}` : "";
    // Session context consumption (how full the window is); no dollar cost —
    // clark runs on the Claude Code subscription. Mirror live-card-renderer.ts.
    let ctxStr = "";
    if (context_used != null) {
      ctxStr = ` · ctx: ${(context_used / 1000).toFixed(1)}k`;
      if (context_window && context_window > 0) {
        ctxStr += ` (${Math.round((context_used / context_window) * 100)}%)`;
      }
    }
    parts.push(`${model}${effortStr} · ↑ ${totalInput.toLocaleString()} ↓ ${totalOutput.toLocaleString()} tokens${ctxStr}`);
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

/** Create a step element (icon + text) for the collapsible panel. */
function _renderStep(text: string, iconToken: string): DivElement {
  return {
    tag: "div",
    icon: {
      tag: "standard_icon",
      token: iconToken,
      color: "grey",
    },
    text: {
      tag: "plain_text",
      text_color: "grey",
      text_size: "notation",
      content: text,
    },
  };
}

/** Max chart components per card (Feishu limit). */
const MAX_CHARTS_PER_CARD = 5;

/** Regex to match ```chart code blocks. */
const CHART_BLOCK_REGEX = /```chart\s*\n([\s\S]*?)```/g;

/**
 * Extract ```chart code blocks from markdown text and return an interleaved
 * array of MarkdownElement and ChartElement. Invalid JSON falls back to
 * a regular code block (no extraction).
 */
function _extractChartElements(
  text: string,
): Array<MarkdownElement | ChartElement> {
  const elements: Array<MarkdownElement | ChartElement> = [];
  let lastIndex = 0;
  let chartCount = 0;

  const regex = new RegExp(CHART_BLOCK_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const jsonStr = match[1]!.trim();

    // Try to parse as JSON; if invalid, skip (leave as regular code block)
    let chartSpec: Record<string, unknown>;
    try {
      chartSpec = JSON.parse(jsonStr);
    } catch {
      continue;
    }

    // Respect Feishu's max chart limit
    if (chartCount >= MAX_CHARTS_PER_CARD) {
      continue;
    }

    // Push preceding text as MarkdownElement (if non-empty)
    const preceding = text.slice(lastIndex, match.index).trim();
    if (preceding) {
      elements.push({ tag: "markdown", content: preceding });
    }

    // Push chart element
    elements.push({
      tag: "chart",
      chart_spec: chartSpec,
      aspect_ratio: "16:9",
      color_theme: "brand",
      preview: true,
    });
    chartCount++;
    lastIndex = match.index + match[0].length;
  }

  // Push remaining text after last chart (or entire text if no charts found)
  const remaining = text.slice(lastIndex).trim();
  if (remaining) {
    elements.push({ tag: "markdown", content: remaining });
  }

  return elements;
}

/**
 * Regex pattern for matching markdown tables.
 * Matches: header row, separator row, and one or more data rows.
 */
const MARKDOWN_TABLE_REGEX =
  /^\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+/gm;

/**
 * Split markdown into chunks that each stay under a byte-size limit.
 * Splits at paragraph boundaries (double newline), falling back to
 * single newlines, then hard-cuts if a single paragraph exceeds the limit.
 */
export function splitMarkdownBySize(
  markdown: string,
  maxBytes: number = 12_000,
): string[] {
  if (Buffer.byteLength(markdown, "utf-8") <= maxBytes) {
    return [markdown];
  }

  const paragraphs = markdown.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;
    if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (Buffer.byteLength(para, "utf-8") <= maxBytes) {
        current = para;
      } else {
        // Single paragraph exceeds limit — hard-split by lines
        const lines = para.split("\n");
        current = "";
        for (const line of lines) {
          const c = current ? current + "\n" + line : line;
          if (Buffer.byteLength(c, "utf-8") <= maxBytes) {
            current = c;
          } else {
            if (current) chunks.push(current);
            current = line;
          }
        }
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Split markdown content into multiple chunks, each containing at most a specified
 * number of tables. Used to work around Feishu's limit of 5 table components per card.
 *
 * @param markdown - The markdown content to split.
 * @param maxTables - Maximum number of tables per chunk (default: 5).
 * @returns Array of markdown strings, each with at most maxTables tables.
 */
export function splitMarkdownByTables(
  markdown: string,
  maxTables: number = 5,
): string[] {
  const tables = markdown.match(MARKDOWN_TABLE_REGEX);
  if (!tables || tables.length <= maxTables) {
    return [markdown];
  }

  // Find all table positions in the markdown
  const tablePositions: Array<{ start: number; end: number; match: string }> =
    [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(MARKDOWN_TABLE_REGEX.source, "gm");
  while ((match = regex.exec(markdown)) !== null) {
    tablePositions.push({
      start: match.index,
      end: match.index + match[0].length,
      match: match[0],
    });
  }

  const chunks: string[] = [];
  let currentChunkStart = 0;
  let tablesInCurrentChunk = 0;

  for (let i = 0; i < tablePositions.length; i++) {
    const tablePos = tablePositions[i]!;
    tablesInCurrentChunk++;

    // If we've reached the max tables for this chunk, split here
    if (tablesInCurrentChunk >= maxTables && i < tablePositions.length - 1) {
      // End current chunk after this table
      const chunkEnd = tablePos.end;
      chunks.push(markdown.slice(currentChunkStart, chunkEnd).trim());

      // Start new chunk from the content after the current table
      currentChunkStart = chunkEnd;
      tablesInCurrentChunk = 0;
    }
  }

  // Add the remaining content as the last chunk
  const remainingContent = markdown.slice(currentChunkStart).trim();
  if (remainingContent) {
    chunks.push(remainingContent);
  }

  return chunks;
}
