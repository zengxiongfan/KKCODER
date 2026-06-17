import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./DirectoryPickerModal.css";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface DirListResult {
  current_path: string;
  parent_path: string | null;
  entries: DirEntry[];
  drives: string[];
  home_dir: string | null;
  desktop_dir: string | null;
}

interface DirectoryPickerModalProps {
  show: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
  mode?: "directory" | "file";
  extensions?: string[];
  title?: string;
}

// Monochrome SVG Icons following the Amber design system constraints
const FolderIcon = () => (
  <svg className="dir-picker-item-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

const FileIcon = () => (
  <svg className="dir-picker-item-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)" }}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const HardDriveIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);

const HomeIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

const DesktopIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

const ArrowUpIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

const RefreshIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
  </svg>
);

const SearchIcon = () => (
  <svg className="dir-picker-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const NewFolderIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </svg>
);

export const DirectoryPickerModal: React.FC<DirectoryPickerModalProps> = ({
  show,
  onClose,
  onSelect,
  initialPath,
  mode = "directory",
  extensions,
  title = "选择项目路径",
}) => {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [desktopDir, setDesktopDir] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string>("");
  const [tempPathInput, setTempPathInput] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [showNewFolder, setShowNewFolder] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // Initialize directory contents
  useEffect(() => {
    if (show) {
      loadDirectory(initialPath || null);
      setShowNewFolder(false);
      setNewFolderName("");
      setSearchQuery("");
    }
  }, [show, initialPath]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && show) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [show, onClose]);

  // Focus inline new folder input when it shows up
  useEffect(() => {
    if (showNewFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [showNewFolder]);

  const loadDirectory = async (path: string | null) => {
    try {
      setError(null);
      const res = await invoke<DirListResult>("list_directory_folders", {
        path,
        showFiles: mode === "file",
        extensions: extensions || null,
      });
      setCurrentPath(res.current_path);
      setParentPath(res.parent_path);
      setEntries(res.entries);
      setDrives(res.drives);
      setHomeDir(res.home_dir);
      setDesktopDir(res.desktop_dir);

      setSelectedPath(res.current_path);
      setTempPathInput(res.current_path);
      setShowNewFolder(false);
      
      // Scroll list back to top
      if (listRef.current) {
        listRef.current.scrollTop = 0;
      }
    } catch (err) {
      setError(`加载目录失败: ${err}`);
    }
  };

  const handleNavigate = (path: string) => {
    loadDirectory(path);
  };

  const handleSelectEntry = (entry: DirEntry) => {
    setSelectedPath(entry.path);
    setTempPathInput(entry.path);
  };

  const handleDoubleClickEntry = (entry: DirEntry) => {
    if (entry.is_dir) {
      loadDirectory(entry.path);
    } else if (mode === "file") {
      onSelect(entry.path);
      onClose();
    }
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tempPathInput.trim()) {
      loadDirectory(tempPathInput.trim());
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      setError(null);
      // Combine path safely
      const separator = currentPath.endsWith("\\") || currentPath.endsWith("/") ? "" : "\\";
      const fullNewPath = `${currentPath}${separator}${newFolderName.trim()}`;
      
      await invoke("create_directory", { path: fullNewPath });
      
      // Refresh current directory
      await loadDirectory(currentPath);
      setShowNewFolder(false);
      setNewFolderName("");
      
      // Navigate inside the newly created folder
      loadDirectory(fullNewPath);
    } catch (err) {
      setError(`创建文件夹失败: ${err}`);
    }
  };

  const handleConfirm = () => {
    if (selectedPath) {
      // If mode is file, ensure the selected path is not a folder in the listing
      const matched = entries.find((e) => e.path.toLowerCase() === selectedPath.toLowerCase());
      if (mode === "file" && matched?.is_dir) {
        return; // Cannot select folder in file mode
      }
      onSelect(selectedPath);
      onClose();
    }
  };

  if (!show) return null;

  // Filter entries in real-time based on query
  const filteredEntries = entries.filter((e) =>
    e.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Check if confirmation button should be disabled
  const isSelectedPathDir = entries.find((e) => e.path.toLowerCase() === selectedPath.toLowerCase())?.is_dir ?? true;
  const isConfirmDisabled = !selectedPath || (mode === "file" && (isSelectedPathDir || selectedPath === currentPath));

  return (
    <div className={`dir-picker-overlay ${show ? "show" : ""}`} onClick={onClose}>
      <div className="dir-picker-card" onClick={(e) => e.stopPropagation()}>
        {/* Title bar */}
        <div className="dir-picker-header">
          <span className="dir-picker-title">{title}</span>
          <button className="dir-picker-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Path bar with parent navigation and refresh */}
        <div className="dir-picker-nav">
          <button
            className="dir-picker-btn"
            title="返回上级"
            disabled={!parentPath}
            onClick={() => parentPath && handleNavigate(parentPath)}
          >
            <ArrowUpIcon />
          </button>
          <button
            className="dir-picker-btn"
            title="刷新"
            onClick={() => loadDirectory(currentPath)}
          >
            <RefreshIcon />
          </button>
          <form className="dir-picker-path-input-container" onSubmit={handlePathSubmit}>
            <input
              type="text"
              className="dir-picker-path-input"
              value={tempPathInput}
              onChange={(e) => setTempPathInput(e.target.value)}
              placeholder="输入或粘贴路径..."
            />
          </form>
        </div>

        {/* Workspace panel */}
        <div className="dir-picker-body">
          {/* Left Sidebar */}
          <div className="dir-picker-sidebar">
            {/* Quick Access */}
            <div>
              <div className="dir-picker-section-title">快捷访问</div>
              <div className="dir-picker-sidebar-list">
                {homeDir && (
                  <div
                    className={`dir-picker-sidebar-item ${currentPath === homeDir ? "active" : ""}`}
                    onClick={() => handleNavigate(homeDir)}
                  >
                    <HomeIcon />
                    <span>用户目录</span>
                  </div>
                )}
                {desktopDir && (
                  <div
                    className={`dir-picker-sidebar-item ${currentPath === desktopDir ? "active" : ""}`}
                    onClick={() => handleNavigate(desktopDir)}
                  >
                    <DesktopIcon />
                    <span>桌面</span>
                  </div>
                )}
              </div>
            </div>

            {/* This PC / Drives */}
            <div>
              <div className="dir-picker-section-title">此电脑</div>
              <div className="dir-picker-sidebar-list">
                {drives.map((drive) => {
                  const isActive = currentPath.toLowerCase() === drive.toLowerCase() || 
                                   currentPath.toLowerCase() === drive.replace(/\\$/, "").toLowerCase();
                  return (
                    <div
                      key={drive}
                      className={`dir-picker-sidebar-item ${isActive ? "active" : ""}`}
                      onClick={() => handleNavigate(drive)}
                      title={drive}
                    >
                      <HardDriveIcon />
                      <span>{drive}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Content Area */}
          <div className="dir-picker-content">
            <div className="dir-picker-search-bar">
              <SearchIcon />
              <input
                type="text"
                className="dir-picker-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={mode === "file" ? "搜索当前目录下的文件或文件夹..." : "搜索当前目录下的文件夹..."}
              />
            </div>

            {error && <div className="dir-picker-error">{error}</div>}

            <div className="dir-picker-list" ref={listRef}>
              {/* Inline folder creation row */}
              {showNewFolder && (
                <div className="dir-picker-new-folder-row">
                  <FolderIcon />
                  <input
                    ref={newFolderInputRef}
                    type="text"
                    className="dir-picker-new-folder-input"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="新文件夹名称..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateFolder();
                      if (e.key === "Escape") setShowNewFolder(false);
                    }}
                  />
                  <div className="dir-picker-new-folder-btn-group">
                    <button className="dir-picker-mini-btn dir-picker-mini-btn-confirm" onClick={handleCreateFolder}>
                      确定
                    </button>
                    <button className="dir-picker-mini-btn dir-picker-mini-btn-cancel" onClick={() => setShowNewFolder(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* Sub-entries list */}
              {filteredEntries.length > 0 ? (
                filteredEntries.map((entry) => {
                  const isSelected = selectedPath === entry.path;
                  return (
                    <div
                      key={entry.path}
                      className={`dir-picker-list-item ${isSelected ? "selected" : ""}`}
                      onClick={() => handleSelectEntry(entry)}
                      onDoubleClick={() => handleDoubleClickEntry(entry)}
                    >
                      <div className="dir-picker-item-left">
                        {entry.is_dir ? <FolderIcon /> : <FileIcon />}
                        <span className="dir-picker-item-name" title={entry.name}>
                          {entry.name}
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                !showNewFolder && (
                  <div className="dir-picker-empty">
                    <span>当前目录为空，或没有符合过滤条件的项</span>
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        {/* Footer controls */}
        <div className="dir-picker-footer">
          <div className="dir-picker-footer-left">
            <button
              className="dir-picker-action-btn dir-picker-btn-newfolder"
              onClick={() => {
                setShowNewFolder(true);
                setNewFolderName("");
              }}
            >
              <NewFolderIcon />
              <span>新建文件夹</span>
            </button>
          </div>
          <div className="dir-picker-footer-right">
            <button className="dir-picker-action-btn dir-picker-btn-cancel" onClick={onClose}>
              取消
            </button>
            <button
              className="dir-picker-action-btn dir-picker-btn-confirm"
              onClick={handleConfirm}
              disabled={isConfirmDisabled}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
