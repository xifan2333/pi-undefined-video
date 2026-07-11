# Script：台本（创作物 1/3）

**这是 AI 要写的三份文件之一。** 另两份：`draft` 决策、`bgm.mml`。

**完成态**：`script.md` 能被 `uvid_finish_plan` 解析出预期章节与 TOC；媒体在 `raw/NN.ext`。

## Contract

### frontmatter

```yaml
---
title: <标题>
theme: <theme 名，如 onedark>
fps: 25
---
```

| 键 | 规则 |
|---|---|
| `fps` | **必填**，正整数 |
| `title` | 可选；缺省用正文 `#` |
| `theme` | Finish 场景用；有包装时写上 |

### 结构

| 元素 | 规则 |
|---|---|
| `#` | 期标题，**不进 TOC** |
| `##` | **进 TOC** 的章名 |
| `###`+ | 正文，不进 TOC |
| `---` | 分隔媒体块；带媒体的块 = 一章 |
| 媒体 | `<audio src="raw/NN.ext">` 或 `<video src="raw/NN.ext">` |
| 基名 `NN` | = source id |

- `<video>` → draft `kind=video`（声画同切）  
- `<audio>` → `kind=audio`（人声；画面来自 markdown 场景）  
- intro/toc/outro/bgm **不要**写进台本媒体行  

### 完整示例

```markdown
---
title: 示例期
theme: onedark
fps: 25
---

# 示例期

---

## 开场讲解

<audio src="raw/01.mp4"></audio>

口播要点……

---

## 实操演示

<video src="raw/02.mp4"></video>

---

## 收尾

<audio src="raw/03.mp4"></audio>
```

## 正确写法

1. 按 Contract **一次写好**整份台本（结构 + 媒体路径 + 正文）  
2. 媒体文件已在 / 将放入 `raw/NN.ext`  
3. 需要时用 `uvid_finish_plan` 核对 TOC 是否符合预期（验收，不是边写边探）  

## 完成判据

- [ ] 有效 `fps`（及需要的 `theme`）  
- [ ] 进目录的章是 `##`  
- [ ] 每章媒体标签与 `raw/NN` 一致  
- [ ] plan 解析的 TOC/章节符合预期  

→ Prep：`references/prep.md`
