# Lock：人声与画面锁定（人审；不创作）

**完成态**：审片人明确通过本期 ranges；默认冻结会改变人声时长的剪辑决策。

前置：Draft 完成（全量 check 通过，premix 齐；video 有 evidence）。

## 正确主链

### 1. 备齐审查包

1. **听** — 按 id 播放全部 `clips/src-*.wav`  
   `mpv --no-video --really-quiet <ep>/clips/src-01.wav …`  
2. **看（video）** —  
   `<ep>/.uvid-cache/draft-evidence/**/contact-sheet-*-original.png`  
   每个 range：out 时结果是否可读；splice 是否跳字/跳窗/半截输出  
3. 剪辑师用一两句说明取舍  

听 + 看做完，再请审片人表态。

### 2. 门禁

| 审片人 | 下一步 |
|---|---|
| `可以` / `通过` / `继续` / `lock` | → Finish |
| 指出某源/某 range | 按 Draft Contract 改该决策 → 该源 check（`evidence: true`）→ 再听再看 → 再请通过 |

```text
uvid_draft_check
  draft:    <ep>/draft.json
  voiceDir: <ep>/clips
  output:   <ep>/.uvid-cache/draft-check
  source:   NN
  evidence: true
```

### 3. Lock 之后的约定

| 变更 | 正确路径 |
|---|---|
| ranges / word cut | 重开 lock；Finish 下游重做 |
| 仅 `correctedText` | 更新 subtitles 与后续 ASS |

## 完成判据

- [ ] 全部人声轨已听  
- [ ] video evidence 已看  
- [ ] 审片人明确通过  

→ `references/finish.md`
