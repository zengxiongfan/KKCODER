import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DirectoryPickerModal } from "./DirectoryPickerModal";

interface NewSessionModalProps {
  show: boolean;
  onClose: () => void;
  selectedAgent: "claude" | "pi";
  onCreate: (sessionName: string, projectPath: string, projectName: string) => void;
  initialProjectPath?: string;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  show,
  onClose,
  selectedAgent,
  onCreate,
  initialProjectPath,
}) => {
  const [sessionTitle, setSessionTitle] = useState("");
  const [projectPath, setProjectPath] = useState("D:\\");
  const [searchQuery, setSearchQuery] = useState("");
  const [recentProjects, setRecentProjects] = useState<Array<{ name: string; path: string }>>([]);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [confirmDirState, setConfirmDirState] = useState<{
    path: string;
    sessionTitle: string;
    projectName: string;
  } | null>(null);

  // 当弹窗打开时，重置标题并加载 SQLite 本地最近项目记录
  useEffect(() => {
    if (show) {
      setSessionTitle("");
      setConfirmDirState(null);
      setShowDirPicker(false);
      if (initialProjectPath) {
        setProjectPath(initialProjectPath);
        // 也获取一下最近项目列表，以保持下拉菜单可用
        invoke<Array<{ name: string; path: string }>>("get_recent_projects")
          .then((data) => {
            setRecentProjects(data || []);
          })
          .catch((err) => {
            console.error("获取本地最近项目失败", err);
          });
      } else {
        invoke<Array<{ name: string; path: string }>>("get_recent_projects")
          .then((data) => {
            setRecentProjects(data || []);
            if (data && data.length > 0) {
              setProjectPath(data[0].path);
            } else {
              setProjectPath("D:\\");
            }
          })
          .catch((err) => {
            console.error("获取本地最近项目失败", err);
            setProjectPath("D:\\");
          });
      }
    }
  }, [show, initialProjectPath]);

  // 监听 ESC 键关闭新建会话弹窗与子弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showDirPicker) {
          setShowDirPicker(false);
        } else if (confirmDirState) {
          setConfirmDirState(null);
        } else {
          onClose();
        }
      }
    };
    if (show) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [show, onClose, confirmDirState, showDirPicker]);

  // 打开内置目录选择器
  const handleBrowse = () => {
    setShowDirPicker(true);
  };

  const handleDirSelect = (selected: string) => {
    if (selected) {
      // 去除末尾斜杠，保持路径一致性
      const cleanPath = selected.replace(/[\\/]+$/, "");
      setProjectPath(cleanPath);
      // 自动提取项目名称
      const parts = cleanPath.split(/[\\/]/);
      const name = parts[parts.length - 1] || "未命名项目";

      // 若该项目不在最近列表中，则动态追加
      if (!recentProjects.some((p) => p.path === cleanPath)) {
        setRecentProjects([{ name, path: cleanPath }, ...recentProjects]);
      }
    }
  };

  const handleSelectRecent = (path: string) => {
    setProjectPath(path);
  };

  const handleSubmit = async () => {
    if (!projectPath.trim()) {
      alert("请输入或选择项目路径！");
      return;
    }

    // 去除末尾斜杠，避免 split 后最后一个元素为空导致项目名显示为"新项目"
    const cleanPath = projectPath.replace(/[\\/]+$/, "");
    setProjectPath(cleanPath);

    // 从项目路径中自动截取项目名称
    const parts = cleanPath.split(/[\\/]/);
    const projectName = parts[parts.length - 1] || "新项目";
    const finalSessionTitle = sessionTitle.trim() || "新会话";

    try {
      const dirStatus = await invoke<string>("check_directory", { path: cleanPath });
      if (dirStatus === "not_dir") {
        alert("项目路径指向的不是一个有效文件夹，请核对！");
        return;
      } else if (dirStatus === "not_exists") {
        setConfirmDirState({
          path: cleanPath,
          sessionTitle: finalSessionTitle,
          projectName,
        });
        return;
      }
    } catch (e) {
      alert(`预检查路径异常: ${e}`);
      return;
    }

    onCreate(finalSessionTitle, cleanPath, projectName);
    onClose();
  };

  const handleConfirmCreateDir = async () => {
    if (!confirmDirState) return;
    try {
      await invoke("create_directory", { path: confirmDirState.path });
      onCreate(confirmDirState.sessionTitle, confirmDirState.path, confirmDirState.projectName);
      setConfirmDirState(null);
      onClose();
    } catch (err) {
      alert(`自动创建物理目录失败: ${err}`);
    }
  };

  const handleCancelCreateDir = () => {
    setConfirmDirState(null);
  };

  // 过滤最近项目
  const filteredRecent = recentProjects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (!show) return null;

  return (
    <div className={`modal-overlay ${show ? "show" : ""}`}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            新建 {selectedAgent === "claude" ? "Claude Code" : "Pi"} 会话
          </span>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* 1. 会话标题 */}
        <div className="form-item">
          <span className="form-label">会话标题（可选）</span>
          <div className="input-group">
            <input
              type="text"
              className="modal-input"
              placeholder="自动生成"
              value={sessionTitle}
              onChange={(e) => setSessionTitle(e.target.value)}
            />
          </div>
        </div>

        {/* 2. 项目路径 */}
        <div className="form-item">
          <span className="form-label">项目路径</span>
          <div className="input-group">
            <input
              type="text"
              className="modal-input"
              style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
            />
            <button className="browse-btn" onClick={handleBrowse}>
              浏览
            </button>
          </div>
        </div>

        {/* 3. 最近项目 */}
        <div className="recent-section">
          <div className="recent-header">
            <span>最近项目</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="text"
                className="recent-search"
                placeholder="搜索路径..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <span>共 {filteredRecent.length} 个</span>
            </div>
          </div>
          <div className="recent-tags-container">
            {filteredRecent.map((proj) => {
              const isActive = projectPath === proj.path;
              return (
                <div
                  key={proj.path}
                  className={`recent-tag ${isActive ? "active" : ""}`}
                  onClick={() => handleSelectRecent(proj.path)}
                >
                  {proj.name}
                </div>
              );
            })}
          </div>
        </div>

        {/* 4. 操作区 */}
        <div className="modal-footer">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>
            取消
          </button>
          <button
            className="modal-btn modal-btn-create"
            onClick={handleSubmit}
          >
            创建
          </button>
        </div>
      </div>

      {/* 5. 自动新建文件夹自适应主题确认框 */}
      {confirmDirState && (
        <div className="modal-overlay show" style={{ zIndex: 1001 }}>
          <div className="modal-card" style={{ maxWidth: "420px" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">自动创建目录</span>
              <button className="modal-close" onClick={handleCancelCreateDir}>×</button>
            </div>
            
            <div style={{ fontSize: "13.5px", lineHeight: "1.6", color: "var(--text-primary)" }}>
              路径「<strong style={{ color: "var(--color-orange)" }}>{confirmDirState.path}</strong>」不存在，是否自动创建该目录并继续？
            </div>
            
            <div className="modal-footer">
              <button className="modal-btn modal-btn-cancel" onClick={handleCancelCreateDir}>
                取消
              </button>
              <button 
                className="modal-btn modal-btn-create" 
                onClick={handleConfirmCreateDir}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. 内置目录选择框 */}
      <DirectoryPickerModal
        show={showDirPicker}
        onClose={() => setShowDirPicker(false)}
        onSelect={handleDirSelect}
        initialPath={projectPath}
      />
    </div>
  );
};
