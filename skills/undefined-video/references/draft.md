# Draft：剪辑决策（创作物 2/3）

**这是 AI 要写的三份文件之一**（写在 `draft.json` 的决策字段里）。  
另两份：`script.md`、`bgm.mml`。

`init` 生成骨架；`check` 填派生字段并验收。**你写的只有 ranges 与 edit。**

**完成态**：每源 ranges（及必要 cut）形状正确；全量 check `actionNeeded` 空；`clips/src-NN.wav` 齐；video 对照过 contact sheet。

## 正确主链

```text
survey → init → 【一次写满决策】→ check → Lock
```

| 步 | 谁 | 动作 |
|---|---|---|
| survey | 工具 | 出静音/能量/四档画面 |
| init | 工具 | 骨架：sources/entries 齐，ranges 空 |
| decide | **你** | 按 Contract 写满 ranges + cut |
| check | 工具 | 派生字段 + premix + 接缝/字幕验收 |

---

## Contract（只约束你写的部分）

### range — 只许这些键

| 字段 | 规则 |
|---|---|
| `id` | `"{sourceId}.r{NNN}"`，从 `r000`，同源唯一 |
| `sourceStartMs` / `sourceEndMs` | 非负整数 ms，`start < end`，不超源时长 |
| `in` | `{ "snap", "reason" }` |
| `out` | `{ "snap", "reason", "smoothing"? }`；多 range 时上一段建议带 smoothing |

**enum**

- `snap`：`silence_midpoint` \| `zero_crossing` \| `local_min` \| `falling_tail` \| `manual`
- `smoothing.type`：`none` \| `fade` \| `crossfade` \| `breath_gap` \| `manual_review`
- `smoothing.ms`：`0..100`（默认：`breath_gap` + `60`）

### word cut

```json
"edit": { "action": "cut", "reason": "句首语气词" }
```

### 字幕纠错

写 `correctedText`；保留 ASR 的 `text` 与词级时间戳。

### 不要手写

`durationMs`、`sourceLocalStartMs`、`sourceLocalEndMs`、`sources[].subtitles` — check 填。

### 完整 range 形状

```json
{
  "id": "01.r000",
  "sourceStartMs": 12170,
  "sourceEndMs": 19250,
  "in": { "snap": "manual", "reason": "有效讲解起点" },
  "out": {
    "snap": "silence_midpoint",
    "reason": "本段讲解结束，落在静音",
    "smoothing": { "type": "breath_gap", "ms": 60 }
  }
}
```

video 的 `out.reason` 写画面结果，如 `"ls 输出已完整显示"`。

### 写纪律

1. 该源 survey 读完再写（video 必看 contact sheet）  
2. **一次写满**该源全部 ranges + 需要的 cuts  
3. 形状只来自本 Contract  

---

## 判断规则（在 Contract 内选型）

| kind | 优先证据 | out |
|---|---|---|
| audio | 有效讲解 + 静音 | 句后静音（如 `silence_midpoint`） |
| video | **画面是否完成** | contact sheet 上结果完整的一档 |

每源：

1. 标保留句 → 语气词/口误 cut → 连续讲解划 range  
2. in = 有效内容前；out = audio 静音 / video 画面完成态  
3. 段间默认 `breath_gap` 60ms  
4. 碎句能合并则合并；video 勿在仍打字的档出点  

---

## 工具参数

### survey

```text
uvid_draft_survey
script:   20260709/script.md
clipsDir: 20260709/clips
asrDir:   20260709/.uvid-cache/asr
output:   20260709/.uvid-cache/draft-survey
```

读 `summary.json`、`survey-NN.json` 的 entries；video 打开 `contact-sheet-*-survey-original.png`（句末/+0.5/+1/+2s）。

### init

```text
uvid_draft_init
script:   20260709/script.md
clipsDir: 20260709/clips
asrDir:   20260709/.uvid-cache/asr
output:   20260709/draft.json
```

### check（验收，不是创作）

```text
uvid_draft_check
draft:    20260709/draft.json
voiceDir: 20260709/clips
output:   20260709/.uvid-cache/draft-check
```

| `actionNeeded` | 动作 |
|---|---|
| 空 | 通过 → 准备 Lock |
| `hard splice …` | 改切点/breath_gap（仍按 Contract 形状）→ 再 check |
| `no ranges[]` | 该源尚未写决策 → 写满 → 再 check |

全量 check 进 Lock；临审片 video 加 `evidence: true`。增量：`source: NN`。

## 完成判据

- [ ] 决策基于 survey  
- [ ] video out 对照过 contact sheet  
- [ ] 全量 check `actionNeeded` 空  
- [ ] `clips/src-NN.wav` 齐  

→ `references/lock.md`
