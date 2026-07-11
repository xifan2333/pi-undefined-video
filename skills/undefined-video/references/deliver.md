# Deliver：交付

前置：Finish 完成。  
**用 `uvid_deliver_otio` / `uvid_deliver_render`。**

路径示例中的 `20260709` 按实际 episode 目录替换。

## 1. OTIO — `uvid_deliver_otio`

```text
input:  20260709/timeline.json
output: 20260709/timeline.otio
```

## 2. 成片（可选）— `uvid_deliver_render`

```text
input: 20260709/timeline.json
output: 20260709/final.mp4
subtitles: 20260709/subtitles.ass
workDir: 20260709/.uvid-cache/render-final
```

ASS 若已人工精修，烧录用精修版。

## 3. QC

shell 可：

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1 20260709/final.mp4
```

- 时长 ≈ timeline.totalDurationMs
- 有视频有音频
- 抽查 intro / toc / 问题 splice / outro / 字幕

可选响度记录：`uvid_prep_loudness` input=`20260709/final.mp4`（成片总响度含 BGM，不必等于 -16）。

## 4. 交付物

```text
script.md draft.json timeline.json timeline.otio
subtitles.ass final.mp4(可选) clips/ bgm.mml
```

`.uvid-cache/` 可重建，非必须交付。

## 变更

| 变更 | 动作 |
|---|---|
| 只改 ASS | 改文件 → 重 deliver render |
| 改 ranges | 重开 Lock → Draft apply → Finish → Deliver |
