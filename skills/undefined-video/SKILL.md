---
name: undefined-video
description: >
  Episode video production workflow driven by uvid (pi-undefined-video).
  Given an episode directory with script.md + raw media, produce draft.json,
  timeline, RPG-style subtitles, and a final cut. Use when the user mentions
  uvid, draft.json, RPG dialog/subtitles, pi-undefined-video, or asks to
  prep/draft/lock/finish/deliver a multi-source talking-head or screen-capture
  episode under a date/episode folder.
---

# undefined-video

## 调用契约

**uvid = policy-free 机制层**：每条命令是「工件 → 工件」filter，无隐藏路径、无内置工作流默认。  
**本 skill = 策略层**：目录布局、响度目标、字幕样式、包资源路径都写在这里，由调用者显式组装参数。

两条等价通道（同一份 `src/spec.ts`，行为不漂移）：

1. **pi 工具（优先）**：`uvid_<stage>_<action>`，参数 camelCase（`input` / `draft` / `voiceDir` …）
2. **CLI 回退**：`uvid <stage> <action> --kebab-case …`（`input`/`output` 有 `-i`/`-o`）  
   仅在工具未注册时使用；命令名与参数以 `uvid flow` / `uvid <cmd> --help` 为准。

规则：

- **路径相对 episode 工作目录或绝对路径**，不要假设 monorepo / 仓库根
- 不要 `cd` 进包目录再跑命令；cwd 保持用户工程根或 episode 上级均可，参数写清即可
- 工具未注册：安装本包后新开 session（`pi install git:github.com/xifan2333/pi-undefined-video` 或本地路径），或走 CLI
- ASR 用环境转写工具（如 `transcribe_media`），不是 uvid；hyperframes / mpv / ffmpeg 抽查可用 shell

### 包根与内置资源（安装位置无关）

本 skill 位于包内 `skills/undefined-video/`。包根 `<pkg>` 始终是 **skill 目录的上两级**：

```text
<pkg>/
├── assets/          # avatar、sfx、speaker sprite、css …
├── schemas/         # draft.schema.json
├── skills/undefined-video/   ← 本文件
├── extensions/
└── src/
```

解析：

```text
SKILL.md 所在目录 = …/skills/undefined-video
<pkg>              = …/skills/undefined-video/../..
```

无论包在 monorepo（`…/packages/undefined-video`）、user npm（`~/.pi/agent/npm/node_modules/pi-undefined-video`）还是 project npm（`.pi/npm/node_modules/…`），相对关系相同。

**需要包内文件时，用绝对路径或相对 cwd 的真实路径指向 `<pkg>/…`，禁止写死 `packages/undefined-video/...`。**

常用内置资源：

| 用途 | 路径 |
|---|---|
| outro 头像 | `<pkg>/assets/avator.png` |
| dialog sprite | `<pkg>/assets/speaker-sprite-data.js` |
| intro/toc/outro sfx | `<pkg>/assets/intro.mp3` / `toc.mp3` / `outro.mp3` |
| draft schema | `<pkg>/schemas/draft.schema.json`（`uvid_draft_init` 会自动写入 `$schema`） |

### 管道拓扑（`uvid flow` 可随时重打）

```text
raw ─prep normalize→ clips ─ASR(外部)→ asr.json
  ─draft survey/init→ 报告 + draft.json 骨架
  ─【剪辑师写决策】→ draft.json ─draft check→ src-NN.wav + summary
  ─【审片人 Lock】→ ─finish *→ timeline.json/ass/bgm ─deliver *→ otio/final.mp4
```

工具名速查：Prep `uvid_prep_{loudness,normalize,waveform}`；Draft `uvid_draft_{survey,init,check,evidence,cutpoints,premix,splices,subtitles,validate}`；Finish `uvid_finish_{plan,scene,dialog,timeline,subtitle,bgm}`；Deliver `uvid_deliver_{otio,render}`；自述 `uvid_flow`。

---

## 岗位分工（剪辑组）

| 岗位 | 谁 | 职责 |
|---|---|---|
| 审片人 | 用户 | 听/看确认，决定能否进入下一阶段 |
| 剪辑师 | Skill / Agent | 读台本与证据，做取舍，写 `draft.json`，组织后续阶段 |
| 助理剪辑 AE | `uvid_*` 工具 | 入库整理、响度、转写缓存、证据报告、人声轨、校验、渲染 |
| 工程文件 | episode 目录 | 保存可继续改的状态 |

原则：

- 剪辑师做创作判断，AE 做工程执行，审片人做门禁确认
- 默认交付是可继续改的工程状态，不是一上来就 final.mp4
- 上游没锁定前，不进入下游包装/交付

## 总流程

```text
Prep → Draft → Lock → Finish → Deliver
```

