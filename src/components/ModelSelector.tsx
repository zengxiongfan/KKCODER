import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { ClaudeModelInfo } from "../utils/claudeModel";
import { log } from "../utils/log";

interface ModelSelectorProps {
  selectedModel: string | null;
  modelInfo: ClaudeModelInfo | null;
  onSelectModel: (model: string | null) => void;
  onSelectProvider: (providerId: string) => void;
  onRefreshModelInfo?: () => void;
  /** AI 思考中禁用切换（当前会话忙） */
  disabled?: boolean;
}

/** 聊天输入框旁的模型/供应商选择器：点供应商定死默认（菜单保持打开可接着选模型），点模型或菜单外关闭 */
export const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModel,
  modelInfo,
  onSelectModel,
  onSelectProvider,
  onRefreshModelInfo,
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const displayModel = selectedModel || modelInfo?.defaultModel || "选择模型";
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dropdownWidth = 280;
    const margin = 8;

    const bottom = window.innerHeight - rect.top + margin;

    let left = rect.left;
    if (left + dropdownWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - dropdownWidth - margin);
    }

    setDropdownStyle({
      position: "fixed",
      bottom: `${bottom}px`,
      left: `${left}px`,
      zIndex: 99999,
    });
  }, []);

  useEffect(() => {
    if (open) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    }
  }, [open, updatePosition]);

  // 点击菜单外部任意处关闭
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !(target as Element).closest?.(".model-dropdown")
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // 思考中禁用：关闭可能已打开的菜单
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const toggle = () => {
    if (disabled) return;
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen) onRefreshModelInfo?.();
  };

  // 路由开关状态：常驻显示在触发按钮上，一眼看出 CC Switch 路由开关开没开
  const routeEnabled = modelInfo?.routeEnabled ?? false;

  return (
    <div className="chat-model-select" ref={containerRef}>
      <button
        type="button"
        className={`chat-model-select-btn ${open ? "active" : ""} ${disabled ? "is-disabled" : ""}`}
        onClick={toggle}
        disabled={disabled}
        title={
          disabled
            ? "AI 思考中，暂时不能切换模型"
            : `${routeEnabled ? "路由已开（走 CC Switch 代理）" : "路由已关（直连）"} · ` +
                (selectedModel
                  ? `当前模型：${selectedModel}`
                  : modelInfo?.defaultModel
                    ? `当前模型：${modelInfo.defaultModel}（该供应商默认）`
                    : "选择模型 / 供应商")
        }
      >
        <Cpu size={12} className="chat-model-icon" />
        <span className="chat-model-select-label">{displayModel}</span>
        {routeEnabled && (
          <span className="chat-model-route-dot" title="CC Switch 路由开关已开启" />
        )}
        <ChevronDown size={11} className={`chat-model-select-chevron ${open ? "is-open" : ""}`} />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="model-dropdown chat-model-dropdown"
            style={dropdownStyle}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {modelInfo && (
              <div className="model-dropdown-header">
                <span
                  className="model-dropdown-provider"
                  title={
                    modelInfo.providerRemoved
                      ? "当前直连的供应商已从 CC Switch 移除"
                      : (modelInfo.providerName ?? undefined)
                  }
                >
                  {modelInfo.providerRemoved
                    ? "未知供应商（已移除）"
                    : (modelInfo.providerName ?? "CC Switch")}
                </span>
                <span
                  className={`model-dropdown-mode ${modelInfo.routeEnabled ? "is-route" : ""}`}
                  title={
                    modelInfo.routeEnabled
                      ? "CC Switch 路由开关已开启，请求走本地代理"
                      : "CC Switch 路由开关未开启，请求直连"
                  }
                >
                  {modelInfo.routeEnabled ? "路由已启用" : "直连模式"}
                </span>
              </div>
            )}
            <div className="model-dropdown-section-title">供应商 · Providers</div>
            {modelInfo && modelInfo.providers.length > 0 ? (
              <div className="model-dropdown-provider-list">
                {modelInfo.providers.map((provider) => {
                  const isCurrent = provider.name === modelInfo.providerName;
                  return (
                    <div
                      key={provider.id}
                      className={`model-dropdown-item ${isCurrent ? "active" : ""}`}
                      title={provider.baseUrl || undefined}
                      onClick={() => {
                        log(`[model] select provider=${provider.id} (${provider.name})`);
                        onSelectProvider(provider.id);
                      }}
                    >
                      <span className="model-dropdown-item-label">{provider.name}</span>
                      <span className="model-dropdown-item-end">
                        {provider.routeOnly && (
                          <span
                            className="model-dropdown-route-badge"
                            title="该供应商需要开启路由（走 CC Switch 代理）才能使用"
                          >
                            需路由
                          </span>
                        )}
                        {isCurrent && (
                          <Check size={12} strokeWidth={2.5} className="model-dropdown-check" />
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="model-dropdown-empty">未读取到供应商</div>
            )}
            <div className="model-dropdown-divider" />
            <div className="model-dropdown-section-title">可用模型 · Models</div>
            <div className="model-dropdown-model-list">
              {modelInfo && modelInfo.models.length > 0
                ? modelInfo.models.map((model) => {
                    const isSelected = selectedModel === model;
                    return (
                      <div
                        key={model}
                        className={`model-dropdown-item ${isSelected ? "active" : ""}`}
                        title={isSelected ? "再次点击取消，回到该供应商默认" : undefined}
                        onClick={() => {
                          log(`[model] select model=${model} (cancel=${isSelected})`);
                          onSelectModel(isSelected ? null : model);
                          setOpen(false);
                        }}
                      >
                        <span className="model-dropdown-item-label">{model}</span>
                        {isSelected && (
                          <Check size={12} strokeWidth={2.5} className="model-dropdown-check" />
                        )}
                      </div>
                    );
                  })
                : null}
              {(!modelInfo || modelInfo.models.length === 0) && (
                <div className="model-dropdown-empty">未读取到模型配置</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};
