---
name: prompt-optimize
description: "This skill should be used when the user sends a message starting with '/pp' or asks to optimize, improve, rewrite, sharpen, or refine a prompt or task description for Claude Code. Also trigger when the user pastes a vague idea, half-formed task, or stream-of-consciousness description and wants it turned into something Claude Code can execute well. Use this skill even if the user just says 'help me write a better prompt' or 'make this clearer for Claude'."
user-invocable: true
version: 0.5.0
effort: max
---

# Prompt Optimizer

Turn rough ideas into sharp, executable prompts for Claude Code.

Take what the user described and return a better version that Claude Code will act on precisely. Not a prompt engineering lecture — a better prompt, ready to paste and run.

## Core Principles

Ground all rewrites in **Anthropic's prompt engineering best practices** (clarity, structure, examples-over-descriptions) and **Strunk & White's Elements of Style** (omit needless words, use the active voice, be specific). These authorities form the baseline — the model already knows them deeply, so naming them activates that knowledge without restating it.

On top of that baseline, apply these additional lenses:

1. **Constraints beat freedom.** Stating what NOT to do is as important as what to do.
2. **Steps beat blobs.** Break complex tasks into numbered, sequential actions.
3. **Roles sharpen output.** For any task requiring domain expertise, assign the AI a specific role. "You are a senior security engineer with OWASP expertise reviewing this code" beats a bare instruction. A good role names the expertise, the perspective, and optionally the relevant experience. Skip only for trivial mechanical tasks (rename, format, typo fix).
4. **Proportionality.** A one-liner task gets a one-paragraph prompt. Don't over-engineer simple requests.

## The Optimization Process

### Step 1: Analyze the Raw Prompt

Parse the user's input — usually arrives as `/optimize <description>`. Read it twice: once for what they said, once for what they probably meant but didn't say.

Identify these elements:
- **Goal** — What does the user actually want the AI to do?
- **Role** — What expert identity should the AI assume? If the user didn't specify one, this is a gap you MUST fill. Infer the most effective expert role for the task.
- **Audience** — Who is the output for?
- **Format** — What output format is expected?
- **Constraints** — What boundaries or limitations exist?
- **Missing info** — What critical information was omitted?

### Step 2: Diagnose Problems

Assess how much work the prompt needs and identify specific issues:

**Already sharp** — Names specific files, has clear success criteria, scopes the work. Return with at most minor wording tweaks. Say so explicitly.

