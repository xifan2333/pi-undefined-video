# Draft：剪辑决策

## 正确顺序（不要反了）

```text
1. survey     AE：出报告（不需要 draft.json）
2. init       AE：生成 draft.json 骨架（entries 已灌入，ranges 空）
3. decide     剪辑师：在骨架上只写决策
4. check      AE：一键回验（validate+premix+splices+subtitles）
5. evidence   可选，对已有 ranges 再做 splice/out 复核
6. Lock       审片
```

**禁止**：先凭空写满 ranges，再依赖 `cutpoints`/`evidence` 才“第一次看证据”。  
那些工具是 **写完 draft 之后的校验**；**写 draft 之前**用 `uvid_draft_survey`。

`draft.json` 是剪辑师决策文件。schema 由包随附（`<pkg>/schemas/draft.schema.json`）；  
**`uvid_draft_init` 会写入正确的 `$schema` 相对路径，手写时不要编 monorepo 路径。**  
AE 用 `uvid_draft_*`。路径示例：`20260709/...`（按实际 episode 目录替换）。

---

## 岗位

| 岗位 | 工作 |
|---|---|
| AE | survey、init、check（内含 validate/premix/splices/subtitles）、（可选）evidence |
| 剪辑师 | 读 survey 报告与 contact sheet，在骨架上写决策 |
| 审片人 | Lock 时听看确认 |

原则：剪辑师只写判断（哪句留、in/out 落哪、接缝怎么平滑）；抄写 ASR、算时长、推字幕这类机械活全部归 AE 工具。

---

## 1. survey（写 draft 之前）— `uvid_draft_survey`

**不需要 draft.json。** 输入 script + 已 Prep 的 clips + asr。

```text
工具：uvid_draft_survey
script:   20260709/script.md
clipsDir: 20260709/clips
asrDir:   20260709/.uvid-cache/asr
output:   20260709/.uvid-cache/draft-survey
```

产出：

```text
.uvid-cache/draft-survey/
  summary.json                 # 总览 + howToUse
  01/survey-01.json            # 静音、每句 ASR、句尾能量
  02/survey-02.json
  02/contact-sheet-02-survey-original.png   # video：每句 end/+0.5s/+1s/+2s 原图
  ...
```

### 剪辑师怎么读报告

1. 打开 `summary.json` 看源列表与 kind  
2. 逐个读 `survey-NN.json` 的 `entries[]`（text / startMs / endMs / silenceNearEnd）  
3. **`kind=video`**：必须看 `contact-sheet-*-survey-original.png`  
   - 同一句有 4 帧：说话结束、+0.5s、+1s、+2s  
   - **range 的 sourceEndMs 选画面结果完整的那一档**，不是默认 endMs  
4. `kind=audio`：用 silenceNearStart/End 帮 in/out 落静音  

`entries[].visualProbeMs` 列出探测点；guidance 字段有英文提示可作核对。

---

## 2. init — `uvid_draft_init`

survey 看完后，先让 AE 生成骨架，**不要从零手写 draft.json**：

```text
工具：uvid_draft_init
script:   20260709/script.md
clipsDir: 20260709/clips
asrDir:   20260709/.uvid-cache/asr
output:   20260709/draft.json
```

骨架里已经有：`$schema`、sources（path/asr/kind/durationMs）、entries（ASR 原文+词级时间戳逐字灌入）。  
剪辑师接手时 ranges 是空的——这就是留给你的全部工作。  
已有 draft.json 时不会覆盖（重建需 `force: true`，慎用，会丢掉已写决策）。

## 3. decide — 在骨架上写决策

### 双轨

| kind | 优先 |
|---|---|
| audio | 语音/ASR + 静音 |
| video | **画面完成态**；ASR 只定留哪些话 |

video 禁止默认 `sourceEndMs = 字幕 endMs`。

### 最小 draft 示例

`$schema` 以 init 写出的值为准（相对 draft 文件指向包内 schema）。下面省略真实 schema 路径：

