# Prep：入库与整理

岗位：主要是 **助理剪辑 AE**；剪辑师确认素材清单与章节对应。

路径：工具参数写 `<ep>/...` 或绝对路径（示例用 `20260709` 作占位）。  
**优先用已注册的 `uvid_*` 工具**，不要 shell 去找 monorepo 里的 `src/cli.ts`。

## 1. 收集本期素材清单

只处理 `script.md` 里 `<video src>` / `<audio src>` 引用的文件。

```html
<audio src="raw/01.mp4"></audio>
<video src="raw/02.mp4"></video>
```

- 基名 `NN` = source id
- `raw/` 未引用文件跳过

## 2. 响度归一化（AE）

人声目标：`I=-16 LUFS`，`TP=-1.5 dBTP`，`LRA=11`。

对每个引用调用 **`uvid_prep_normalize`**：

```text
input:  20260709/raw/01.mp4
output: 20260709/clips/01.mp4
lufs:   -16
tp:     -1.5
lra:    11
```

输出基名与 raw 一致。循环所有 script 引用。

可选抽查 **`uvid_prep_loudness`**：

```text
input: 20260709/clips/01.mp4
```

从这一步起，ASR / draft / 人声轨都用 `clips/NN.*`，不再碰 `raw/`。

## 3. ASR 字级转写（AE）

对每个 `clips/NN.*` 用环境转写工具（如 `transcribe_media`），**同步等待结果**：

```text
input:   20260709/clips/01.mp4
formats: ["json", "srt"]     ← 必须含 json（字级时间戳）
output:  20260709/.uvid-cache/asr/01
```

工具会阻塞到该文件转写完成并返回写出路径；多源就每个文件各调一次，**全部成功返回后再进 Draft**。不要用 `background`，不要 status 忙等。

产物契约（survey/init 消费的就是这个形态）：

```text
.uvid-cache/asr/NN.json = [{ text, startMs, endMs, words: [{ text, startMs, endMs }] }]
```

- 只出了 `.srt` 没有 `.json` = 这一步没完成，后面 survey 会空转
- 不要转写 intro/toc/outro/bgm

## 4. 核对

```text
script 引用数 = clips/NN.* = .uvid-cache/asr/NN.json
```

缺失则停在 Prep。

## 5. 本阶段不做

- 不写最终 draft 决策
- 不生成 `src-NN.wav`
- 不渲染场景 / timeline / final
