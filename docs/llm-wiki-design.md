# clark LLM Wiki — 设计文档

> 状态:设计已对齐,待施工 · 创建于 2026-06-18 · 来源:与用户的 `/grill-me` 设计拷问
> 灵感:[Karpathy, "LLM wiki"](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## 一、要解决的问题

让 clark 拥有一个**私人、复利的领域知识库(LLM wiki)**:

- 聊天中用户说「记下这个信息吧」→ clark 写进 wiki;
- 正常对话里 clark **自然地引用** wiki 内容,或用户显式指定从 wiki 检索;
- 知识不再消失在聊天记录里,而是**编译一次、持续保鲜**,每条新知识和每个好答案都让知识库更厚(复利),而不是每次现查现推(对比 RAG)。

Karpathy 的内核:LLM **拥有并维护**一个互链的 markdown wiki,`index.md` 当目录、`log.md`
当流水账;三个动作 ingest / query / lint;人负责喂源 + 提问,LLM 干所有记账活。中等规模
**不需要向量库**,`index.md` 就够检索导航。

## 二、八项决策(已对齐)

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| ① | 内容边界 | **只装领域知识,与个人记忆分层** | 「世界知识」与「你是谁/偏好」更新节奏、生命周期、加载策略都不同;混在一起会撑爆常驻上下文、扰乱 lint |
| ② | 底座 | **workspace/wiki/ 纯 markdown + git** | 唯一能支撑「可编辑互链页」的底座;git 白送历史/回滚;clark 用 Read/Write/Edit/Grep 直接操作,零新基设 |
| ③ | 消费方式 | **LLM 内部底座,聊天浮现,不同步飞书** | 用户要的是「clark 自然引用」,不是在 Obsidian 里盯着看;省掉飞书双向同步的巨大复杂度;想看时本地/Obsidian 随手开 |
| ④ | 捕获触发 | **双轨:显式「记下」必写 + 高门槛自主归档** | 只靠手动发令会漏掉大量该沉淀的知识;全自动又会滥。自主轨**纯模型内自驱,不用 hook** |
| ⑤ | 捕获粒度 | **主题页 + 当场融入(轻量)** | 复利来自「把知识融进主题页」,不是一事一文件;当场融入让「自然引用」马上能用 |
| ⑥ | 自然引用 | **index.md 常驻(@-import 进 CLAUDE.md)** | 暖管每轮重载上下文,clark 只「知道」常驻的东西;索引常驻是「自然引用」唯一能成立的方式 |
| ⑦ | 维护 | **按需 /wiki-lint,调度自动化推迟** | lint 是慢操作;自动调度得压在 clark 尚不稳的异步上,核心验稳前不上 |
| ⑧ | MVP 边界 | **核心闭环 + lint + 上传文档 ingest** | 用户选的全量 v1;ingest 价值高(常给 clark 传文件) |

### 关键约束:不能用 hook 做自动捕获

`~/.claude/rules/no-autonomous-code-changes-from-learning.md` 记录过:一个自主加的 Stop hook
导致 agent 死锁 → 飞书消息管道瘫痪。因此**自动捕获只能是模型在正常回合里自己决定写文件**
(纯 Write 调用,便宜、产生 transcript 活动、不会触发 wedge 检测),绝不引入 Stop/PreToolUse hook。

## 三、Spec 细节

### 目录结构

```
workspace/wiki/
  index.md      # 常驻目录:每页一行摘要,按类目分组(@-import 进 workspace/CLAUDE.md)
  log.md        # append-only 流水账:## [2026-06-18] capture|ingest|lint | 标题
  topics/       # 主题页(概念/实体/领域),一主题一文件,用 [[slug]] 互链
  sources/      # ingest 进来的源摘要页(原始文件仍留在 uploads/)
```

`uploads/` 里的原始文件是**不可变源**;`wiki/` 是 clark 拥有的编译层。

### 页面 frontmatter(沿用 harness 记忆节点风格,保持全局一致)

```markdown
---
name: <kebab-slug>
description: <一行摘要,进 index.md 用>
metadata:
  type: topic | entity | source-summary
  updated: 2026-06-18
---

正文。用 [[other-slug]] 做交叉链接。
```

### 捕获路由(clark 怎么决定写哪)

- 世界 / 领域知识 → `wiki/topics/`
- 个人偏好 / 画像 → `workspace/memory/memory.md`(**不进 wiki**)
- 行为纠正 / 规则 → `workspace/rules/`
- 「记下这个」**默认走 wiki**,除非明显是个人偏好

### 自主捕获门槛(双轨里的自主轨)

只在 clark 产出了以下内容时归档:

- (a) 可复用的综合 / 分析 / 判断;或
- (b) 用户正在追踪的领域实体的耐久事实。

**排除**一次性 / 闲聊 / 时效性内容。每次在回复末尾用一行回报「📝 记进了 [[X]]」,
用户一句话即可让它撤回。

### git 提交

每次写 wiki → 一次 git commit(白送历史 + 用户可 `git diff` 审计 clark 写了什么)。

### 显式检索 `/wiki <问题>`(Karpathy query 工作流)

读 `index.md` → 钻进相关页 → 带引用作答 → 好答案回填成新页。

### `/wiki-lint`(按需)

健康检查:矛盾、过期被新源取代的论断、孤页(无入链)、缺主题页的重要概念、缺交叉链接、
可联网补的数据缺口。

### `/wiki-ingest <文件|URL>`

读源 → 与用户对齐要点 → 写 `sources/` 摘要页 → 更新相关 `topics/` 页 + `index.md` →
append `log.md`。比聊天里的轻量捕获允许更大的多页扇出。

### 「自然引用」机制(命门)

`workspace/CLAUDE.md` 里加 `@wiki/index.md`,Claude Code 原生 @-import 机制每轮把目录
inline 进系统提示(`soul.md` / `memory.md` 现在就是这么常驻的,已验证可行)。clark 每回合
都看见「知识库里有哪些页」,话题一相关就 `Read` 那页并引用。模型设为 opus-4-8**[1m]**
(100 万上下文),常驻一个几千 token 的目录成本可忽略。

## 四、v1 施工计划

按风险排序施工 —— **最大未知数是「自然引用到底会不会真触发」**(行为层面、没验证过),
所以先把核心闭环跑通实测,再叠 lint + ingest:

1. **核心闭环**(先跑通 + 实测自然引用)
   - 建 `wiki/` 结构:`index.md`、`log.md`、`topics/`、`sources/`(含种子内容)
   - `workspace/CLAUDE.md` 加 `@wiki/index.md` 常驻接线
   - 写 `workspace/rules/wiki.md`:页型、frontmatter、链接语法、路由、自主门槛、
     「raw 只读 / wiki 由 clark 拥有」契约 —— 这就是 Karpathy 说的「schema 文件」
   - 双轨捕获 + 回报「📝 记进了」+ git commit
   - `/wiki` 查询 skill
   - **实测**:喂几条知识 → 隔天正常聊天,看 clark 是否真的自然引用
2. **`/wiki-lint`**(按需健康检查)
3. **`/wiki-ingest`**(上传文档 → wiki 页)

## 五、暂不做(deferred)

- 调度自动 lint(等核心验稳)
- 把 `workspace/logs/` 日常对话日志挖回 wiki
- flomo / memos 作为 ingest 源的桥(目前两者都没接进 clark 的 workspace)
- 向量 / 语义检索(index.md 在当前规模够用)

## 六、遗留事项(正交,不在本次 v1)

clark 现有**两个割裂的个人记忆库**:harness 的
`~/.claude/projects/-Users-chenhao-Desktop-Projects-clark/memory/` 与 workspace 的
`workspace/memory/memory.md`,互不连通。这跟 wiki 正交,但迟早要合并清理。先记一笔。
