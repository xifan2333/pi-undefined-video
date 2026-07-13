---
name: undefined-video
description: >
  Episode video production with pi-undefined-video (uvid). Use for script, prep,
  edit, compile, and deliver of an episode. Trigger on uvid, undefined-video,
  episode, 期视频, 剪辑, 成片, script.md, edit.json, timeline.json, raw,
  normalize, ASR, generate timeline/video/captions.
---

# undefined-video

## 流程总览

```text
script.md → Prep → edit.json → Compile → 成品
  创作1       工具       创作2       工具
```

| 阶段 | 产物 | 谁做 | 参考 |
|---|---|---|---|
| Script | `script.md` | 人/AI 创作 | `references/script.md` |
| Prep | `cache/<id>/` 下 normalized + ASR + 静态画面 | 工具链 | `references/prep.md` |
| Edit | `edit.json`（稀疏编辑意图） | 人/AI 创作 | `references/edit.md` |
| Compile | `timeline.json` → `final.mp4` / `.ass` / `.otio` | 工具链 | — |

上游完成态未达成，不进下游。

## 目录布局

```text
<episode>/
├── script.md
├── edit.json
├── raw/                   # 原始录制素材
├── cache/<id>/            # 每个源一份：normalized + asr + visual
├── clips/                 # 后续 timeline/deliver 素材池
└── timeline.*.json        # 编译产物
```

## 三份创作物

| # | 文件 | 说明 | Contract |
|---|---|---|---|
| 1 | `script.md` | 台本：章节、媒体引用、口播正文 | `references/script.md` |
| 2 | `edit.json` | 稀疏编辑决策 | `references/edit.md` |
| 3 | `bgm.mml` | 片内 BGM 编曲 | `references/bgm.md` |

## 工具侧原则

- `analyze` 族：只读证据，产出 JSON
- `generate` 族：产出媒体/文件，一次一物
- ASR 不在本包：用 `transcribe_media`
- 不发明并行格式：只用 `edit.json` + `timeline.json`
- 管道组合：`uvid analyze waveform -i a.mp4 | uvid analyze silence -o silence.json`
