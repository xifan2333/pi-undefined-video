# Finish：包装与合成

前置：**Lock 已通过**。  
**uvid 用 `uvid_finish_*` / `uvid_draft_*`；hyperframes 渲染用 shell（串行）。**

路径前缀示例：`20260709/`（按实际 episode 目录替换）。  
**`<pkg>`** = 本 skill 的包根（`skills/undefined-video/../..`），见主 SKILL「包根与内置资源」。  
theme 取 script frontmatter。

## 1. 提取 markdown（audio 章节）

写入 `20260709/.uvid-cache/md/NN.md`（去媒体标签与 H1/H2，留 H3+）。  
video 章节不需要。

## 2. 先计划 — `uvid_finish_plan`（必做）

**在创建任何 toc 场景 / 跑 timeline 之前**先跑，避免猜 TOC 数量和文件名：

```text
script:   20260709/script.md
clipsDir: 20260709/clips          # 可选：标哪些 clip 已齐
voiceDir: 20260709/clips
output:   20260709/.uvid-cache/finish-plan.json
```

读返回 / `finish-plan.json`：

| 字段 | 含义 |
|---|---|
| `toc[]` | 要建的 TOC 卡；`id` 就是文件名基名（`toc-02`） |
| `toc[].sceneParams` | 直接喂给 `uvid_finish_scene` 的参数 |
| `menuTitles` | 所有带 H2 的章节标题，按顺序 |
| `required.clips` | timeline 会找的 mp4 清单 |
| `status.missing` | 还缺什么 |

### TOC 命名契约（工具硬规则，不要发明）

1. 只扫 script 里带 `<video>`/`<audio>` 的 `---` 块 → 章节
2. **有 H2** 的块 → 进 TOC；**H3 不算章节、不生成 toc**
3. TOC 文件名 = `toc-{chapterIndex}`，`chapterIndex` = 上述媒体块的 **1-based 顺序**（不是 source id 字段；在 `raw/NN` 命名习惯下常碰巧相同）
4. `chaptersJson` = 全部 menu 标题数组；`currentIndex` = 该 TOC 在 menu 列表里的 **0-based** 下标
5. 例：块顺序 01(无H2) / 02(H2) / 03(H2) / 04(H2) / 05(无H2) → 只要 `toc-02,toc-03,toc-04`，**没有 toc-01/toc-05**

短章节（比如 5s 语音）是否仍插 4s TOC：这是剪辑判断；**工具只要 H2 就会要对应 toc 文件**。不想要就去掉该块的 H2（仍可保留媒体章）。

## 3. 创建场景 — `uvid_finish_scene`

可并行创建，**不在此步渲染**。TOC 的 id / index **以 finish plan 为准**，不要手算。

intro：

```text
type: intro
theme: <theme>
output: 20260709/.uvid-cache/scenes-src/intro
```

outro：

```text
type: outro
theme: <theme>
avatar: <pkg>/assets/avator.png
output: 20260709/.uvid-cache/scenes-src/outro
```

toc（**复制 plan.toc[].sceneParams**，再补 theme / output）：

```text
type: toc
theme: <theme>
id: toc-02                 # = plan.toc[].id
duration: 4
chaptersJson: '["终端与 ls","ls 结合 grep","Cheat Sheet 补充"]'  # = plan.menuTitles
currentIndex: 0            # = plan.toc[].currentIndex
previousIndex: 0
output: 20260709/.uvid-cache/scenes-src/toc-02
```

markdown（audio 章；**不传章节标题参数**）：

```text
type: markdown
theme: <theme>
input: 20260709/.uvid-cache/md/01.md
output: 20260709/.uvid-cache/scenes-src/screen-01-01
```

## 4. 渲染（串行 shell）

```bash
hyperframes render 20260709/.uvid-cache/scenes-src/intro -o 20260709/clips/intro.mp4
# 每个 plan.toc[].id、outro 同理，一次一个

(cd 20260709/.uvid-cache/scenes-src/screen-01-01 && hyperframes snapshot --at 2)
cp 20260709/.uvid-cache/scenes-src/screen-01-01/snapshots/frame-00-at-2.0s.png \
   20260709/clips/screen-01-01.png
```

## 5. 对话框 — `uvid_finish_dialog`

```text
output: 20260709/.uvid-cache/dialog
theme: <theme>
speakerSprite: <pkg>/assets/speaker-sprite-data.js
fps: 25
```

