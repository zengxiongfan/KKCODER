use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub is_git_repo: bool,
    pub current_branch: String,
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
    pub has_upstream: bool,
    pub has_remote: bool,
    pub upstream_branch: Option<String>,
    pub has_changes: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullResult {
    pub success: bool,
    pub output: String,
    pub summary: String,
    pub has_conflict: bool,
    pub current_branch: String,
}

fn parse_pull_summary(output: &str, success: bool, has_conflict: bool) -> String {
    if has_conflict {
        return "拉取更新遇到代码冲突，需合并修复".to_string();
    }
    if !success {
        return "拉取更新失败".to_string();
    }
    let lower = output.to_lowercase();
    if lower.contains("already up to date") || output.contains("已经是最新") {
        return "当前分支已是最新状态，无新变更".to_string();
    }

    // 查找类似 "X files changed, Y insertions(+), Z deletions(-)"
    for line in output.lines().rev() {
        let trimmed = line.trim();
        if trimmed.contains("changed")
            && (trimmed.contains("insertion") || trimmed.contains("deletion") || trimmed.contains("file"))
        {
            return format!("已成功更新: {trimmed}");
        }
    }

    if let Some(first_line) = output.lines().find(|l| !l.trim().is_empty()) {
        return format!("已拉取更新: {}", first_line.trim());
    }

    "已成功拉取最新代码更新".to_string()
}

fn create_git_cmd(cwd: Option<&str>) -> Command {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = cwd {
        if !dir.is_empty() && Path::new(dir).exists() {
            cmd.current_dir(dir);
        }
    }
    cmd
}

/// 检查是否在 Git 仓库内并获取当前分支及所有本地分支
#[tauri::command]
pub fn get_git_branch_info(cwd: Option<String>) -> Result<GitBranchInfo, String> {
    let cwd_ref = cwd.as_deref();

    // 1. 检查是否为 git 仓库
    let rev_parse = create_git_cmd(cwd_ref)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output();

    let is_repo = match rev_parse {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true",
        Err(_) => false,
    };

    if !is_repo {
        return Ok(GitBranchInfo {
            is_git_repo: false,
            current_branch: String::new(),
            branches: Vec::new(),
            remotes: Vec::new(),
            has_upstream: false,
            has_remote: false,
            upstream_branch: None,
            has_changes: false,
        });
    }

    // 2. 获取当前分支名
    let current_branch_out = create_git_cmd(cwd_ref)
        .args(["branch", "--show-current"])
        .output();

    let mut current_branch = match current_branch_out {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => String::new(),
    };

    // 如果是 detached HEAD，尝试获取 short commit hash
    if current_branch.is_empty() {
        if let Ok(head_out) = create_git_cmd(cwd_ref).args(["rev-parse", "--short", "HEAD"]).output() {
            let hash = String::from_utf8_lossy(&head_out.stdout).trim().to_string();
            if !hash.is_empty() {
                current_branch = format!("HEAD ({hash})");
            }
        }
    }

    // 3. 获取所有本地分支列表
    let branches_out = create_git_cmd(cwd_ref)
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .output();

    let branches = match branches_out {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines()
                .map(|line| line.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        }
        Err(_) => Vec::new(),
    };

    // 4. 获取 remotes
    let remotes_out = create_git_cmd(cwd_ref).args(["remote"]).output();
    let remotes = match remotes_out {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines()
                .map(|line| line.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        }
        Err(_) => Vec::new(),
    };
    let has_remote = !remotes.is_empty();

    // 5. 检查当前分支是否关联了远程上游分支 (upstream tracking branch)
    let upstream_out = create_git_cmd(cwd_ref)
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .output();

    let (has_upstream, upstream_branch) = match upstream_out {
        Ok(out) if out.status.success() => {
            let up_name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !up_name.is_empty() {
                (true, Some(up_name))
            } else {
                (false, None)
            }
        }
        _ => (false, None),
    };

    // 6. 检查是否有未提交的代码修改 (git status --porcelain)
    let status_out = create_git_cmd(cwd_ref)
        .args(["status", "--porcelain"])
        .output();
    let has_changes = match status_out {
        Ok(out) => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        Err(_) => false,
    };

    Ok(GitBranchInfo {
        is_git_repo: true,
        current_branch,
        branches,
        remotes,
        has_upstream,
        has_remote,
        upstream_branch,
        has_changes,
    })
}

