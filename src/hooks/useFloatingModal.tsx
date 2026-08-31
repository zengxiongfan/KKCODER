import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

export interface FloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 浮动卡片缩放方向：n/s/e/w 四边，ne/nw/se/sw 四角 */
export type FloatResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const FLOAT_RESIZE_DIRECTIONS: FloatResizeDirection[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

export function floatResizeCursor(direction: FloatResizeDirection): string {
  switch (direction) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "nw":
    case "se":
      return "nwse-resize";
  }
}

/** 按缩放方向计算新矩形：锚定对边，只做最小尺寸钳制，允许卡片超出屏幕 */
function computeResizeRect(
  start: FloatRect,
  dx: number,
  dy: number,
  direction: FloatResizeDirection,
  minWidth: number,
  minHeight: number,
): FloatRect {
  let { x, y, width, height } = start;
  if (direction.includes("e")) width = start.width + dx;
  if (direction.includes("w")) {
    width = start.width - dx;
    x = start.x + dx;
  }
  if (direction.includes("s")) height = start.height + dy;
  if (direction.includes("n")) {
    height = start.height - dy;
    y = start.y + dy;
  }
  if (width < minWidth) {
    if (direction.includes("w")) x = start.x + start.width - minWidth;
    width = minWidth;
  }
  if (height < minHeight) {
    if (direction.includes("n")) y = start.y + start.height - minHeight;
    height = minHeight;
  }
  return { x, y, width, height };
}

/** 屏幕内钳制：卡片至少保留一段可见边缘，避免完全移出屏幕后无法找回 */
function clampToViewport(rect: FloatRect, sliver: number): FloatRect {
  return {
    x: Math.max(
      sliver - rect.width,
      Math.min(rect.x, window.innerWidth - sliver),
    ),
    y: Math.max(
      sliver - rect.height,
      Math.min(rect.y, window.innerHeight - sliver),
    ),
    width: rect.width,
    height: rect.height,
  };
}

export interface UseFloatingModalOptions {
  /** localStorage 持久化 key（如 kkcoder_setting_diff_modal_rect） */
  storageKey: string;
  /** 无记忆时的初始尺寸 */
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  /** 屏幕边缘至少保留的可见像素，默认 48 */
  sliver?: number;
}

export interface UseFloatingModalResult {
  rect: FloatRect;
  isDragging: boolean;
  /** 头部按住拖动（自动忽略按钮/输入等控件内的按下） */
  startMove: (e: React.PointerEvent | React.MouseEvent) => void;
  /** 边界手柄按住缩放 */
  startResize: (
    e: React.PointerEvent | React.MouseEvent,
    direction: FloatResizeDirection,
  ) => void;
  /** 恢复默认居中尺寸 */
  resetRect: () => void;
}

/**
 * 可拖动 + 可缩放弹窗控制器（移植自 origin/main FilePreviewPanel 的 float 模式）：
 * - Pointer Events 统一处理鼠标/触控笔/触摸
 * - 八方向边界缩放 + 头部抓取移动
 * - 位置/尺寸持久化到 localStorage，重启沿用
 * - 拖动结束派发 window resize，通知 Monaco/xterm 重测
 */
export function useFloatingModal({
  storageKey,
  defaultWidth,
  defaultHeight,
  minWidth = 320,
  minHeight = 200,
  sliver = 48,
}: UseFloatingModalOptions): UseFloatingModalResult {
  const [isDragging, setIsDragging] = useState(false);

  const makeDefaultRect = useCallback((): FloatRect => {
    const w = Math.min(defaultWidth, window.innerWidth - 16);
    const h = Math.min(defaultHeight, window.innerHeight - 16);
    return {
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round((window.innerHeight - h) / 2),
      width: w,
      height: h,
    };
  }, [defaultWidth, defaultHeight]);

  const [rect, setRect] = useState<FloatRect>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as FloatRect;
        if (parsed && typeof parsed.width === "number" && parsed.width > 0) {
          return clampToViewport(parsed, sliver);
        }
      }
    } catch {
      // 存储损坏则回退默认居中
    }
    return makeDefaultRect();
  });

  const dragRef = useRef<{
    mode: "move" | "resize";
    direction?: FloatResizeDirection;
    startClientX: number;
    startClientY: number;
    startRect: FloatRect;
  } | null>(null);

  // 位置/尺寸持久化（拖动过程中同步写入）
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(rect));
    } catch {
      // 存储不可用时静默忽略
    }
  }, [rect, storageKey]);

  // 窗口尺寸变化时把弹窗钳制回可见范围
  useEffect(() => {
    const onWinResize = () => setRect((r) => clampToViewport(r, sliver));
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, [sliver]);

  const startMove = useCallback(
    (event: React.PointerEvent | React.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("button, input, textarea, select, a")) return;
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        mode: "move",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect: rect,
      };
      setIsDragging(true);
    },
    [rect],
  );

  const startResize = useCallback(
    (
      event: React.PointerEvent | React.MouseEvent,
      direction: FloatResizeDirection,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        mode: "resize",
        direction,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect: rect,
      };
      setIsDragging(true);
    },
    [rect],
  );

  useEffect(() => {
    if (!isDragging) return;

    document.body.style.userSelect = "none";
    const dragStart = dragRef.current;
    document.body.style.cursor =
      dragStart?.mode === "move"
        ? "grabbing"
        : floatResizeCursor(dragStart?.direction ?? "se");

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;
      if (drag.mode === "move") {
        // 移动不限制在屏幕内，允许卡片拖出屏幕
        setRect({
          ...drag.startRect,
          x: drag.startRect.x + dx,
          y: drag.startRect.y + dy,
        });
      } else {
        setRect(
          computeResizeRect(
            drag.startRect,
            dx,
            dy,
            drag.direction ?? "se",
            minWidth,
            minHeight,
          ),
        );
      }
    };

    const handlePointerUp = () => {
      dragRef.current = null;
      setIsDragging(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      // 通知 Monaco/xterm 重新测量适配
      window.dispatchEvent(new Event("resize"));
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
    // 兼容低版本 WebView 的 mouse 事件
    document.addEventListener("mousemove", handlePointerMove as EventListener);
    document.addEventListener("mouseup", handlePointerUp);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
      document.removeEventListener("mousemove", handlePointerMove as EventListener);
      document.removeEventListener("mouseup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging, minWidth, minHeight]);

  const resetRect = useCallback(() => {
    setRect(makeDefaultRect());
  }, [makeDefaultRect]);

  return { rect, isDragging, startMove, startResize, resetRect };
}

/** 八方向缩放手柄（渲染在弹窗内部，绝对定位） */
export const FloatModalResizeHandles: React.FC<{
  startResize: UseFloatingModalResult["startResize"];
}> = ({ startResize }) => (
  <>
    {FLOAT_RESIZE_DIRECTIONS.map((d) => (
      <div
        key={d}
        className={`float-modal-handle float-modal-handle-${d}`}
        onPointerDown={(e) => startResize(e, d)}
        title="拖拽调整大小"
      />
    ))}
  </>
);