/**
 * 文件图标映射 —— 基于 CLI-Manager 同款的 @baybreezy/file-extension-icon（Material 图标主题）。
 *
 * 该库返回 base64 data URI，通过 <img> 渲染。图标为固定多色（Material 设计规范），
 * 不随 AgentDesk 主题换色 —— 这是该库的已知限制（见 README / 方案对比文档）。
 *
 * 用法：
 *   import { FileIcon } from "@/utils/fileIcons";
 *   <FileIcon name={node.name} size={14} />
 */

import React from "react";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";

/* ------------------------------------------------------------------ */
/*  类型                                                                */
/* ------------------------------------------------------------------ */

export interface FileIconProps {
  /** 文件名（含扩展名）或特殊文件名，如 "index.ts"、"package.json" */
  name: string;
  /** 图标尺寸（像素），同时设 width 和 height */
  size?: number;
  /** 额外 className */
  className?: string;
  /** 目录专用：是否展开（开/闭两种图标）。不传则按文件处理 */
  isDir?: boolean;
  /** 目录专用：是否展开。仅 isDir 为 true 时生效 */
  isOpen?: boolean;
}

/* ------------------------------------------------------------------ */
/*  工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 查询单个文件的 Material 图标 data URI；不处理目录（目录由调用方渲染） */
export function resolveFileIcon(name: string): string {
  return getMaterialFileIcon(name);
}

/** 查询目录的 Material 图标 data URI */
export function resolveFolderIcon(name: string, open = false): string {
  return getMaterialFolderIcon(name, open);
}

/* ------------------------------------------------------------------ */
/*  React 组件 —— 渲染用                                                */
/* ------------------------------------------------------------------ */

/**
 * 文件类型图标组件。
 *
 * - 文件：按扩展名 / 特殊文件名匹配 Material 图标
 * - 目录：开/闭两种图标（传 isDir + isOpen）
 *
 * 用法：
 *   <FileIcon name={node.name} size={14} />                         // 文件
 *   <FileIcon name={node.name} size={14} isDir isOpen={expanded} /> // 目录
 */
export const FileIcon: React.FC<FileIconProps> = ({
  name,
  size = 16,
  className = "",
  isDir = false,
  isOpen = false,
}) => {
  const src = isDir ? resolveFolderIcon(name, isOpen) : resolveFileIcon(name);
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={className}
      draggable={false}
      style={{ display: "block", flexShrink: 0 }}
    />
  );
};