/// 初始化 Git 仓库 (git init)
#[tauri::command]
pub fn init_git_repo(cwd: Option<String>) -> Result<(), String> {
    let out = create_git_cmd(cwd.as_deref())
        .args(["init"])
        .output()
        .map_err(|e| format!("执行 git init 失败: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        let err_msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let out_msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let combined = if err_msg.is_empty() { out_msg } else { err_msg };
        Err(if combined.is_empty() { "初始化 Git 仓库失败".to_string() } else { combined })
    }
}

/// 切换分支 (git checkout / git switch)
#[tauri::command]
pub fn switch_git_branch(branch: String, cwd: Option<String>) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空".to_string());
    }

    let out = create_git_cmd(cwd.as_deref())
        .args(["checkout", branch])
        .output()
        .map_err(|e| format!("执行 git checkout 失败: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        let err_msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let out_msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let combined = if err_msg.is_empty() { out_msg } else { err_msg };
        Err(if combined.is_empty() { "切换分支失败".to_string() } else { combined })
    }
}

/// 暂存当前未提交改动并切换到目标分支 (git stash push -> git checkout <branch>)
#[tauri::command]
pub fn stash_and_switch_git_branch(branch: String, cwd: Option<String>) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    let cwd_ref = cwd.as_deref();

    // 1. git stash push
    let stash_msg = format!("AgentDesk 切换分支至 {} 前自动暂存", branch);
    let stash_out = create_git_cmd(cwd_ref)
        .args(["stash", "push", "-m", &stash_msg])
        .output()
        .map_err(|e| format!("执行 git stash 失败: {e}"))?;

    if !stash_out.status.success() {
        let err = String::from_utf8_lossy(&stash_out.stderr).trim().to_string();
        return Err(if err.is_empty() { "暂存本地修改失败".to_string() } else { err });
    }

    // 2. git checkout <branch>
    let checkout_out = create_git_cmd(cwd_ref)
        .args(["checkout", branch])
        .output()
        .map_err(|e| format!("执行 git checkout 失败: {e}"))?;

    if checkout_out.status.success() {
        Ok(format!("已暂存本地改动并成功切换至分支 {}", branch))
    } else {
        let err = String::from_utf8_lossy(&checkout_out.stderr).trim().to_string();
        Err(if err.is_empty() { "切换分支失败".to_string() } else { err })
    }
}

/// 新建并切换到分支 (git checkout -b <name>)
#[tauri::command]
pub fn create_git_branch(branch: String, cwd: Option<String>) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空".to_string());
    }

    // 校验分支名简单合法性
    if branch.contains(' ') || branch.contains("..") || branch.starts_with('-') {
        return Err("分支名称格式不合法".to_string());
    }

    let out = create_git_cmd(cwd.as_deref())
        .args(["checkout", "-b", branch])
        .output()
        .map_err(|e| format!("创建分支失败: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        let err_msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let out_msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let combined = if err_msg.is_empty() { out_msg } else { err_msg };
        Err(if combined.is_empty() { "创建分支失败".to_string() } else { combined })
    }
}

/// 拉取最新更新 (git pull)，并智能识别合并冲突
#[tauri::command]
pub fn pull_git_updates(cwd: Option<String>) -> Result<GitPullResult, String> {
    let cwd_ref = cwd.as_deref();

    // 先拿到当前分支名
    let cur_branch_out = create_git_cmd(cwd_ref)
        .args(["branch", "--show-current"])
        .output();
    let current_branch = match cur_branch_out {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => "unknown".to_string(),
    };

    let out = create_git_cmd(cwd_ref)
        .args(["pull"])
        .output()
        .map_err(|e| format!("执行 git pull 失败: {e}"))?;

    let stdout_text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr_text = String::from_utf8_lossy(&out.stderr).trim().to_string();

    let mut combined_output = String::new();
    if !stdout_text.is_empty() {
        combined_output.push_str(&stdout_text);
    }
    if !stderr_text.is_empty() {
        if !combined_output.is_empty() {
            combined_output.push('\n');
        }
        combined_output.push_str(&stderr_text);
    }

    let success = out.status.success();

    // 冲突或不可自动合并检测
    let conflict_keywords = [
        "CONFLICT",
        "Automatic merge failed",
        "fix conflicts",
        "overwritten by merge",
        "Please commit your changes or stash them",
        "error: Your local changes",
    ];
    let has_conflict = conflict_keywords.iter().any(|k| combined_output.contains(k));
    let summary = parse_pull_summary(&combined_output, success, has_conflict);

    Ok(GitPullResult {
        success,
        output: combined_output,
        summary,
        has_conflict,
        current_branch,
    })
}