然后 `cp` 四个 `rpg-*.png` 到 `20260709/clips/`。

## 6. BGM（必需）— `uvid_finish_bgm`

本期**必须**有 BGM，不要跳过。没有 `clips/bgm.mp3` 不要进最终 timeline 定稿。

### 6.1 最小 `bgm.mml`（整文件可直接用）

必须是 **`键: 值` 行**，通道名大写 + 冒号。不要写成裸 `S1 o4 ...`。

路径：`20260709/bgm.mml`

```text
title: episode
tempo: 140
S1: o4 l8 [ c e g > c < g e c ] x8
S2: o3 l8 [ c c g g e e c c ] x8
TR: o2 l8 [ c c g g c c g g ] x8
```

说明（小模型照做即可）：

- `title:` 用本期标题（script frontmatter / H1），不要写死项目名
- `tempo:` 可选但建议写
- `S1:` Square 主旋律，`S2:` 和声，`TR:` 低音；也可用 `NO:` 噪声鼓
- `o4` 八度，`l8` 默认音长，`c e g` 音符，`r` 休止，`>` `<` 升降八度
- `[ ... ]x8` 循环 8 次；不够长就加大 `xN` 或提高 `duration`
- 同一通道可多行，都会拼进该通道

### 6.2 铺轨规则（实现已固定）

`uvid_finish_timeline` 接到 `bgm` 后会自动铺到 **A3_BGM**：

```text
起点 = intro 结束
终点 = outro 开始
（片头、片尾不铺 BGM）
```

不要自己再手工叠一层 BGM。

### 6.3 生成 mp3

1. **duration（秒）≥ 正片时长**  
   正片 ≈ 各章人声轨秒数合计 + 各 toc 时长（通常每段 4s）  
   **不要按「片头+正片+片尾」估满全片**；铺轨本来就不含 intro/outro。  
   可先粗算，或临时建一次 timeline 读总长后再减 intro/outro 时长；定稿 timeline 必须带 `bgm`。
2. 调用 **`uvid_finish_bgm`**：

```text
input: 20260709/bgm.mml
output: 20260709/clips/bgm.mp3
duration: 90
rate: 48000
bitrate: 192
```

`duration` 宁长勿短（够盖住 intro→outro 之间即可）。固定响度由工具处理（I=-42 LUFS 等）。`*.famistudio.txt` 是中间产物，不要当交付依赖。

## 7. 主时间轴 — `uvid_finish_timeline`

先保证 draft 字幕最新，且 **`clips/bgm.mp3` 已存在**，且 **`uvid_finish_plan` 的 missing 为空**（Lock 后改过 correctedText 才需要重跑 check）：

```text
uvid_draft_check  draft: 20260709/draft.json
                  voiceDir: 20260709/clips
                  output: 20260709/.uvid-cache/draft-check
```

```text
script: 20260709/script.md
draft: 20260709/draft.json
clipsDir: 20260709/clips
scenesDir: 20260709/clips
voiceDir: 20260709/clips
output: 20260709/timeline.json
introSfx: <pkg>/assets/intro.mp3
tocSfx: <pkg>/assets/toc.mp3
outroSfx: <pkg>/assets/outro.mp3
dialogOpenArrow: 20260709/clips/rpg-open-arrow.png
dialogClosedArrow: 20260709/clips/rpg-closed-arrow.png
dialogOpenNoarrow: 20260709/clips/rpg-open-noarrow.png
dialogClosedNoarrow: 20260709/clips/rpg-closed-noarrow.png
bgm: 20260709/clips/bgm.mp3
```

`bgm` **必填**。抽查：

- `subtitles` > 0
- **A3_BGM** 有 1 条 clip：从 intro 结束后开始，到 outro 前结束
- 场景时长对齐 `src-NN.wav`
- `scenes` 里 toc 数量 = plan.toc 数量

## 8. ASS — `uvid_finish_subtitle`

```text
input: 20260709/timeline.json
output: 20260709/subtitles.ass
font: Fusion Pixel 12px M zh_hans
fontSize: 28
color: &H00BFB2AB
outlineColor: &H00342C28
pos: 315,600
```

人工改过的 ass 不要无脑覆盖。

## 完成标准

- clips 场景/dialog/**bgm.mp3**/src 齐全（以 finish plan 清单为准）
- timeline.json subtitles > 0 且 **含 BGM 轨**
- subtitles.ass events > 0  
→ Deliver