| 阶段 | 主要负责 | 产物 |
|---|---|---|
| Prep | AE | `clips/NN.*`、`.uvid-cache/asr/` |
| Draft | 剪辑师 + AE | `draft.json`、`clips/src-NN.wav`、证据 |
| Lock | 审片人 | 明确通过，ranges 锁定 |
| Finish | AE + 剪辑师 | 场景、timeline、字幕、BGM |
| Deliver | AE | `timeline.otio`、`final.mp4` |

Draft 内：

```text
survey（出报告）→ init（骨架）→ decide（只写决策）→ check（一键回验）
```

## Episode 目录

以下路径均相对 **episode 目录**（日期夹、期号夹均可，下称 `<ep>`）。  
调用工具时写成 `<ep>/...` 或绝对路径。示例里的 `20260709` 只是占位，**按实际目录名替换**。

```text
<ep>/
├── script.md
├── draft.json
├── timeline.json
├── timeline.otio
├── subtitles.ass
├── final.mp4
├── bgm.mml
├── raw/
├── clips/
└── .uvid-cache/
```

### script.md 约定

- frontmatter：`title` / `theme` / `fps` / `size`
- H1 = 视频标题；H2 = 章节（进 TOC）
- `<video src>` / `<audio src>` 写 **raw** 路径；基名 = source id
- 只处理 script 引用到的 raw

## 第 1 步：Prep

详见 `references/prep.md`。

AE：

1. 从 script 收集 `raw/NN`
2. 对每个源调用 **`uvid_prep_normalize`** → `clips/NN.mp4`（人声 `lufs=-16, tp=-1.5, lra=11`）
3. 对每个 `clips/NN.*` 做 ASR → `.uvid-cache/asr/NN.json`（`transcribe_media` **同步**等结果；全部成功后再进 Draft）
4. 可选 **`uvid_prep_loudness`** 抽查

完成后再进入 Draft。

## 第 2 步：Draft

详见 `references/draft.md`（含 survey 流程 + 最小 draft.json）。

```text
survey → init → decide → check →（可选 refine）
```

1. **survey**（写 draft 之前，不需要 draft.json）  
   - `uvid_draft_survey`：`script` + `clipsDir` + `asrDir` → `.uvid-cache/draft-survey/`  
   - 读 `summary.json` / `survey-NN.json`；**video 必看** `contact-sheet-*-survey-original.png`（句尾/+0.5s/+1s/+2s）  
2. **init**（AE 生成骨架）  
   - `uvid_draft_init`：sources/entries 自动灌入，ranges 留空；不要手抄 ASR  
3. **decide**（剪辑师只写决策）  
   - 在骨架上标 word `cut`、写 ranges 的 in/out/smoothing/reason、correctedText  
   - 派生字段（durationMs/sourceLocal*）不用写，check 自动补  
   - **`kind=video`：sourceEndMs 跟画面完成态，不跟字幕 endMs**  
4. **check**（AE 一键回验）  
   - `uvid_draft_check`：validate+premix+splices+subtitles → 读 `summary.json` 的 `actionNeeded`  
   - 改完某源后 `source: NN` 增量回验；`evidence: true` 顺带出 video contact sheet  
5. **可选 refine**  
   - `uvid_draft_cutpoints` / 单独 `uvid_draft_evidence` 只做复核，不是第一次出证据  

## 第 3 步：Lock

详见 `references/lock.md`。

- 听全部 `clips/src-*.wav`
- 看 video 的 draft-evidence 原图 contact sheet（重点：操作结果是否出齐、splice 是否跳状态）
- 若「听着干净但画面没讲完」→ 打回改 ranges，不要进 Finish
- 审片人明确通过后才 Finish

## 第 4 步：Finish

详见 `references/finish.md`。

- **`uvid_finish_plan`（先跑）**：从 script 列出 TOC id / 必填 clip 清单，不要猜 toc-NN  
- `uvid_finish_scene` / 串行 hyperframes 渲染  
- `uvid_finish_dialog`（sprite 用 `<pkg>/assets/…`）  
- **`uvid_finish_bgm`（必需）**：先写最小 `bgm.mml` → `clips/bgm.mp3`  
- `uvid_finish_timeline`（**必须带 `bgm`**；sfx 用包内 assets）  
- `uvid_finish_subtitle`  

没有 BGM 不算 Finish 完成。`bgm.mml` 必须是 `S1: ...` 键值行，不能写裸 `S1 o4`。  
**BGM 只铺在 intro 结束 → outro 开始**（片头片尾不铺），timeline 自动处理。

## 第 5 步：Deliver

详见 `references/deliver.md`。

- `uvid_deliver_otio`
- `uvid_deliver_render`（可选烧录 ASS）

## 阶段进度

| 阶段 | 文档 |
|---|---|
| Prep | `references/prep.md` |
| Draft | `references/draft.md` |
| Lock | `references/lock.md` |
| Finish | `references/finish.md` |
| Deliver | `references/deliver.md` |
