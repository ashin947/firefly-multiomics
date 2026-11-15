# 内置中文字体（R 出图用）

本目录需要放置一个文件：

```
resources/runtime/fonts/NotoSansSC-Regular.otf
```

R 侧 `r/common/fonts.R` 会通过 `sysfonts::font_add("DEGSans", regular = <该文件>)` 注册它，
再用 `showtext` 让 ggplot2 的中文标签正常显示（PRD R-30：Windows 默认环境出图中文不得出现方框）。

> **缺这个文件不会导致任何功能报错**：字体注册失败只会在日志里 warn，图表回退到系统字体
> （Windows 通常仍能显示中文，只是不同机器字重/字形会有差异）。
> `npm run verify:r` 会明确提示「未找到内置中文字体」，不会抛出看不懂的错误。

---

## 为什么不在仓库里

字体文件约 **16 MB**，属于二进制资源，不适合进 Git（会让 clone 变慢、diff 噪声）。
发布安装包时由构建脚本一起打包（见 `electron-builder.yml` 的 `extraResources`）。

---

## 获取方式（任选其一）

### 方式一：官方 noto-cjk 仓库（推荐）

```bash
# 目录：Sans/SubsetOTF/SC/
curl -L -o resources/runtime/fonts/NotoSansSC-Regular.otf \
  https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf
```

GitHub 访问不畅时可用镜像（内容相同）：

```bash
curl -L -o resources/runtime/fonts/NotoSansSC-Regular.otf \
  https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf
```

### 方式二：Google Fonts 的 Noto Sans SC

<https://fonts.google.com/noto/specimen/Noto+Sans+SC> → Download family，
解压后取 `NotoSansSC-Regular.otf`（或把 `NotoSansSC-Regular.ttf` 重命名后使用亦可，
`font_add()` 对 ttf/otf 都支持）。

### 方式三：从本机 Windows 字体复制（应急）

`C:\Windows\Fonts\msyh.ttc`（微软雅黑）可用，但**授权不允许随软件分发**，
仅适合本地开发调试：

```bash
cp /c/Windows/Fonts/msyh.ttc resources/runtime/fonts/NotoSansSC-Regular.otf
```

---

## 校验（下载后务必做一次）

```bash
# 1) 大小应在 15–17 MB 之间（SubsetOTF 版约 16.3 MB）
ls -l resources/runtime/fonts/NotoSansSC-Regular.otf

# 2) 计算 sha256 并记录下来（发布包应与构建机一致）
sha256sum resources/runtime/fonts/NotoSansSC-Regular.otf
#   macOS: shasum -a 256 resources/runtime/fonts/NotoSansSC-Regular.otf

# 3) 确认是有效的 OpenType/TrueType 文件（前 4 字节应为 OTTO / 0x00010000）
xxd -l 8 resources/runtime/fonts/NotoSansSC-Regular.otf
```

**SHA-256 基准值**：以官方发布页公布的值为准（本项目仓库不内置该文件的哈希，
避免不同版本的子集字体互相覆盖后校验失败）。请把构建机上算出的哈希写进发布说明，
供用户与 QA 核对。

---

## 授权

Noto Sans SC 采用 **SIL Open Font License 1.1（OFL-1.1）**，允许随软件免费分发与嵌入，
要求保留版权声明且不得单独售卖字体本身。发布时请把
`LICENSE`（OFL 全文）一并放在本目录下。
