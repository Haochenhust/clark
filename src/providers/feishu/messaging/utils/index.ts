/** Feishu post content element with tag. */
type PostElement =
  | { tag: "text"; text: string; un_escape?: boolean; style?: string[] }
  | { tag: "a"; text: string; href: string; style?: string[] }
  | { tag: "at"; user_id: string; user_name?: string; style?: string[] }
  | { tag: "img"; image_key: string }
  | { tag: "media"; file_key: string; image_key: string }
  | { tag: "emotion"; emoji_type: string }
  | { tag: "code_block"; language: string; text: string }
  | { tag: "hr" };

/** Feishu post (rich text) message structure. */
export interface FeishuPost {
  title?: string;
  content?: PostElement[][];
}

function _applyStyle(text: string, style?: string[]): string {
  if (!style || style.length === 0) return text;
  let result = text;
  for (const s of style) {
    switch (s) {
      case "bold":
        result = `**${result}**`;
        break;
      case "italic":
        result = `*${result}*`;
        break;
      case "underline":
        result = `<u>${result}</u>`;
        break;
      case "lineThrough":
        result = `~~${result}~~`;
        break;
      default:
        break;
    }
  }
  return result;
}

async function _elementToMarkdown(
  el: PostElement,
  downloadMessageResource: (
    file_key: string,
  ) => Promise<string>,
): Promise<string> {
  switch (el.tag) {
    case "text":
      return _applyStyle(el.text, el.style);
    case "a":
      return _applyStyle(`[${el.text}](${el.href})`, el.style);
    case "at":
      return _applyStyle(
        `@${el.user_name || el.user_id.replace(/^@_/, "")}`,
        el.style,
      );
    case "img":
      const imagePath = await downloadMessageResource(el.image_key);
      return `![image](${imagePath})`;
    case "media":
      const videoPath = await downloadMessageResource(el.file_key);
      return `[video](${videoPath})`;
    case "emotion":
      return `[emotion:${el.emoji_type}]`;
    case "code_block":
      return `\n\`\`\`${el.language}\n${el.text}\n\`\`\`\n`;
    case "hr":
      return "\n---\n";
    default:
      return "";
  }
}

/**
 * Convert Feishu post (rich text) to Markdown.
 * Supports: text, a, at, img, media, emotion, code_block, hr.
 */
export async function convertPostToMarkdown(
  post: FeishuPost,
  downloadMessageResource: (file_key: string) => Promise<string>,
): Promise<string> {
  const { title, content } = post;
  const lines: string[] = [];

  if (title) {
    lines.push(`# ${title}`);
    lines.push("");
  }

  if (!Array.isArray(content)) {
    return lines.join("\n");
  }

  for (const paragraph of content) {
    if (!Array.isArray(paragraph)) continue;
    const parts = (
      await Promise.all(
        paragraph.map((el) =>
          _elementToMarkdown(el as PostElement, downloadMessageResource),
        ),
      )
    ).filter(Boolean);
    if (parts.length > 0) {
      lines.push(parts.join(""));
    }
  }

  return lines.join("\n").trim();
}
