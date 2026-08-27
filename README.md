# AgentDesk (极简 AI 终端管理器)

```text
█  █ █  █ ▄▄▄▄          █
██▀  ██▀  █    ▄▄▄▄ ▄▄▄█ ▄▄▄▄ ▄▄▄▄
█ ▀▄ █ ▀▄ █    █  █ █  █ █▀▀  █▀▀
█  █ █  █ ▀▄▄▄ ▀▄▄▀ ▀▄▄▀ ▀▄▄▄ █
```

<p align="center">
  <strong>基于 Tauri v2 + React + TypeScript 打造的高端、极简 AI 终端管理器</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-v2-24C6C1?style=flat-square&logo=tauri&logoColor=white" alt="Tauri"/>
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React"/>
  <img src="https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust"/>
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows"/>
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License"/>
</p>

---

## 📖 项目简介

**AgentDesk** 是一款专门为 AI 开发者、极客量身定制的 AI 终端辅助管理器。它无缝整合了 **Claude Code** 与 **Codex** 等新一代命令行 AI 助手，摒弃了传统终端纷杂混乱、难以管理的痛点。

通过 Tauri v2 的高性能跨语言渲染、轻量级的 SQLite 本地持久化、以及高度定制的 xterm.js 虚拟终端，AgentDesk 创造了一个集**多会话项目树管理、回收站容灾、无痕临时调试、多主题自适应、系统级通知提示**于一体的高端开发心流保护区。

---

## ✨ 核心特性

### 🤖 1. 无痕临时终端 (Incognito Temporary Terminals)
* **快捷一键创建**：点击侧边栏头部小机器人 🤖 按钮，可瞬时拉起一个无痕临时终端，直接跳过路径输入和确认弹窗，实现开箱即写。
* **独立沙盒周期**：临时终端不会被左侧边栏列表管理，也不会写入 SQLite 数据库。当在标签栏点击关闭时，会自动彻底清理内存并杀死后端 PTY 进程，真正做到“关掉即没了”。
* **自动编号命名**：依据内存中已有的临时终端数量，自动递增规范命名为 `临时终端1`、`临时终端2` 等。

### 🗑️ 2. 会话回收站机制 (Session Trash Bin)
* **右键软删除**：左侧会话支持右键软删除，删除后自动被移入“垃圾桶”容灾。
* **物理级过期自愈**：每次软件启动时，Rust 后端线程会自动清除超过 7 天的已软删除会话，保持数据库清爽。
* **回收站管理弹窗**：支持已删除会话的独立卡片化列表展示、快捷“一键恢复”还原到侧边栏、“彻底物理删除”以及“清空垃圾桶”操作。

### 📂 3. 深度项目树与双重收藏置顶
* **物理路径关联**：支持以项目文件夹（📂）为维度，对下属的多个 Claude/Codex 会话进行树状分组管理。
* **双重收藏置顶**：不仅可以收藏单个会话（Session），还能右键收藏整个项目目录。收藏的项目将自动置顶并显示黄金 ★ 标示，偏好在本地 LocalStorage 智能持久化。
* **资源管理器物理直达**：右键项目支持直接在 Windows 文件资源管理器中物理打开当前工作区目录。

### 🎨 4. 精心设计 6 套高阶白天/夜晚主题
* **主题色彩系统**：内置深蓝（星空黑）、暗紫（午夜紫）、碳黑（黄铜棕）、冰蓝（浅色晴空）、温暖香草（温润奶油黄）等 6 套极具质感的高级白天与黑夜模式主题。
* **滑块Segmented Switch**：采用苹果/iOS 风格 Elastic Spring 阻尼回弹切换动画，滑块切换时呈现果冻般的物理波动感。
* **Canvas 色域智能联动**：切换主题时，不仅前端 UI 变色，xterm.js 的底色、前景色、选区背景色，以及 ANSI 全色域（如 white、brightWhite 等）均会在免页面刷新的前提下实时重新渲染，彻底解决浅色模式下 ANSI 白底白字看不清的问题。

### 🖱️ 5. 平滑多标签页滚动与滚轮水平重定向
* **防溢出裁剪**：当标签页打开过多时，顶部 Tab 栏会自动收拢并支持横向平滑滚动，且完全隐藏了生硬的浏览器系统滚动条。
* **鼠标直观导航**：支持鼠标中键点击标签页任意位置一键关闭，支持鼠标滚轮在标签栏上下滚动时，重定向转换为平滑的横向左右水平移动，体验极其连贯。

### 📋 6. 图片直接粘贴转磁盘物理路径 (Screenshot to Path)
* **剪贴板物理转换**：在终端输入框中直接按下 `Ctrl + V` 粘贴复制的截图或图片，前端与 Rust 后端会协同穿透，自动将图片保存至操作系统的 `AppData\Local\Temp` 目录下，并自动为终端输入框填入该图片的绝对物理磁盘路径（如 `C:\Users\...\clipboard_img_178xx.png`），极大便利了 AI 的多模态读图输入。