```json
{
  "schemaVersion": 1,
  "timebase": "source",
  "sources": [
    {
      "id": "01",
      "path": "clips/01.mp4",
      "asr": ".uvid-cache/asr/01.json",
      "kind": "audio",
      "durationMs": 24466,
      "ranges": [
        {
          "id": "01.r000",
          "sourceStartMs": 12170,
          "sourceEndMs": 19250,
          "durationMs": 7080,
          "sourceLocalStartMs": 0,
          "sourceLocalEndMs": 7080,
          "in": { "snap": "manual", "reason": "有效讲解起点" },
          "out": {
            "snap": "silence_midpoint",
            "reason": "句段结束落在静音",
            "smoothing": { "type": "breath_gap", "ms": 60 }
          }
        }
      ],
      "subtitles": []
    }
  ],
  "entries": [
    {
      "id": "01.s001",
      "source": "01",
      "text": "ASR原始句（不要改这个字段）",
      "startMs": 12170,
      "endMs": 15410,
      "words": [
        { "text": "嗯", "startMs": 12170, "endMs": 12300,
          "edit": { "action": "cut", "reason": "句首语气词" } },
        { "text": "我们", "startMs": 12300, "endMs": 12500 }
      ]
    }
  ]
}
```

必记：

- entries 已由 init 灌好：**只改 `edit`/`correctedText`/words 的 `edit`，不要动 text/时间戳**
- range 只需写：`id` + `sourceStartMs`/`sourceEndMs` + `in`/`out`（snap/reason/smoothing）
- **`durationMs`/`sourceLocalStartMs`/`sourceLocalEndMs` 不用写**，check 会自动补齐
- `smoothing` 是对象不是字符串
- video 的 out `reason` 要写画面完成了什么，不能只写「话说完」

---

## 4. check — `uvid_draft_check`（一键回验）

写完决策后一次调用，代替手动串 validate→premix→splices→subtitles：

```text
工具：uvid_draft_check
draft:    20260709/draft.json
voiceDir: 20260709/clips          ← premix 落地目录（clips/ 是本 skill 的布局约定，工具不预设）
output:   20260709/.uvid-cache/draft-check
```

内部顺序：自动补派生字段 → strict validate → 每源 premix 到 `<voiceDir>/src-NN.wav` → splice 硬度分析 → 推导 subtitles → 写 `summary.json`。

**只看一个地方：`summary.json` 的 `actionNeeded`。**空 = 通过（命令退出 0）；非空 = 逐条处理：

- `no ranges[]` → 该源还没写决策
- `hard splice … (hardness N)` → 给接缝加 smoothing，或把切点移进静音
- validate/premix 报错 → 按信息修 draft

### 迭代循环（收敛条件）

```text
改 draft → check（改了哪个源就 source: NN 增量回验）→ actionNeeded 空？
最多 2-3 轮；仍不干净的接缝标 review 留给审片人，不要无限磨
```

- `source: NN` 时降为非 strict（其他源未写完不阻塞）；**进 Lock 前必须跑一次全量 check**
- `evidence: true` 可顺带出 video 源的 contact sheet（较慢，临 Lock 前跑一次即可）

单步工具（`uvid_draft_validate` / `premix` / `splices` / `subtitles`）仍在，仅在需要单独重跑某一步或排查时用；常规路径一律 `check`。

---

## 5. 可选复核 — `uvid_draft_cutpoints` / `uvid_draft_evidence`

**仅在 draft 已有 ranges 之后**，用来收紧边界：

- cutpoints：边界是否还在静音  
- evidence：已选 out/splice 的 contact sheet（check 的 `evidence: true` 已覆盖常规场景）  

这是 refine，不是第一次看世界。

---

## 完成标准

- [ ] 已跑 survey，video 已看 survey contact sheet  
- [ ] draft.json 由 init 生成，决策已写  
- [ ] **全量 `uvid_draft_check` 通过（actionNeeded 为空）**  
- [ ] video 源的 evidence contact sheet 已出（check `evidence: true` 或单独 evidence）  

→ Lock
