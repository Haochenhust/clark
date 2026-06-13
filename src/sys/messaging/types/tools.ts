import { z } from "zod";

import { ToolUseMessageContent } from "./contents";

export const BashToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Bash"),
  input: z.object({
    command: z.string(),
    description: z.string().optional(),
  }),
});
export interface BashToolUseMessageContent extends z.infer<typeof BashToolUseMessageContent> {}

export const EditToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Edit"),
  input: z.object({
    file_path: z.string(),
  }),
});
export interface EditToolUseMessageContent extends z.infer<typeof EditToolUseMessageContent> {}

export const GlobToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Glob"),
  input: z.object({
    pattern: z.string(),
  }),
});
export interface GlobToolUseMessageContent extends z.infer<typeof GlobToolUseMessageContent> {}

export const GrepToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Grep"),
  input: z.object({
    pattern: z.string(),
    glob: z.string(),
  }),
});
export interface GrepToolUseMessageContent extends z.infer<typeof GrepToolUseMessageContent> {}

export const ReadToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Read"),
  input: z.object({
    file_path: z.string(),
  }),
});
export interface ReadToolUseMessageContent extends z.infer<typeof ReadToolUseMessageContent> {}

export const SkillToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Skill"),
  input: z.object({
    skill: z.string(),
  }),
});
export interface SkillToolUseMessageContent extends z.infer<typeof SkillToolUseMessageContent> {}

export const TaskToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Task"),
  input: z.object({
    description: z.string(),
    prompt: z.string(),
    subagent_type: z.string(),
  }),
});
export interface TaskToolUseMessageContent extends z.infer<typeof TaskToolUseMessageContent> {}

export const ToolSearchToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("ToolSearch"),
  input: z.object({
    query: z.string(),
  }),
});
export interface ToolSearchToolUseMessageContent extends z.infer<typeof ToolSearchToolUseMessageContent> {}

export const WebFetchToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("WebFetch"),
  input: z.object({
    url: z.string(),
    prompt: z.string().optional(),
  }),
});
export interface WebFetchToolUseMessageContent extends z.infer<typeof WebFetchToolUseMessageContent> {}

export const WebSearchToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("WebSearch"),
  input: z.object({
    query: z.string(),
  }),
});
export interface WebSearchToolUseMessageContent extends z.infer<typeof WebSearchToolUseMessageContent> {}

export const WriteToolUseMessageContent = ToolUseMessageContent.extend({
  name: z.literal("Write"),
  input: z.object({
    file_path: z.string(),
    content: z.string(),
  }),
});
export interface WriteToolUseMessageContent extends z.infer<typeof WriteToolUseMessageContent> {}
