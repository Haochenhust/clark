---
name: wiki
description: >
  从 clark 的领域知识库 (wiki/) 检索作答。Use when the user says "查知识库", "/wiki",
  "知识库里有没有…", "从知识库查…", "我们之前记过…吗", or wants an answer grounded in the
  accumulated wiki rather than a fresh web search.
user-invocable: true
---

# Wiki 检索

按 Karpathy 的 query 工作流，从 `wiki/` 回答问题。读写协议见 `rules/wiki.md`。

## 步骤

1. 读 `wiki/index.md`，按摘要定位 1–N 个相关页。
2. `Read` 这些 `wiki/topics/*.md` / `wiki/sources/*.md`；必要时顺正文里的 `[[链接]]` 钻进相关页。
3. 综合作答，**标注来源页**（如「（[[nvidia]]）」）。库里没有就直说「知识库里没有」，**不要编**。
4. 若这次答案**符合 `rules/wiki.md` 的自主归档门槛**（可复用的综合/分析，或耐久事实；拿不准就不回填），按其捕获流程**回填成新页/更新页**，并在回复开头回报 `📝 记进了 [[slug]]`。

## 注意

- 检索靠 index.md + Read，不需要向量库。
- 只读领域知识；个人偏好在 `memory/`，不在这。
