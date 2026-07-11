---
name: undefined-video
description: >
  Episode video production workflow driven by uvid (pi-undefined-video).
  Given an episode directory with script.md + raw media, produce draft.json,
  timeline, RPG-style subtitles, and a final cut. Use when the user mentions
  uvid, draft.json, RPG dialog/subtitles, pi-undefined-video, 期视频, 这一期,
  剪辑, 成片, 台本, 人声轨, 锁轨, 包装, or asks to prep/draft/lock/finish/deliver
  a multi-source talking-head or screen-capture episode under a date/episode
  folder. Prefer this over generic video skills when the project already uses
  the uvid episode layout (script.md + raw/ + clips/).
---

# undefined-video

把一期 `script.md + raw/` 做成可继续改的工程，再按需出成片。

**AI 只创作三份文件**，其余全是工具执行或机械落地：

| # | 创作物 | 是什么 | Contract |
|---|---|---|---|
| 1 | `script.md` | 台本：章节、媒体引用、口播/正文 | `references/script.md` |
| 2 | `draft.json` 里的决策 | 保留哪些话、切点、word cut | `references/draft.md` |
| 3 | `bgm.mml` | 片中 BGM 编曲 | `references/bgm.md` |

**不是创作**：normalize、ASR、survey/init/check、plan、场景目录、render、dialog 图、timeline、ass、otio、final——按 reference 里的参数调用工具即可。audio 章 md = 从台本剥标签，不是新写正文。

**uvid** = 工件 → 工件 filter。调用 `uvid_*` 时显式传参。路径相对 episode 或绝对路径。ASR 用环境转写；hyperframes / mpv 用 shell。

## 正确主链

```text
写 script.md
  → Prep（工具）→ Draft：读证据 → 写 draft 决策 → check（工具）
  → Lock（人）→ 写 bgm.mml + Finish 工具链 → Deliver（工具）
```

```text
raw ─normalize→ clips ─ASR→ asr.json
  ─survey → init → 【写 ranges/cut】→ check→ src-NN.wav
  ─lock→ plan → scenes/render/dialog → 【写 bgm.mml】→ bgm.mp3 → timeline → ass
  ─otio / final.mp4
```

| 阶段 | 人/AI 创作？ | 做什么 | 详文 |
|---|---|---|---|
| Script | **写** `script.md` | 台本一次写对 | `references/script.md` |
| Prep | 否 | 每源 normalize + 字级 ASR | `references/prep.md` |
| Draft | **写** draft 决策 | survey/init → 一次写满 ranges/cut → check | `references/draft.md` |
| Lock | 审片人 | 听 `src-*.wav` + 看 evidence → 明确通过 | `references/lock.md` |
| Finish | **写** `bgm.mml`；其余工具 | plan 清单落地 + 编曲导出 + timeline/ass | `references/finish.md`、`bgm.md` |
| Deliver | 否 | otio；需要时 final | `references/deliver.md` |

上游完成态未达成，不进下游。

## 从磁盘选阶段

| 磁盘状态 | 进入 |
|---|---|
| 无 `script.md` 或台本不对 | 写/改台本 |
| 有 script+raw，缺 clips 或 asr | Prep |
| clips+asr 齐，缺 draft 决策 | Draft（写决策） |
| 有决策，check 未过 / 缺 `src-*.wav` | 按 draft Contract 改决策 → check |
| premix 齐，未 lock | Lock |
| 已 lock，缺 bgm/timeline/ass | Finish（先写 bgm，再跑工具链） |
| 有 timeline，要 OTIO/成片 | Deliver |

## Episode 布局

```text
<ep>/
├── script.md      ← 创作 1
├── draft.json     ← 创作 2（决策写在这；骨架/派生字段工具填）
├── bgm.mml        ← 创作 3
├── timeline.json
├── timeline.otio
├── subtitles.ass
├── final.mp4
├── raw/
├── clips/
└── .uvid-cache/
```

## 包资源

`<pkg>` = 本 skill 目录上两级（`skills/undefined-video/../..`）。

| 用途 | 路径 |
|---|---|
| outro 头像 | `<pkg>/assets/avator.png` |
| dialog sprite | `<pkg>/assets/speaker-sprite-data.js` |
| intro/toc/outro sfx | `<pkg>/assets/intro.mp3` 等 |

## 三份创作物怎么写对

写之前读对应 Contract；**一次写成正确形状**；值来自内容判断 / survey / 音乐意图，**不来自报错试探**。写完再用工具验收或导出。

1. **台本** — `references/script.md`：`fps` 必填；`##` 进 TOC；媒体 `raw/NN.ext`  
2. **draft 决策** — `references/draft.md`：只写 range 的 in/out 与 word cut；派生字段交给 check；video out = 画面完成态  
3. **BGM** — `references/bgm.md`：`title/tempo/S1/S2/TR` 键值行；再 `uvid_finish_bgm`  

## 工具阶段怎么做对（不创作）

进阶段读全文，按参数调用，不临场发明清单：

- **Prep** — normalize（`-16`/`-1.5`/`11`）→ 字级 ASR  
- **Draft 工具侧** — survey → init →（你写决策）→ check  
- **Lock** — 听看包齐 → 等明确通过  
- **Finish 工具侧** — plan **原样**落地场景/render/dialog →（你写 bgm）→ timeline → ass  
- **Deliver** — otio；要成片再 render  

## 短禁区

1. 不要把 plan/scene/ass/md 提取当成「创作」——照抄或剥标签  
2. 章节 TOC 用 `##`  
3. video `sourceEndMs` = 画面完成态  
4. range 不手写 `durationMs` / `sourceLocal*` / `subtitles`  
5. Lock 通过后再 Finish  
6. hyperframes 一次渲染一个场景  
7. 包路径用 `<pkg>/…`  