**Decent but fuzzy** — Intent is clear but details are missing. Common problems:
- Vague instructions or unclear goals
- Missing role (most common gap — always infer an expert role if the user didn't provide one)
- No output format specified
- No examples (when examples would help)
- Unclear constraints or scope
- Multiple tasks crammed into one (needs splitting)
- No success criteria or verification step

Fill gaps by inferring from project context — CLAUDE.md, directory structure, recent git history, conventions. Mark inferences as assumptions.

**Vague or ambiguous** — The intent itself is unclear. Ask 2-3 targeted clarifying questions rather than guessing. A wrong-but-polished prompt is worse than an honest "I need more info."

The key judgment: infer when confident, ask when not. Fabricating context is the worst outcome.

### Step 3: Rewrite the Prompt

Apply these techniques in priority order:

**Write like Strunk & White.** Active voice, front-loaded verbs, no throat-clearing. "Refactor the auth middleware to..." beats "I was thinking maybe we should look at the auth middleware and consider whether..."

**Name the target.** Specific file paths, function names, module boundaries. If the user said "the database code", figure out whether that means `src/db.ts`, `src/models/`, or migration scripts — and say so.

**Define "done".** The single most impactful optimization. What does the user see/run/check when complete? A passing test? A specific behavior? A file that exists?

**Set boundaries when scope is ambiguous.** "Do NOT change the public API" or "Only modify files in `src/auth/`" prevents unwanted scope creep. Only add when genuinely needed.

**Assign a role for all non-trivial tasks.** This is one of the highest-impact optimizations — a specific expert identity focuses the AI's knowledge, tone, and judgment. Craft the role by combining:
- **Domain expertise**: "senior distributed systems engineer", "technical recruiter specializing in AI/ML startups", "security auditor with OWASP expertise"
- **Perspective/experience**: "who has reviewed hundreds of resumes for startup roles", "who prioritizes pragmatic solutions over theoretical elegance"

Bad role: "You are an expert." (too generic — adds nothing)
Good role: "You are a senior career coach specializing in tech industry transitions, with deep knowledge of how AI/ML startups evaluate engineering candidates."

Skip roles only for mechanical tasks: rename a variable, fix a typo, format a file. For everything else — analysis, writing, design, review, planning — always include a role.

### Step 4: Choose the Right Format

**Simple tasks** (single action, clear scope) — one paragraph:
```
Rename the function `getCwd` to `getCurrentWorkingDirectory` in all files under src/. Update imports and references. Run the test suite afterward to verify nothing broke.
```

**Medium tasks** (multiple steps, some ambiguity) — bullets with constraints:
```
Add rate limiting to the POST /api/messages endpoint.

- Use a sliding window approach, 60 requests per minute per user
- Store counters in the existing Redis instance (connection config in src/config.ts)
- Return 429 with a Retry-After header when limit is exceeded
- Add a test case covering the rate limit trigger and the header response

Do not modify the authentication middleware or other endpoints.
```

**Complex tasks** (multi-component, architectural decisions) — structured sections, pick only what adds value:

```
# Role
[Specific expert identity: domain expertise + perspective. Required for all non-trivial tasks]

# Context
[Background info, tech stack, current state — only if non-obvious]

# Task
[Clear, specific actions. Numbered for multi-step tasks]

# Requirements
[Quality standards, style rules, format expectations]

# Constraints
[What to avoid, what NOT to change, scope boundaries]

# Verification
[How to confirm success — tests to run, behavior to check]

# Examples [optional]
[1-2 input/output pairs when the expected output is hard to describe in words]
```

Skip any section that would just restate the obvious.

### Step 5: Present the Result

Return the result in this structure:

**Analysis** — Brief diagnosis of the original prompt's issues (2-3 sentences max). Skip if the prompt was already sharp.

**Optimized prompt** — ALWAYS use a fenced code block (triple backticks). Never use XML tags like `<optimized>`. Code blocks render correctly and are easy to copy in all chat platforms including Feishu:

```
[The rewritten prompt goes here]
```

**Assumptions** — List what was inferred, so the user can correct before using:
- [What was inferred and why]

**Improvement notes** — 2-3 bullet points explaining key changes and why. Help the user learn to write better prompts over time. Skip for trivial optimizations.

**Enhancement suggestions** [optional] — If the user could provide more info to further improve the prompt, suggest what to add.

If clarifying questions are needed instead, list them clearly and skip everything else — don't guess.

## Pitfalls to Avoid

- **Forgetting the role.** The most common missed optimization. If the task involves any domain expertise (code review, writing, analysis, career advice, architecture), the prompt MUST assign the AI a specific expert identity. "帮我优化简历" without telling the AI to be a career coach is leaving quality on the table.
- **Over-structuring simple tasks.** "Fix the typo in README.md line 42" does not need Role/Context/Requirements/Constraints sections.
- **Fabricating technical context.** If the user says "add dark mode" and you don't know the frontend framework, ask — don't assume.
- **Removing the user's voice.** Optimization means clarity, not rewriting from scratch. Keep clear phrasing the user already had.
- **Adding unnecessary hedging.** "Consider implementing..." or "You might want to..." — remove these. Claude Code works best with direct instructions.
- **Template worship.** Not every prompt needs every section. The right structure is the minimum that makes the task unambiguous.

## Edge Cases

- **Multiple tasks bundled together**: Split into separate prompts, numbered, and suggest sequential execution
- **Non-coding tasks** (research, writing, analysis): Focus on clear deliverable and output format rather than file paths and test commands
- **The prompt is already excellent**: Say so honestly. "This is well-written — I'd use it as-is" is a valid output
- **Prompt for a specific AI tool** (not Claude Code): Adapt optimization to that tool's strengths — mention if certain techniques are tool-specific
