---
name: wiki-ingest
description: >
  把一份源（uploads/ 里的文件、一个 URL、一段长文本）ingest 成 clark 知识库 (wiki/) 的页。
  Use when the user says "/wiki-ingest", "把这份文档/这个链接 ingest 进知识库",
  "学习这份资料并存进 wiki", "消化这个 PDF 进知识库", "ingest this into the wiki".
user-invocable: true
---

# Wiki Ingest

把一份源消化进 `wiki/`。比聊天里的轻量捕获允许更大的多页扇出（Karpathy 的 ingest 工作流）。协议见 `rules/wiki.md`。

## 步骤

1. **读源** — 文件用 Read（PDF 用 `pdf` skill；网页/X 用 `web-access` skill；妙记/文档用对应 lark-* skill）。
2. **对齐要点** — 用几句话把核心 takeaways 列给用户，结尾明确说「确认无误回复『继续』，我再写进知识库」，然后**结束本回合**。收到确认后在下一回合执行 3–7（飞书多轮对话，绝不用交互式工具阻塞）。
3. **写源摘要页** — `wiki/sources/<slug>.md`（frontmatter `type: source-summary`，正文开头记来源路径/URL + 日期）。
4. **更新主题页** — 把要点融进相关 `wiki/topics/*.md`（没有就建），补 `[[链接]]`。一份源可触多页。先按 `rules/wiki.md` 查重，别和已有页起兄弟。
5. **更新 index.md** — 新建/改动的页都在对应 `## 类目` 下登记（源摘要页标 `·src`）。
6. **append wiki/log.md** — 先核日期，写 `## [<日期>] ingest | <源标题>`。
7. **只提交 wiki（仅在有改动时）** — `git add wiki && (git diff --cached --quiet -- wiki || git commit -m "wiki: ingest <源标题>" -- wiki)`，并在回复开头回报动了哪几页：`📝 记进了 [[slug]], [[slug]]…`。

## 注意

- 原始文件留在 `uploads/`，**不可变**；`wiki/` 是编译层。
- 日期先 `TZ=Asia/Shanghai date '+%Y-%m-%d'` 核准。
- 只写领域知识；个人偏好/行为规则不在这。
