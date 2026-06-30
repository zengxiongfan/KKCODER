import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { 
  Folder, 
  FolderOpen, 
  FileText, 
  Search, 
  RefreshCw, 
  ChevronRight, 
  ChevronDown 
} from "lucide-react";

interface FileEntry {
  name: string;
  path: string; // Relative path
  is_dir: boolean;
  size: number;
}

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  isLoaded?: boolean; // 标记子文件夹内容是否已按需拉取
}

interface ProjectTreeProps {
  projectPath: string;
  onFileClick: (relativePath: string) => void;
  onInsertPathToTerminal: (relativePath: string) => void;
}

// 极其简单快速的剪贴板复制辅助函数
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("无法复制到剪切板:", err);
  }
};

export const ProjectTree: React.FC<ProjectTreeProps> = ({
  projectPath,
  onFileClick,
  onInsertPathToTerminal,
}) => {
  const [treeData, setTreeData] = useState<FileNode>({ name: "root", path: "", isDir: true, size: 0, children: [] });
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const expandedFoldersRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    expandedFoldersRef.current = expandedFolders;
  }, [expandedFolders]);
  
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    filePath: string;
    isDir: boolean;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // 1. 加载目录树（如果 keepExpanded 为 true，则保留已展开的文件夹状态并递归加载它们）
  const loadFiles = useCallback(async (keepExpanded = false) => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const loadDirectoryRecursive = async (relPath: string): Promise<FileNode[]> => {
        const subData = await invoke<FileEntry[]>("read_project_directory", {
          projectPath,
          relativePath: relPath
        });
        const childrenNodes: FileNode[] = [];
        for (const f of subData || []) {
          const isDir = f.is_dir;
          const nodePath = f.path;
          const shouldLoadSub = isDir && keepExpanded && expandedFoldersRef.current[nodePath];
          childrenNodes.push({
            name: f.name,
            path: nodePath,
            isDir,
            size: f.size,
            children: isDir ? (shouldLoadSub ? await loadDirectoryRecursive(nodePath) : []) : undefined,
            isLoaded: isDir ? !!shouldLoadSub : false
          });
        }
        return childrenNodes;
      };

      const rootChildren = await loadDirectoryRecursive("");
      setTreeData({ name: "root", path: "", isDir: true, size: 0, children: rootChildren });
      
      if (!keepExpanded) {
        setExpandedFolders({}); // 重置所有展开状态，初始全部默认折叠
      }
    } catch (err) {
      console.error("加载项目目录树失败:", err);
      setTreeData({ name: "root", path: "", isDir: true, size: 0, children: [] });
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    loadFiles(false);
    setSearchQuery("");
  }, [projectPath, loadFiles]);

  // 2. 异步拉取文件夹子节点（按需惰性加载）
  const handleFolderExpand = async (node: FileNode) => {
    const isCurrentlyExpanded = expandedFolders[node.path] || false;
    if (!isCurrentlyExpanded) {
      // 准备展开，如果尚未加载其子目录内容，则异步加载
      if (!node.isLoaded) {
        try {
          const subData = await invoke<FileEntry[]>("read_project_directory", {
            projectPath,
            relativePath: node.path
          });
          const subChildren = (subData || []).map(f => ({
            name: f.name,
            path: f.path,
            isDir: f.is_dir,
            size: f.size,
            children: f.is_dir ? [] : undefined,
            isLoaded: false
          }));

          setTreeData(prev => {
            const updateNodeInTree = (curr: FileNode): FileNode => {
              if (curr.path === node.path) {
                return { ...curr, children: subChildren, isLoaded: true };
              }
              if (curr.children) {
                return { ...curr, children: curr.children.map(updateNodeInTree) };
              }
              return curr;
            };
            return updateNodeInTree(prev);
          });
        } catch (err) {
          console.error(`加载文件夹子项失败: ${node.path}`, err);
        }
      }
      setExpandedFolders(prev => ({ ...prev, [node.path]: true }));
    } else {
      // 收起文件夹
      setExpandedFolders(prev => ({ ...prev, [node.path]: false }));
    }
  };

  // 3. 高性能并行文件名检索（250ms 防抖，在后台 Rust 极速递归扫描文件名）
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      invoke<FileEntry[]>("search_project_files", { 
        projectPath, 
        query: trimmed 
      })
        .then((data) => {
          setSearchResults(data || []);
        })
        .catch((err) => {
          console.error("项目文件扫描失败:", err);
          setSearchResults([]);
        })
        .finally(() => {
          setSearching(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, projectPath]);

  // 4. 将搜索出的匹配项（被熔断至最大300个）在前端重构成局部树，仅在打字完成后触发
  const searchTreeData = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const root: FileNode = { name: "root", path: "", isDir: true, size: 0, children: [] };
    
    for (const file of searchResults) {
      const parts = file.path.split("/");
      let current = root;
      let currentPath = "";
      
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const isLast = i === parts.length - 1;
        let node = current.children?.find(c => c.name === part);
        
        if (!node) {
          node = {
            name: part,
            path: currentPath,
            isDir: isLast ? file.is_dir : true,
            size: isLast ? file.size : 0,
            children: (isLast && !file.is_dir) ? undefined : [],
            isLoaded: true // 搜索树内容全量展现，无需后续懒加载
          };
          current.children?.push(node);
        }
        current = node;
      }
    }

    const sortNodes = (node: FileNode) => {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.isDir !== b.isDir) {
            return b.isDir ? -1 : 1;
          }
          return a.name.localeCompare(b.name, "zh-CN");
        });
        node.children.forEach(sortNodes);
      }
    };
    sortNodes(root);
    return root;
  }, [searchResults, searchQuery]);

  const handleContextMenu = (e: React.MouseEvent, filePath: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    
    let x = e.clientX;
    let y = e.clientY;
    
    if (x + 160 > window.innerWidth) {
      x = Math.max(0, x - 160);
    }
    
    setContextMenu({
      x,
      y,
      filePath,
      isDir
    });
  };

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  // 递归树节点渲染器
  const renderNode = (node: FileNode, depth = 0) => {
    if (node.name === "root") {
      return (
        <div className="project-tree-root">
          {node.children?.map(child => renderNode(child, depth))}
        </div>
      );
    }

    const relativePath = node.path;
    const isExpanded = expandedFolders[relativePath] || false;
    const paddingLeft = `${depth * 14 + 10}px`;

    // 搜索模式下默认全部展开以供匹配结果一目了然，非搜索模式根据 expandedFolders 折叠/展开
    const shouldShowChildren = node.isDir && (searchQuery.trim() ? true : isExpanded);

    const handleNodeClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (node.isDir) {
        handleFolderExpand(node);
      } else {
        onFileClick(relativePath);
      }
    };

    const handleDragStart = (e: React.DragEvent) => {
      if (node.isDir) return;
      e.dataTransfer.setData("text/plain", `"${relativePath}" `);
      e.dataTransfer.effectAllowed = "copy";
      // 拖拽时给自身加半透明效果
      (e.currentTarget as HTMLElement).classList.add("dragging");
    };

    const handleDragEnd = (e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove("dragging");
    };

    return (
      <div key={relativePath} className="tree-node-wrapper">
        <div
          className={`tree-node ${node.isDir ? "directory-node" : "file-node"}`}
          style={{ paddingLeft }}
          draggable={!node.isDir}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={handleNodeClick}
          onContextMenu={(e) => handleContextMenu(e, relativePath, node.isDir)}
        >
          <span className="tree-node-arrow">
            {node.isDir && (
              shouldShowChildren ? <ChevronDown size={14} /> : <ChevronRight size={14} />
            )}
          </span>
          <span className="tree-node-icon">
            {node.isDir ? (
              shouldShowChildren ? <FolderOpen size={14} className="folder-icon open" /> : <Folder size={14} className="folder-icon" />
            ) : (
              <FileText size={14} className="file-icon" />
            )}
          </span>
          <span className="tree-node-name" title={node.name}>
            {node.name}
          </span>
        </div>
        
        {shouldShowChildren && node.children && node.children.length > 0 && (
          <div className="tree-node-children">
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="project-tree-panel" ref={containerRef}>
      {/* 搜索栏与刷新按钮 */}
      <div className="project-tree-header">
        <div className="tree-search-container">
          <Search size={12} className="tree-search-icon" />
          <input 
            type="text" 
            placeholder="搜索工作区文件..." 
            className="tree-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <button 
          className="tree-refresh-btn" 
          onClick={() => loadFiles(true)} 
          title="刷新目录树"
          disabled={loading || searching}
        >
          <RefreshCw size={12} className={loading || searching ? "spinning" : ""} />
        </button>
      </div>

      {/* 树体区域 */}
      <div className="project-tree-body">
        {loading ? (
          <div className="tree-placeholder">加载中...</div>
        ) : searchQuery.trim() && searching ? (
          <div className="tree-placeholder">检索中...</div>
        ) : searchQuery.trim() && searchResults.length === 0 ? (
          <div className="tree-placeholder">未找到匹配的文件</div>
        ) : !searchQuery.trim() && (!treeData.children || treeData.children.length === 0) ? (
          <div className="tree-placeholder">未在项目中发现可用文件</div>
        ) : (
          renderNode(searchQuery.trim() ? (searchTreeData || treeData) : treeData)
        )}
      </div>

      {/* 自定义右键菜单 */}
      {contextMenu && (
        <div 
          className="tree-context-menu"
          style={{
            position: "fixed",
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 9999,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            onClick={() => {
              onInsertPathToTerminal(contextMenu.filePath);
              setContextMenu(null);
            }}
          >
            添加到对话
          </button>
          <div className="menu-divider" />
          <button 
            onClick={() => {
              const separator = projectPath.endsWith("/") || projectPath.endsWith("\\") ? "" : "/";
              const absolutePath = `${projectPath}${separator}${contextMenu.filePath}`;
              invoke("open_in_file_manager", { path: absolutePath })
                .catch(err => console.error("在文件管理器中打开失败:", err));
              setContextMenu(null);
            }}
          >
            在文件管理器中打开
          </button>
          <button 
            onClick={() => {
              const separator = projectPath.endsWith("/") || projectPath.endsWith("\\") ? "" : "/";
              const absolutePath = `${projectPath}${separator}${contextMenu.filePath}`;
              copyToClipboard(absolutePath);
              setContextMenu(null);
            }}
          >
            复制绝对路径
          </button>
        </div>
      )}
    </div>
  );
};
