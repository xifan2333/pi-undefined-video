# Deliver：交付（工具；不创作）

**完成态**：`timeline.otio` 已出；若要成片则 `final.mp4` 过 QC。

前置：Finish 完成。

## 正确主链

### 1. OTIO

```text
工具：uvid_deliver_otio
input:  20260709/timeline.json
output: 20260709/timeline.otio
```

### 2. 成片（用户要成片时）

```text
工具：uvid_deliver_render
input:     20260709/timeline.json
output:    20260709/final.mp4
subtitles: 20260709/subtitles.ass
workDir:   20260709/.uvid-cache/render-final
```

有人工精修 ass 时烧录精修版。

### 3. QC

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1 20260709/final.mp4
```

时长 ≈ `timeline.totalDurationMs`；有视频有音频；抽查 intro / toc / 关键 splice / outro / 字幕。

### 4. 交付集

```text
script.md  draft.json  timeline.json  timeline.otio
subtitles.ass  final.mp4(若需要)  clips/  bgm.mml
```

`.uvid-cache/` 可重建，默认不随片交付。

## 变更路径

| 变更 | 正确路径 |
|---|---|
| 只改 ASS | 改文件 → 需要时重 render |
| 改 ranges | 重开 Lock → Draft check → Finish → Deliver |

## 完成判据

- [ ] `timeline.otio` 已出  
- [ ] 若要成片：`final.mp4` 过 QC  
