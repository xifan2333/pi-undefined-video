# Lock：人声与画面锁定

前置：Draft apply 完成。  
目标：审片人确认可通过；之后默认不改 ranges。

**uvid 相关用 `uvid_*` 工具**；听看用 mpv / xdg-open（shell 可）。

## 岗位

| 岗位 | 工作 |
|---|---|
| AE | 备好听看材料 |
| 剪辑师 | 说明取舍与风险 |
| 审片人 | 听 + 看，明确通过或打回 |

## 审查包

1. 听：按 id 顺序 `clips/src-*.wav`  
   `mpv --no-video --really-quiet <ep>/clips/src-01.wav ...`  
   需要单文件可 concat 到 `.uvid-cache/preview/preview-voice.wav`
2. 看（video）：`<ep>/.uvid-cache/draft-evidence/**/contact-sheet-*-original.png`  
   有视觉模型先审，再 xdg-open；原图不缩放  
   **必问**：每个 range out 是否还能看懂操作结果？splice 是否跳字/跳窗？  
   人声干净但画面被砍早 → **不能 lock**，打回延长 out
3. 只听不算 lock

## 通过 / 打回

- 通过：`可以` / `通过` / `继续` / `lock`
- 打回：指明 source/range/splice → 改 draft → 增量回验一条命令：

```text
uvid_draft_check   draft=<ep>/draft.json,
                   voiceDir=<ep>/clips,
                   output=<ep>/.uvid-cache/draft-check,
                   source=NN, evidence=true
```

premix/splices/subtitles/evidence 都在内，读 `summary.json` 的 `actionNeeded` 再审。

## Lock 之后

- 默认冻结会改人声轨时长的 ranges/entries cut
- 必须改 = 重开 lock，Finish 下游重做
- 仅 correctedText 可不重开 lock，但要 subtitles + 后续 ASS

## 完成标准

- 全部人声轨已听
- video evidence 已看
- 审片人明确通过  
→ Finish
