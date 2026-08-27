# Obsidian Amber (曜琥) 极简设计系统规范
> **Universal Ultra-Minimalist Single-Theme Design Specification**
> 
> 本规范提炼自 AgentDesk 极简主义设计范式，针对通用软件界面（如 IDE、终端管理器、看板、复杂后台系统等）进行了二次升级。摒弃了冗余的多主题切换，聚焦于单套 **“曜石与琥珀 (Obsidian & Amber)”** 极致暗黑配色，提供最高层级的视觉心流与精细微交互规范。

---

## 🎨 一、 核心色彩体系 (CSS Tokens)

系统使用一组相互关联的 CSS 变量，确保对比度、层次感以及在视网膜屏幕上的极致精细度。

```css
:root {
  /* ================= 核心背景 (Backgrounds) ================= */
  --bg-main: #0c0b0a;         /* 主编辑区 / 主要工作面板 / 底板底色 (曜石深黑) */
  --bg-sidebar: #191715;      /* 侧边栏 / 浮动抽屉 / 弹窗底色 (暖炭灰) */
  --bg-terminal: #000000;     /* 虚拟终端 / 控制台 / 纯代码块 (纯黑) */
  --bg-input: #12100e;        /* 输入框 / 下拉框常规背景 (深砂褐) */

  /* ================= 文本色彩 (Typography Colors) ================= */
  --text-primary: #f5f5f4;    /* 主要文本 / 高亮文字 (石灰白，温和不刺眼) */
  --text-secondary: #a8a29e;  /* 次要文本 / 占位符 / 说明文字 (温暖石灰) */
  --text-muted: #78716c;      /* 禁用状态 / 辅助路径 / 边缘元数据 (暗砂灰) */

  /* ================= 品牌与高亮 (Accent & Brands) ================= */
  --color-primary: #d97706;        /* 焦点高亮 / 核心动作按钮 / 强调状态 (琥珀金) */
  --color-primary-hover: #b55c04;  /* 焦点悬浮态 (沉稳暗金) */
  --color-primary-mist: rgba(217, 119, 6, 0.08); /* 极淡琥珀雾 (用于悬浮底色反馈) */
  
  /* ================= 交互反馈 (Interactive States) ================= */
  --bg-hover-item: rgba(255, 255, 255, 0.04);   /* 普通列表项悬浮背景 */
  --bg-active-item: #29241e;                     /* 普通列表项选中/激活背景 (暗金褐) */
  --text-active-item: #f5f5f4;                   /* 激活项文字颜色 */

  /* ================= 边框与物理阴影 (Borders & Shadows) ================= */
  --border-color: #2c2824;      /* 全局极细分割线 / 虚线 / 边框 (青铜发丝线) */
  --border-focus: #78350f;      /* 输入框/控制件聚焦边框 (暗红铜) */
  
  /* ================= 动画与圆角 (Transitions & Radius) ================= */
  --radius-sm: 4px;             /* 按钮 / 标签页 / 小控件圆角 (极简硬朗圆角) */
  --radius-md: 6px;             /* 弹窗 / 下拉菜单 / 卡片圆角 */
  --transition-smooth: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-spring: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); /* iOS 弹簧超调 */
}
```

---

## 📐 二、 布局与排版规范 (Layout & Typography)

### 1. 物理结构约束
* **高易读、高密度**：界面应使用紧凑的扁平树状或网格结构，严禁留出大面积无意义的圆角卡片边距（No nested cards gap）。
* **高度克制规范**：
  * 控制台/状态栏按钮高度严格契合字体，垂直内边距 (Padding) 控制在 `3px` ~ `5px` 之间。
  * 文本输入框 (`input`) 垂直内边距控制在 `6px` ~ `8px`。
  * 列表单项高度控制在 `24px` ~ `30px`。

### 2. 字体与排版
* **主要 UI 字体**：优先采用系统原生无衬线字体，字重选用 `400`（常规）与 `600`（半粗体）。
  ```css
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  ```
* **等宽代码字体**：代码、命令行、日志等使用高清晰度等宽字体。
  ```css
  font-family: "Fira Code", Consolas, Monaco, monospace;
  ```

---

## ⚡ 三、 极简主义设计细节约束 (Minimalist UI Constraints)

### 1. 图标禁令 (Monochrome Iconography Only)
* **严禁在界面主要交互组件中使用彩色 Native Emoji**。
* **统一使用单色 SVG 矢量线条图标**：
  * `strokeWidth` 设定为 `2.0`（粗细适中）或 `2.5`（视网膜级硬朗）。
  * 尺寸必须限制在 `12px` 到 `14px`。
  * 样式统一采用 `stroke="currentColor"`，通过继承容器文本颜色在悬浮、激活态下自然变色，杜绝静态的杂色斑驳感。

### 2. 镂空物理隔离设计 (Retina Cutout Overlays)
当需要在头像、图标、动作按钮的边缘叠加红点、数字或状态角标（Badge）时，**禁止直接叠加覆盖**。
* **物理镂空法**：必须为 Badge 元素设置与底层背景相同的物理隔空边框，以创造精致的视网膜级物理隔离缺口。
```css
.badge-overlay {
  border: 1.5px solid var(--bg-sidebar); /* 镂空边框，色彩必须与底板容器一致 */
  transform: translate(25%, -25%);
}
```

### 3. 物理防抖 (Zero-Jitter Interaction)
禁止通过改变尺寸、字重或位置来表达状态，防止高频交互下发生排版位移（Layout Shift）。
* **字体字重守恒**：点击选中、Hover 列表项时，字重（`font-weight`）保持一致，仅通过背景色 `--bg-active-item` 和字色变化表达选中状态。
* **尺寸守恒**：交互式列表必须设定固定的高度与 `overflow-y: auto`，避免异步加载数据时容器发生瞬间伸缩。

### 4. 动效设计规范 (Micro-Animations)
* **平滑微缩放**：按钮等核心可点击项，在 `:active`（按下）时添加微缩放反馈，提升物理触感。
  ```css
  .btn-interactive:active {
    transform: scale(0.97); /* 优雅微缩水 */
  }
  ```
* **弹性滑块过渡**：切换 Tab 的滑块等横向位移使用 iOS 风格弹簧插值（Overshoot Spring），在 `0.3s` 内完成过渡，使其感觉灵动而非死板。

---

## 📝 四、 极简自我审查清单 (Audit Checklist)

在任何新功能、新组件上线或迁移时，开发人员必须进行如下“盲测审查”：

1. **[ ] 图标纯净化**：检查全局是否残留原生彩色 Emoji？是否都换成了适应当前字色的单色 `<svg>` 线条图标？
2. **[ ] 绝对色值清理**：查找 CSS 中是否存在 `#fff`、`#000` 或 `#333` 等硬编码颜色？是否都绑定到了 `--bg-main`、`--border-color` 等语义化 CSS 变量上？
3. **[ ] 按钮高度克制**：检查新增加的控制条或工具栏，按钮垂直 Padding 是否严格限制在 `3px` ~ `5px` 内？
4. **[ ] 镂空断层检查**：叠加在其他元素右上角的角标，是否使用了镂空 Gap 隔离设计？
5. **[ ] 界面物理防抖**：当快速点击、Hover、展开收起或输入内容时，界面其余不相关的 DOM 元素是否产生了高矮或左右的位置抖动？
6. **[ ] 极限弱光对比度**：在极暗弱光环境下观察，琥珀金高亮色 (`#d97706`) 与主要文字 (`#f5f5f4`) 之间的对比度是否足够清晰，次要辅助文字 (`#a8a29e`) 是否能被清晰阅读？
