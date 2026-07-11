# Prep：入库与整理（工具；不创作）

台本已按 `references/script.md` 写好。本阶段只跑工具。

**完成态**：script 每个媒体引用都有对应 `clips/NN.*` 与含 `words` 的 `.uvid-cache/asr/NN.json`。

## Contract

| 项 | 正确值 |
|---|---|
| 源列表 | `script.md` 全部 `<video src>` / `<audio src>` |
| source id | 媒体基名 `NN` |
| 响度 | `I=-16 LUFS`，`TP=-1.5 dBTP`，`LRA=11` |
| clips 路径 | `clips/NN.*`（基名与 raw 一致） |
| ASR 路径 | `.uvid-cache/asr/NN.json` |
| ASR 形状 | `[{ text, startMs, endMs, words: [{ text, startMs, endMs }] }]` |
| 不转写 | intro / toc / outro / bgm |

## 正确主链

### 1. 列源

```html
<audio src="raw/01.mp4"></audio>
<video src="raw/02.mp4"></video>
```

### 2. 归一化（每源一次）

```text
工具：uvid_prep_normalize
input:  20260709/raw/01.mp4
output: 20260709/clips/01.mp4
lufs:   -16
tp:     -1.5
lra:    11
```

之后全程用 `clips/NN.*`。

### 3. 字级 ASR（每源一次，同步完成后再下一个）

```text
input:   20260709/clips/01.mp4
formats: ["json", "srt"]
output:  20260709/.uvid-cache/asr/01
```

### 4. 对齐

```text
script 引用数 = clips/NN.* = .uvid-cache/asr/NN.json
```

台本结构本身不对时，先按 `references/script.md` 写对台本。

## 完成判据

- [ ] 每个 script 引用都有 `clips/NN.*`  
- [ ] 每个源都有含 `words` 的 `asr/NN.json`  
- [ ] 尚未进入 draft 决策 / 场景渲染  

→ `references/draft.md`
