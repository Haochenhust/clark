---
name: chart
description: >
  在飞书卡片消息中生成交互式 VChart 图表。当回复中涉及数据可视化时使用——包括但不限于：
  用户说"画个图"、"可视化"、"图表"、"趋势"、"对比"、"占比"、"分布"，
  或回复中有 3 组以上数据适合图形化展示（收入对比、指标趋势、市场份额等）。
  即使用户没有明确要求图表，如果数据用图比用文字更直观，也应该加载此 skill 评估是否值得画图。
  不该用的场景：只有 1-2 个数据点、纯文字分析、表格更合适的多字段明细。
---

# Chart Skill — 飞书卡片图表

在 markdown 回复中嵌入 ` ```chart ` 代码块，clark 自动转为飞书卡片原生交互式图表（支持 tooltip、图例筛选）。

## 选图指南

根据你想表达的**信息类型**选图，而非数据形状：

| 想表达的信息 | 推荐图表 | 示例场景 |
|---|---|---|
| 不同类别的量级对比 | `bar` | 各部门销售额、多城市房价对比 |
| 随时间的变化趋势 | `line` | 股价走势、月度用户增长 |
| 趋势 + 强调累积量 | `area` | 流量变化、营收增长区间 |
| 各部分占整体的比例 | `pie` | 市场份额、预算分配 |
| 进度 / 完成率 | `pie` + `innerRadius` | KPI 完成率、项目进度 |
| 两个变量的相关性 | `scatter` | 广告投入 vs 转化率 |
| 多维度综合评分 | `radar` | 产品能力雷达、选手能力对比 |
| 同类别多组对比 | 任意 + `seriesField` | A/B 两组月度对比 |

**决策原则：**
- 对比用 bar，趋势用 line，占比用 pie — 这覆盖 80% 的场景
- 不确定时优先 bar（最通用，可读性最好）
- 数据点 ≤ 2 个不值得画图，直接文字说明

## 输出格式

~~~
```chart
{
  "type": "bar",
  "data": [{ "values": [...] }],
  "xField": "category",
  "yField": "value"
}
```
~~~

**规则：**
- JSON 必须合法，解析失败会 fallback 成普通代码块
- 单条消息最多 5 个图表
- `type` 字段必填

## 图表模板

### 柱状图 (bar)

```json
{
  "type": "bar",
  "data": [{ "values": [
    {"category": "研发", "value": 380},
    {"category": "市场", "value": 250},
    {"category": "运营", "value": 190}
  ]}],
  "xField": "category",
  "yField": "value",
  "label": { "visible": true }
}
```

### 折线图 (line)

```json
{
  "type": "line",
  "data": [{ "values": [
    {"date": "1月", "value": 100},
    {"date": "2月", "value": 120},
    {"date": "3月", "value": 90},
    {"date": "4月", "value": 150}
  ]}],
  "xField": "date",
  "yField": "value",
  "point": { "visible": true }
}
```

### 面积图 (area)

```json
{
  "type": "area",
  "data": [{ "values": [
    {"date": "1月", "value": 100},
    {"date": "2月", "value": 120},
    {"date": "3月", "value": 90}
  ]}],
  "xField": "date",
  "yField": "value"
}
```

### 饼图 (pie)

```json
{
  "type": "pie",
  "data": [{ "values": [
    {"type": "搜索", "value": 40},
    {"type": "社交", "value": 35},
    {"type": "直接", "value": 25}
  ]}],
  "valueField": "value",
  "categoryField": "type",
  "label": { "visible": true }
}
```

### 环形图 (pie + innerRadius)

```json
{
  "type": "pie",
  "data": [{ "values": [
    {"type": "完成", "value": 75},
    {"type": "剩余", "value": 25}
  ]}],
  "valueField": "value",
  "categoryField": "type",
  "innerRadius": 0.6,
  "label": { "visible": true }
}
```

### 散点图 (scatter)

```json
{
  "type": "scatter",
  "data": [{ "values": [
    {"x": 1, "y": 2, "size": 10},
    {"x": 3, "y": 5, "size": 20},
    {"x": 5, "y": 3, "size": 15}
  ]}],
  "xField": "x",
  "yField": "y",
  "sizeField": "size"
}
```

### 雷达图 (radar)

```json
{
  "type": "radar",
  "data": [{ "values": [
    {"key": "速度", "value": 80},
    {"key": "稳定性", "value": 90},
    {"key": "易用性", "value": 70},
    {"key": "功能", "value": 85},
    {"key": "文档", "value": 60}
  ]}],
  "categoryField": "key",
  "valueField": "value"
}
```

### 多系列对比（seriesField）

任何图表类型都可以用 `seriesField` 拆分为多系列：

```json
{
  "type": "bar",
  "data": [{ "values": [
    {"month": "1月", "city": "北京", "sales": 100},
    {"month": "1月", "city": "上海", "sales": 120},
    {"month": "2月", "city": "北京", "sales": 130},
    {"month": "2月", "city": "上海", "sales": 110}
  ]}],
  "xField": "month",
  "yField": "sales",
  "seriesField": "city"
}
```

## 常用配置项

| 配置 | 用法 | 说明 |
|---|---|---|
| `title` | `{ "text": "标题" }` | 图表标题 |
| `label` | `{ "visible": true }` | 数据标签（在图形上显示数值） |
| `point` | `{ "visible": true }` | 折线图数据点 |
| `legends` | `{ "visible": true }` | 图例（多系列时自动显示） |
| `seriesField` | `"字段名"` | 分组字段，实现多系列对比 |
| `stack` | `true` | 堆叠模式（bar/area） |
| `innerRadius` | `0.6` | 饼图 → 环形图 |

## 易错点

- `data` 是数组：`[{ "values": [...] }]`，不是 `{ "values": [...] }`
- 字段名必须与 data 中的 key **完全一致**（大小写敏感）
- 只能用纯 JSON，不支持 JavaScript 表达式
- 飞书移动端不支持纹理填充、圆锥渐变等高级样式
