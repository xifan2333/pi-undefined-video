# BGM：编曲（创作物 3/3）

**这是 AI 要写的三份文件之一。** 另两份：`script.md`、draft 决策。

你写 `<ep>/bgm.mml`；`uvid_finish_bgm` 导出 `clips/bgm.mp3`。  
timeline 把 BGM 铺在 **intro 结束 → outro 开始**（片头片尾不铺）。

**完成态**：`bgm.mml` 形状正确；`clips/bgm.mp3` 时长盖住 intro→outro 之间。

## Contract

### 文件形状（键: 值）

```text
title: <本期标题>
tempo: 140
S1: o4 l8 [ c e g > c < g e c ] x8
S2: o3 l8 [ c c g g e e c c ] x8
TR: o2 l8 [ c c g g c c g g ] x8
```

| 键 | 含义 |
|---|---|
| `title` | 曲名，常用期标题 |
| `tempo` | BPM，整数 |
| `S1` | 主旋律 |
| `S2` | 和声（可选但推荐） |
| `TR` | 低音 |
| `NO` | 鼓（可选） |

### MML 记号

| 记号 | 含义 |
|---|---|
| `o4` | 八度 |
| `l8` | 默认音长 |
| `c d e f g a b` | 音名 |
| `r` | 休止 |
| `>` `<` | 升/降八度 |
| `[ … ]xN` | 循环 N 次 |

### 时长

导出 `duration`（秒）≈ 各章人声秒数 + 各 toc 时长（常 4s），盖住 intro→outro，**宁长勿短**。不够就加大 `xN` 或 `duration`。

### 写纪律

1. 按本 Contract **一次写好**整份 mml（不要先空跑 bgm 工具探语法）  
2. 风格贴合期内容即可：循环型 8-bit/芯片感短句，能铺底  
3. 写完再调用导出工具  

## 导出（工具，非创作）

```text
uvid_finish_bgm
input:  20260709/bgm.mml
output: 20260709/clips/bgm.mp3
duration: 90
rate: 48000
bitrate: 192
```

响度由工具固定。得到 `clips/bgm.mp3` 后交给 timeline。

## 完成判据

- [ ] `bgm.mml` 含 title、tempo、至少 S1+TR  
- [ ] `clips/bgm.mp3` 存在且 duration 足够  

→ 回到 `references/finish.md` 继续 timeline / ass
