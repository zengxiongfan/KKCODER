import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// ==================== 远程开发设置面板 ====================

interface RemoteConfig {
  enabled: boolean;
  port: number;
  listen_mode: string;
  public_url: string;
  frp_server_addr: string;
  frp_server_port: number;
  frp_token: string;
  frp_use_tls: boolean;
}

interface PairedDevice {
  device_id: string;
  device_name: string;
  paired_at: string;
  last_seen: string;
}


export const RemoteSettingsPanel: React.FC = () => {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [pairingPin, setPairingPin] = useState<string | null>(null);
  const [pinCountdown, setPinCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testing, setTesting] = useState(false);

  // frp 配置
  const [frpServerAddr, setFrpServerAddr] = useState("");
  const [frpServerPort, setFrpServerPort] = useState(7000);
  const [frpToken, setFrpToken] = useState("");
  const [frpUseTls, setFrpUseTls] = useState(false);
  const [frpRunning, setFrpRunning] = useState(false);

  useEffect(() => {
    loadConfig();
    loadDevices();
    loadFrpStatus();
  }, []);

  const loadFrpStatus = async () => {
    try {
      const status = await invoke<{ running: boolean }>("get_frp_status");
      setFrpRunning(status.running);
    } catch {}
  };

  useEffect(() => {
    if (pinCountdown <= 0) return;
    const timer = setInterval(() => {
      setPinCountdown((prev) => {
        if (prev <= 1) { setPairingPin(null); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [pinCountdown]);

  const loadConfig = async () => {
    try {
      const cfg = await invoke<RemoteConfig>("get_remote_config");
      setConfig(cfg);
      setPublicUrl(cfg.public_url);
      setFrpServerAddr(cfg.frp_server_addr);
      setFrpServerPort(cfg.frp_server_port);
      setFrpToken(cfg.frp_token);
      setFrpUseTls(cfg.frp_use_tls);
    } catch (e) {
      console.error("加载远程配置失败:", e);
    }
  };

  const loadDevices = async () => {
    try {
      const devices = await invoke<PairedDevice[]>("get_paired_devices");
      setPairedDevices(devices);
    } catch (e) {
      console.error("加载设备列表失败:", e);
    }
  };

  const handleToggleEnabled = async () => {
    if (!config) return;
    setLoading(true);
    try {
      await invoke("set_remote_enabled", { enabled: !config.enabled });
      await loadConfig();
    } catch (e) {
      console.error("切换远程访问状态失败:", e);
    }
    setLoading(false);
  };

  const handlePortChange = async (newPort: number) => {
    if (!config || newPort < 1024 || newPort > 65535) return;
    setLoading(true);
    try {
      await invoke("set_remote_port", { port: newPort });
      await loadConfig();
    } catch (e) {
      console.error("设置端口失败:", e);
    }
    setLoading(false);
  };

  const handleListenModeChange = async (mode: string) => {
    if (!config) return;
    setLoading(true);
    try {
      await invoke("set_listen_mode", { mode });
      await loadConfig();
    } catch (e) {
      console.error("设置监听模式失败:", e);
    }
    setLoading(false);
  };

  const handleSavePublicUrl = async () => {
    setLoading(true);
    try {
      await invoke("set_public_url", { url: publicUrl.trim() });
      await loadConfig();
    } catch (e) {
      console.error("保存公网地址失败:", e);
    }
    setLoading(false);
  };

  const handleTestUrl = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const ok = await invoke<boolean>("test_public_url", { url: publicUrl.trim() });
      setTestResult(ok ? "ok" : "fail");
    } catch {
      setTestResult("fail");
    }
    setTesting(false);
  };

  const handleGeneratePin = async () => {
    setLoading(true);
    try {
      const pin = await invoke<string>("generate_pairing_pin");
      setPairingPin(pin);
      setPinCountdown(300);
    } catch (e) {
      console.error("生成 PIN 失败:", e);
    }
    setLoading(false);
  };

  const handleRevokeDevice = async (deviceId: string) => {
    try {
      await invoke("revoke_device", { deviceId });
      await loadDevices();
    } catch (e) {
      console.error("吊销设备失败:", e);
    }
  };

  const handleSaveFrpConfig = async () => {
    setLoading(true);
    try {
      await invoke("set_frp_server_addr", { addr: frpServerAddr });
      await invoke("set_frp_server_port", { port: frpServerPort });
      await invoke("set_frp_token", { token: frpToken });
      await invoke("set_frp_use_tls", { useTls: frpUseTls });
      await loadConfig();
    } catch (e) {
      console.error("保存 frp 配置失败:", e);
    }
    setLoading(false);
  };

  const handleToggleFrp = async () => {
    setLoading(true);
    try {
      if (frpRunning) {
        await invoke("stop_frp");
      } else {
        if (!config) return;
        await invoke("start_frp", {
          serverAddr: frpServerAddr,
          serverPort: frpServerPort,
          token: frpToken,
          localPort: config.port,
          useTls: frpUseTls,
        });
      }
      await loadFrpStatus();
    } catch (e) {
      console.error("frp 操作失败:", e);
    }
    setLoading(false);
  };

  if (!config) {
    return <div className="settings-content" style={{ padding: "40px", textAlign: "center", color: "var(--text-secondary)" }}>加载中...</div>;
  }

  const toggleStyle = (on: boolean): React.CSSProperties => ({
    width: "44px", height: "24px", borderRadius: "12px", border: "none",
    cursor: "pointer",
    backgroundColor: on ? "var(--accent-color, #4f9cf7)" : "var(--border-color, #3a3a4a)",
    position: "relative", transition: "background-color 0.2s",
  });
  const knobStyle = (on: boolean): React.CSSProperties => ({
    position: "absolute", top: "2px", left: on ? "22px" : "2px",
    width: "20px", height: "20px", borderRadius: "50%",
    backgroundColor: "#fff", transition: "left 0.2s",
  });
  const inputStyle: React.CSSProperties = {
    padding: "4px 8px", borderRadius: "6px",
    border: "1px solid var(--border-color, #3a3a4a)",
    backgroundColor: "var(--input-bg, #1e1e2e)",
    color: "var(--text-primary, #e0e0e0)", fontSize: "13px",
  };

  return (
    <div className="settings-content">
      {/* === 服务器控制 === */}
      <div className="settings-group">
        <div className="settings-group-label" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          远程访问
          <span style={{
            fontSize: "11px", fontWeight: "normal", padding: "1px 8px",
            borderRadius: "10px",
            backgroundColor: config.enabled ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.06)",
            color: config.enabled ? "#4ade80" : "var(--text-secondary)",
          }}>
            {config.enabled ? "运行中" : "已停止"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
          <span style={{ fontSize: "13px" }}>启用远程访问</span>
          <button onClick={handleToggleEnabled} disabled={loading} style={toggleStyle(config.enabled)}>
            <span style={knobStyle(config.enabled)} />
          </button>
        </div>

        {config.enabled && (
          <>
            {/* 监听端口 */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <span style={{ fontSize: "13px", whiteSpace: "nowrap" }}>监听端口</span>
              <input type="number" value={config.port}
                onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setConfig({ ...config, port: v }); }}
                onBlur={(e) => handlePortChange(parseInt(e.target.value, 10))}
                min={1024} max={65535}
                style={{ ...inputStyle, width: "80px" }}
              />
            </div>

            {/* 监听模式 */}
            <div style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "13px", marginBottom: "6px" }}>监听模式</div>
              <div style={{ display: "flex", gap: "6px" }}>
                {[
                  { value: "localhost", label: "仅本机", desc: "127.0.0.1" },
                  { value: "all", label: "所有设备", desc: "0.0.0.0" },
                ].map((opt) => (
                  <button key={opt.value} onClick={() => handleListenModeChange(opt.value)}
                    style={{
                      flex: 1, padding: "8px", borderRadius: "8px", cursor: "pointer",
                      border: config.listen_mode === opt.value
                        ? "1px solid var(--accent-color, #4f9cf7)"
                        : "1px solid var(--border-color, #3a3a4a)",
                      backgroundColor: config.listen_mode === opt.value
                        ? "rgba(79,156,247,0.08)" : "transparent",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-primary)" }}>{opt.label}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "6px" }}>
                {config.listen_mode === "localhost"
                  ? "仅接受本机连接。用 frp/nginx 反代时选这个，最安全。"
                  : "接受局域网设备直连。无反代时使用，需确保网络安全。"}
              </div>
            </div>

            {/* 公网访问地址 */}
            <div className="settings-group" style={{ marginTop: "4px", padding: "12px", borderRadius: "8px", backgroundColor: "var(--bg-secondary, #1a1a2e)", border: "1px solid var(--border-color, #3a3a4a)" }}>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "8px" }}>
                公网访问地址（移动端填写此地址连接）
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <input type="text" value={publicUrl}
                  onChange={(e) => { setPublicUrl(e.target.value); setTestResult(null); }}
                  onBlur={handleSavePublicUrl}
                  placeholder="https://kkcoder.example.com 或 http://IP:端口"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button onClick={handleTestUrl} disabled={testing || !publicUrl.trim()}
                  style={{
                    padding: "4px 14px", borderRadius: "6px", border: "none", fontSize: "12px",
                    cursor: testing || !publicUrl.trim() ? "not-allowed" : "pointer",
                    backgroundColor: testResult === "ok" ? "#16a34a" : testResult === "fail" ? "#dc2626" : "var(--border-color, #3a3a4a)",
                    color: "#fff", whiteSpace: "nowrap", minWidth: "56px",
                  }}
                >
                  {testing ? "..." : testResult === "ok" ? "连通" : testResult === "fail" ? "失败" : "测试"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* === 设备配对 === */}
      {config.enabled && (
        <div className="settings-group">
          <div className="settings-group-label">配对新设备</div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px" }}>
            <button onClick={handleGeneratePin} disabled={loading || pinCountdown > 0}
              style={{
                padding: "6px 16px", borderRadius: "6px", border: "none",
                backgroundColor: "var(--accent-color, #4f9cf7)", color: "#fff",
                fontSize: "13px", cursor: loading || pinCountdown > 0 ? "not-allowed" : "pointer",
                opacity: loading || pinCountdown > 0 ? 0.6 : 1,
              }}
            >
              {pinCountdown > 0 ? "已生成" : "生成 PIN 码"}
            </button>
            {pinCountdown > 0 && (
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                {Math.floor(pinCountdown / 60)}:{String(pinCountdown % 60).padStart(2, "0")} 后过期
              </span>
            )}
          </div>

          {pairingPin && (
            <div style={{
              padding: "16px", borderRadius: "8px",
              backgroundColor: "var(--bg-secondary, #1a1a2e)",
              border: "1px solid var(--accent-color, #4f9cf7)",
              textAlign: "center", marginBottom: "16px",
            }}>
              <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginBottom: "8px" }}>
                在手机 App 中输入以下 PIN 码
              </div>
              <div style={{
                fontSize: "32px", fontWeight: 700, letterSpacing: "8px",
                color: "var(--accent-color, #4f9cf7)", fontFamily: "monospace",
              }}>
                {pairingPin}
              </div>
            </div>
          )}

          {pairedDevices.length > 0 && (
            <div>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "8px" }}>
                已配对设备 ({pairedDevices.length})
              </div>
              {pairedDevices.map((device) => (
                <div key={device.device_id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "8px 12px", borderRadius: "6px",
                  backgroundColor: "var(--bg-secondary, #1a1a2e)", marginBottom: "4px", fontSize: "13px",
                }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>{device.device_name}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                      配对于 {device.paired_at}
                    </div>
                  </div>
                  <button onClick={() => handleRevokeDevice(device.device_id)}
                    style={{
                      padding: "4px 10px", borderRadius: "4px",
                      border: "1px solid #e74c3c", backgroundColor: "transparent",
                      color: "#e74c3c", fontSize: "12px", cursor: "pointer",
                    }}
                  >
                    吊销
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === frp 配置 === */}
      {config.enabled && (
        <div className="settings-group">
          <div className="settings-group-label">frp 内网穿透（可选）</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "13px", whiteSpace: "nowrap", minWidth: "70px" }}>服务器地址:</span>
              <input type="text" value={frpServerAddr} onChange={(e) => setFrpServerAddr(e.target.value)}
                placeholder="frp.example.com" style={{ ...inputStyle, flex: 1 }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "13px", whiteSpace: "nowrap", minWidth: "70px" }}>服务器端口:</span>
              <input type="number" value={frpServerPort} onChange={(e) => setFrpServerPort(parseInt(e.target.value, 10) || 7000)}
                min={1} max={65535} style={{ ...inputStyle, width: "80px" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "13px", whiteSpace: "nowrap", minWidth: "70px" }}>Token:</span>
              <input type="password" value={frpToken} onChange={(e) => setFrpToken(e.target.value)}
                placeholder="frp 认证 token" style={{ ...inputStyle, flex: 1 }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "4px" }}>
              <div>
                <span style={{ fontSize: "13px" }}>TLS 加密</span>
                <span style={{ fontSize: "11px", color: "var(--text-secondary)", marginLeft: "8px" }}>
                  服务器有 HTTPS 时开启
                </span>
              </div>
              <button onClick={() => setFrpUseTls(!frpUseTls)} style={toggleStyle(frpUseTls)}>
                <span style={knobStyle(frpUseTls)} />
              </button>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
              <button onClick={handleSaveFrpConfig} disabled={loading}
                style={{
                  padding: "6px 16px", borderRadius: "6px", border: "none",
                  backgroundColor: "var(--accent-color, #4f9cf7)", color: "#fff",
                  fontSize: "13px", cursor: loading ? "not-allowed" : "pointer",
                }}
              >
                保存 frp 配置
              </button>
              <button onClick={handleToggleFrp} disabled={loading || !frpServerAddr || !frpToken}
                style={{
                  padding: "6px 16px", borderRadius: "6px", border: "none",
                  fontSize: "13px", cursor: loading || !frpServerAddr || !frpToken ? "not-allowed" : "pointer",
                  backgroundColor: frpRunning ? "#dc2626" : "#16a34a",
                  color: "#fff",
                }}
              >
                {frpRunning ? "停止 frpc" : "启动 frpc"}
              </button>
              {frpRunning && (
                <span style={{ fontSize: "12px", color: "#4ade80", alignSelf: "center" }}>
                  运行中
                </span>
              )}
            </div>
          </div>
          <div style={{
            marginTop: "8px", padding: "8px 12px", borderRadius: "6px",
            backgroundColor: "var(--bg-secondary, #1a1a2e)",
            fontSize: "12px", color: "var(--text-secondary)",
          }}>
            frpc 需放在应用目录或系统 PATH 中
          </div>
        </div>
      )}
    </div>
  );
};
