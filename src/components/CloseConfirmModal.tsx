import React, { useEffect, useRef } from "react";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { log } from "../utils/log";

export interface CloseConfirmModalProps {
  show: boolean;
  rememberChoice: boolean;
  appWindow: TauriWindow;
  onRememberChange: (remember: boolean) => void;
  onCancel: () => void;
}

export const CloseConfirmModal: React.FC<CloseConfirmModalProps> = ({
  show,
  rememberChoice,
  appWindow,
  onRememberChange,
  onCancel,
}) => {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!show) return;
    const timer = window.setTimeout(() => {
      cancelButtonRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [show, onCancel]);

  if (!show) return null;

  return (
    <div className="modal-overlay show" style={{ zIndex: 1100 }} data-focus-trap="close-confirm">
      <div className="modal-card select-confirm-modal" style={{ width: "420px" }}>
        <div className="modal-header">
          <span className="modal-title" style={{ fontSize: "15px", fontWeight: 700 }}>
            退出 KKCoder
          </span>
          <button type="button" className="modal-close" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div
          className="modal-body"
          style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "10px 0" }}
        >
          <p style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: "1.6" }}>
            您想要直接退出应用，还是将它最小化到系统托盘？
          </p>
          <div className="settings-switch-row" style={{ marginTop: "4px", gap: "8px" }}>
            <label className="switch-container">
              <input
                type="checkbox"
                checked={rememberChoice}
                onChange={(event) => onRememberChange(event.target.checked)}
              />
              <span className="switch-slider"></span>
            </label>
            <span className="switch-label" style={{ fontSize: "12.5px" }}>
              记住我的选择，下次不再询问
            </span>
          </div>
        </div>
        <div className="modal-footer" style={{ marginTop: "15px" }}>
          <button
            ref={cancelButtonRef}
            type="button"
            className="modal-btn modal-btn-cancel"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="modal-btn"
            style={{ backgroundColor: "var(--color-primary)", color: "#ffffff" }}
            onClick={() => {
              if (rememberChoice) {
                localStorage.setItem("kkcoder_setting_close_behavior", "minimize");
              }
              onCancel();
              appWindow.hide().catch((error) => log(`Failed to hide window: ${error}`));
            }}
          >
            最小化到托盘
          </button>
          <button
            className="modal-btn"
            style={{ backgroundColor: "#ef4444", color: "#ffffff" }}
            onClick={() => {
              if (rememberChoice) {
                localStorage.setItem("kkcoder_setting_close_behavior", "exit");
              }
              onCancel();
              appWindow.destroy().catch((error) => log(`Failed to destroy window: ${error}`));
            }}
          >
            直接退出
          </button>
        </div>
      </div>
    </div>
  );
};