### 📝 7. 内置 CLAUDE.md / AGENTS.md 编辑器
* **分屏预览**：状态栏右侧集成了专为 Claude Code 和 Codex 约束约定的编辑器。点击一键拉起带有毛玻璃模糊的 MdEditor 弹窗，支持“编辑/预览/左右分屏对照”三种模式。
* **键盘极客优化**：支持 Tab 键拦截并自动平铺插入 2 个空格，支持 `Ctrl + S` 静默物理写盘以及 `Esc` 极速隐退，并带有行数、字数及 dirty 状态更改指示星号 `*`。

### 🔊 8. 静默防抖回答通知与 Windows 原生托盘
* **硬件级叮咚提示音**：整合了 8 种系统提示音，在 AI 长时间运行结束并处于后台标签页时，自动绕过浏览器静音限制，调用 Windows 物理接口发出提示音。
* **原生托盘气泡通知**：在后台非活动标签页完成思考时，不仅 Tab 底部出现发光底线、侧边栏亮起黄点，系统右下角还会弹出 native 托盘通知：“AI 回答完毕，共耗时 X 秒”。

---

## 🛠️ 技术栈

* **前端 (Frontend)**
  * **核心框架**：React 18 + TypeScript + Vite
  * **终端渲染**：xterm.js (搭载 Canvas 硬件加速渲染 Addon 与自适应 Fit Addon)
  * **状态传递**：自定义事件驱动管道 (跨组件热刷新)
* **后端 (Backend)**
  * **运行环境**：Tauri v2 + Rust
  * **终端控制**：portable-pty (实现原生 PTY 交互，注入 `-NoLogo -NoProfile -ExecutionPolicy Bypass` 黄金提速放行参数)
  * **本地数据库**：SQLite (通过 rusqlite 强阻断 SQL 注入安全通道)

---

## 🚀 快速开始

### 1. 准备工作

请确保您的电脑已配置以下开发环境：
* **Node.js** (v18+) 及 npm 包管理器
* **Rust 工具链** (rustc / cargo 1.75+)
* Windows C++ 生成工具 (Tauri Windows 构建依赖)

### 2. 获取代码与安装依赖

```bash
# 克隆仓库
git clone https://github.com/zengxiongfan/KKCODER.git
cd KKCODER

# 安装前端依赖项
npm install
```

### 3. 本地开发与调试

本项目对 Vite 的调试开发端口和 HMR 热更新端口进行了系统性冲突避让（绑定为 `16888` 与 `16889` 端口，彻底解决 Hyper-V WinNAT 端口租约冲突导致的 `EACCES` 白屏报错）：

```bash
# 启动 Tauri 混合开发环境 (会自动调用 beforeDevCommand 拉起 Vite)
npm run tauri dev
```
或者，您可以直接在 Windows 下双击运行根目录下的 `启动应用.bat` 脚本，它会一键自动开启本地调试。

### 4. 生产包构建 (Production Build)

构建应用发行版（会打包为带数字签名的 `.exe` 安装程序以及绿色免安装版二进制程序）：

```bash
# 物理打包构建
npm run tauri build
```
构建出的打包成果文件将保存在 `src-tauri/target/release/bundle/nsis/` 目录下。

---

## 📂 项目结构说明

```text
KKCODER/
├── src-tauri/               # Tauri 后端 (Rust)
│   ├── capabilities/        # 安全确权配置文件 (如 allow-hide / allow-destroy)
│   ├── src/
│   │   ├── main.rs          # 后端程序入口
│   │   └── lib.rs           # SQLite 数据库升级/PTY 进程防并发锁/音效通知实现
│   └── tauri.conf.json      # Tauri 二进制打包、托盘、窗口大小配置
├── src/                     # 前端 (React + TypeScript)
│   ├── assets/              # 图标、Logo 等静态资源
│   ├── components/          # 核心交互组件
│   │   ├── Sidebar.tsx      # 项目分组/会话树/软删除/垃圾桶弹窗
│   │   ├── TerminalTab.tsx  # PTY 管道捕获/粘贴拦截/图片转路径/IME定位
│   │   ├── SettingsModal.tsx# 系统设置/6套主题Hsl注册/Windows提示音试听
│   │   └── MdEditorModal.tsx# 物理项目 CLAUDE.md / AGENTS.md 分屏编辑器
│   ├── App.tsx              # 应用顶层状态路由/Tab控制
│   └── App.css              # 全局多主题变量与现代 UI 样式
├── 启动应用.bat             # Windows 极速一键调试入口
└── README.md                # 本文档说明书
```

---

## 🤝 参与贡献

我们非常欢迎来自开源社区的任何贡献（PR / Issues）！
* 如果您发现了 Bug 或有更好的 feature 设想，请随时提交 [Issue](https://github.com/zengxiongfan/KKCODER/issues)。
* 提交 PR 前请确保运行 `npm run build` 和 `cargo check`，以保证前后端代码能 100% 成功编译通过。

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 协议开源。
