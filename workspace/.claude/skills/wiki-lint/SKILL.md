---
name: wiki-lint
description: >
  健康检查 clark 的领域知识库 (wiki/)：查矛盾、过期论断、孤页、缺交叉链接、该建未建的主题页、
  可补的数据缺口。Use when the user says "/wiki-lint", "体检知识库", "清理 wiki",
  "知识库有没有过期/矛盾", "lint the wiki".
user-invocable: true
---

# Wiki 体检 (lint)

对 `wiki/` 做一轮健康检查。慢操作，按需手动跑。协议见 `rules/wiki.md`。

## 检查项

1. **矛盾** — 不同页对同一事实说法冲突。
2. **过期** — 被更新的源/事实取代的旧论断。
3. **孤页** — `topics/`、`sources/` 里无任何入链的页。
4. **缺链** — 明显相关却没互链的页，补 `[[链接]]`。
5. **缺页** — index/正文反复提到、却没有独立页的重要概念/实体。
6. **数据缺口** — 可联网补全的空白（用 web-access skill）。
7. **index 漂移** — `index.md` 与实际文件不一致（多/少/摘要过时）。

## 产出

- 先把发现**用纯文字列给用户**（分点，标 `file:line`）。
- **无争议的纯修复**（补链接、更正 index 漂移、删确证的孤页）可直接做并回报。
- **有争议的改动**（删页、改写论断、合并页）：列出方案后**结束本回合等用户回复**确认，下一回合再动 —— 绝不用 AskUserQuestion/ExitPlanMode 等交互式工具。
- 修完先核日期（`TZ=Asia/Shanghai date '+%Y-%m-%d'`），append `wiki/log.md`：`## [<日期>] lint | <一句话总结>`。
- **只提交 wiki，且仅在有改动时**：`git add wiki && (git diff --cached --quiet -- wiki || git commit -m "wiki: lint <日期>" -- wiki)`。

## 注意

只读/改领域知识，不碰 `memory/`、`rules/`、源码。
