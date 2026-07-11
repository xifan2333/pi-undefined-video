# Finish：包装与合成（工具链；创作仅 BGM）

**完成态**：`plan.required.clips`、dialog、`bgm.mp3`、`src-*.wav` 齐；`timeline.json` 有字幕与 BGM 轨；`subtitles.ass` 有 events。

前置：Lock 已通过。

**本阶段 AI 只创作 `bgm.mml`** → 见 `references/bgm.md`。  
其余 = 读 plan / 剥台本 / 调工具 / 固定参数，不发明。

## 正确主链

```text
plan → 剥 audio 章 md → 建场景 → 串行渲染 → dialog
  → 【写 bgm.mml】→ bgm.mp3 → timeline → ass
```

---

## 机械约定（照做，不创作）

### plan = 清单唯一真相

```text
uvid_finish_plan
script:   20260709/script.md
clipsDir: 20260709/clips
voiceDir: 20260709/clips
output:   20260709/.uvid-cache/finish-plan.json
```

| 字段 | 用法 |
|---|---|
| `toc[].sceneParams` | **原样**作 `uvid_finish_scene` 基础，补 `theme` |
| `menuTitles` | toc 章节菜单 |
| `required.clips` | 渲染后磁盘应有的文件 |
| `status.missing` | 走完后应为空 |

TOC id 由工具按 `##` 章算好，整段复制。

### audio 章 md（从台本剥，不新写）

路径：`.uvid-cache/md/NN.md`  
内容：该 audio 章去掉媒体标签与 H1/H2，保留正文与 H3+。video 章不做。

### 场景

| type | 参数来源 | output |
|---|---|---|
| intro | `theme` | `…/scenes-src/intro` |
| outro | `theme` + `avatar: <pkg>/assets/avator.png` | `…/scenes-src/outro` |
| toc | **复制** plan `sceneParams` + `theme` | `…/scenes-src/{id}` |
| markdown | `theme` + `input: …/md/NN.md` | `…/scenes-src/screen-NN-01` |

可并行建目录；**渲染串行**，一次一个：

```bash
hyperframes render …/scenes-src/intro -o …/clips/intro.mp4
(cd …/scenes-src/screen-01-01 && hyperframes snapshot --at 2)
cp …/snapshots/frame-00-at-2.0s.png …/clips/screen-01-01.png
```

### dialog

```text
uvid_finish_dialog
output: …/.uvid-cache/dialog
theme: <theme>
speakerSprite: <pkg>/assets/speaker-sprite-data.js
fps: 25
```

四个 `rpg-*.png` → `clips/`。

### BGM（唯一创作点）

按 **`references/bgm.md`** 写 `bgm.mml`，再 `uvid_finish_bgm` → `clips/bgm.mp3`。

### timeline

输入齐后再跑：

```text
uvid_finish_timeline
script / draft / clipsDir / scenesDir / voiceDir / output: timeline.json
introSfx / tocSfx / outroSfx: <pkg>/assets/*.mp3
dialog 四图: clips/rpg-*.png
bgm: clips/bgm.mp3
```

抽查：`subtitles` > 0；**A3_BGM** intro 后→outro 前；toc 数 = plan；场景时长对齐人声。

### ASS（固定参数）

```text
uvid_finish_subtitle
input:  timeline.json
output: subtitles.ass
font: Fusion Pixel 12px M zh_hans
fontSize: 28
color: &H00BFB2AB
outlineColor: &H00342C28
pos: 315,600
```

已有人工精修 ass 则保留。

---

## 完成判据

- [ ] plan 清单、dialog、`bgm.mp3`、`src-*.wav` 齐  
- [ ] timeline 有字幕与 BGM  
- [ ] ass events > 0  

→ `references/deliver.md`
