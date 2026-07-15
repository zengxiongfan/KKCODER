//! Git 操作命令集 — 基于 libgit2 + 系统 git CLI。
//!
//! 本地/索引操作走 libgit2（免文件 I/O 触发安全软件弹窗）；
//! 网络操作（push/pull）shell out 系统 git，继承用户凭据/SSH/代理。

use git2::{
    build::CheckoutBuilder, DiffOptions, Repository, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, State};

use crate::git_watcher::GitWatcherBridge;

const _GIT_DIFF_LINE_STATS_STATUS_LIMIT: usize = 500;

// ─────────────────────────── 数据类型 ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub added: i32,
    pub deleted: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub has_upstream: bool,
    pub detached: bool,
    pub pending_op: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub relative_path: String,
    pub absolute_path: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedLine {
    pub side: String,
    pub line_number: u32,
}

/// 分支列表项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchItem {
    /// 短名（例如 "main"、"origin/main"）
    pub name: String,
    /// 完整引用（例如 "refs/heads/main"、"refs/remotes/origin/main"）
    pub full_ref: String,
    /// 是否为远程分支
    pub is_remote: bool,
    /// 是否为当前 HEAD 指向的分支
    pub is_current: bool,
    /// 本地分支上游（如 "origin/main"）；远程分支为 None
    pub upstream: Option<String>,
    /// 相对上游的 ahead / behind（仅本地分支且存在上游时）
    pub ahead: usize,
    pub behind: usize,
    /// 最新一次提交的简要信息
    pub last_commit: Option<GitCommitBrief>,
}

/// 提交简要信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitBrief {
    pub sha: String,
    pub short_sha: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    /// Unix 秒（UTC）
    pub timestamp: i64,
}

/// 提交历史项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitEntry {
    pub sha: String,
    pub short_sha: String,
    pub summary: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
}

/// 单个提交的 diff 统计
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitStat {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

// ─────────────────────────── 辅助函数 ───────────────────────────

fn open_git_repo<P: AsRef<Path>>(path: P) -> Result<Repository, String> {
    let path = path.as_ref();
    Repository::open(path).map_err(|e| format!("打开 Git 仓库失败: {e}"))
}

fn repo_branch_name(repo: &Repository) -> Option<String> {
    repo.head().ok()?.shorthand().map(|s| s.to_string())
}

fn parse_git2_status(status: git2::Status) -> (char, bool) {
    if status.is_conflicted() {
        return ('C', false);
    }
    let _staged = status.is_index_new()
        || status.is_index_modified()
        || status.is_index_deleted()
        || status.is_index_renamed()
        || status.is_index_typechange();
    if status.is_index_new() {
        return ('A', true);
    }
    if status.is_index_modified() || status.is_index_renamed() || status.is_index_typechange() {
        return ('M', true);
    }
    if status.is_index_deleted() {
        return ('D', true);
    }
    if status.is_wt_new() {
        return ('U', false);
    }
    if status.is_wt_modified() || status.is_wt_renamed() || status.is_wt_typechange() {
        return ('M', false);
    }
    if status.is_wt_deleted() {
        return ('D', false);
    }
    ('?', false)
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn should_skip_diff_line_stats(status_count: usize) -> bool {
    status_count > _GIT_DIFF_LINE_STATS_STATUS_LIMIT
}

/// 行数统计上限：单次 diff 遍历最多处理的行数，超过后该文件的 +/- 记为 0（性能兜底）。
const _GIT_DIFF_LINE_STATS_LINE_LIMIT: usize = 200_000;

fn compute_diff_line_stats(repo: &Repository) -> std::collections::HashMap<String, (i32, i32)> {
    let mut stats = std::collections::HashMap::new();
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);

    if let Ok(diff) = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts)) {
        let deltas: Vec<_> = diff.deltas().collect();
        let mut total_lines_seen: usize = 0;
        let mut truncated = false;

        for delta in &deltas {
            if truncated {
                break;
            }

            let path = delta.new_file().path()
                .or_else(|| delta.old_file().path())
                .map(|p| normalize_path(p.to_string_lossy().as_ref()));

            if let Some(path) = path {
                let mut added: i32 = 0;
                let mut deleted: i32 = 0;

                // 为每个文件创建单独的 diff 来统计行数
                let mut file_opts = DiffOptions::new();
                file_opts.pathspec(&path);
                file_opts.context_lines(3);

                if let Ok(file_diff) = repo.diff_tree_to_workdir_with_index(
                    head_tree.as_ref(),
                    Some(&mut file_opts),
                ) {
                    let _ = file_diff.print(git2::DiffFormat::Patch, |_d, _h, l| {
                        match l.origin() {
                            '+' => {
                                total_lines_seen = total_lines_seen.saturating_add(1);
                                if total_lines_seen <= _GIT_DIFF_LINE_STATS_LINE_LIMIT {
                                    added += 1;
                                } else {
                                    truncated = true;
                                }
                            }
                            '-' => {
                                total_lines_seen = total_lines_seen.saturating_add(1);
                                if total_lines_seen <= _GIT_DIFF_LINE_STATS_LINE_LIMIT {
                                    deleted += 1;
                                } else {
                                    truncated = true;
                                }
                            }
                            _ => {}
                        }
                        true
                    });
                }

                if added > 0 || deleted > 0 {
                    stats.insert(path, (added, deleted));
                }
            }
        }
    }
    stats
}

fn is_nested_repo_entry(repo: &Repository, file_path: &str) -> bool {
    if !file_path.ends_with('/') {
        return false;
    }
    let workdir = match repo.workdir() {
        Some(w) => w,
        None => return false,
    };
    let full = workdir.join(file_path.trim_end_matches('/'));
    full.join(".git").exists()
}

fn scan_sub_repositories(
    dir: &Path,
    prefix: &str,
    depth: u32,
    max_depth: u32,
    out: &mut Vec<(String, std::path::PathBuf)>,
) {
    if depth >= max_depth {
        return;
    }
    let entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(it) => it.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" || name == "build" {
            continue;
        }
        let child = entry.path();
        if !child.is_dir() {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if child.join(".git").exists() {
            out.push((rel, child));
        } else {
            scan_sub_repositories(&child, &rel, depth + 1, max_depth, out);
        }
    }
}

fn scan_git_repository_paths(root: &Path, max_depth: u32) -> Vec<(String, std::path::PathBuf)> {
    let mut out: Vec<(String, std::path::PathBuf)> = Vec::new();
    if root.join(".git").exists() {
        out.push((String::new(), root.to_path_buf()));
    }
    scan_sub_repositories(root, "", 0, max_depth, &mut out);
    out
}

fn validate_repo_relative_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("empty_path".into());
    }
    if p.contains("..") {
        return Err("path_escape".into());
    }
    if p.starts_with('/') || p.starts_with('\\') {
        return Err("absolute_path".into());
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return Err("absolute_path".into());
    }
    Ok(())
}

fn map_git_cli_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    let code = if s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("permission denied")
        || s.contains("invalid username or password")
    {
        "auth_failed"
    } else if s.contains("non-fast-forward")
        || s.contains("fetch first")
        || s.contains("updates were rejected")
        || s.contains("[rejected]")
        || s.contains("not possible to fast-forward")
        || s.contains("diverging")
        || s.contains("divergent")
    {
        "not_fast_forward"
    } else if s.contains("no upstream") || s.contains("has no upstream") {
        "no_upstream"
    } else if s.contains("could not read from remote")
        || s.contains("does not appear to be a git repository")
        || s.contains("no configured push destination")
        || s.contains("no such remote")
        || s.contains("'origin' does not appear")
    {
        "no_remote"
    } else {
        "git_failed"
    };
    let snippet: String = stderr.trim().chars().take(300).collect();
    format!("{code}: {snippet}")
}

fn run_git_cli(project_path: &str, args: &[&str]) -> Result<String, String> {
    let path = Path::new(project_path);
    if !path.exists() {
        return Err("path_not_found".to_string());
    }
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(path).args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("spawn_failed: {e}")
        }
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(map_git_cli_error(&stderr))
    }
}

fn run_git_conflict_aware(project_path: &str, args: &[&str]) -> Result<String, String> {
    let path = Path::new(project_path);
    if !path.exists() {
        return Err("path_not_found".to_string());
    }
    let output = std::process::Command::new("git")
        .current_dir(path)
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git_not_found".to_string()
            } else {
                format!("spawn_failed: {e}")
            }
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        return Ok(format!("{stdout}{stderr}").trim().to_string());
    }
    let combined = format!("{stdout}\n{stderr}").to_lowercase();
    if combined.contains("conflict")
        || combined.contains("automatic merge failed")
        || combined.contains("could not apply")
        || combined.contains("needs merge")
        || combined.contains("fix conflicts")
    {
        let snippet: String = format!("{stdout}{stderr}").trim().chars().take(300).collect();
        return Err(format!("pull_conflict: {snippet}"));
    }
    Err(map_git_cli_error(&stderr))
}

fn validate_branch_name(branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Err("empty_branch".into());
    }
    if branch.starts_with('-') {
        return Err("invalid_branch".into());
    }
    if branch.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("invalid_branch".into());
    }
    Ok(())
}

// ─────────────────────────── Diff 辅助 ───────────────────────────

fn parse_hunk_header(header: &str) -> Result<(u32, u32, u32, u32, String), String> {
    let body = header.strip_prefix("@@ ").ok_or("bad_hunk_header")?;
    let close = body.find(" @@").ok_or("bad_hunk_header")?;
    let ranges = &body[..close];
    let heading = body[close + 3..].to_string();
    let mut parts = ranges.split(' ');
    let old_part = parts.next().ok_or("bad_hunk_header")?;
    let new_part = parts.next().ok_or("bad_hunk_header")?;
    let (old_start, old_count) = parse_range(old_part.strip_prefix('-').ok_or("bad_hunk_header")?)?;
    let (new_start, new_count) = parse_range(new_part.strip_prefix('+').ok_or("bad_hunk_header")?)?;
    Ok((old_start, old_count, new_start, new_count, heading))
}

fn parse_range(s: &str) -> Result<(u32, u32), String> {
    if let Some((start, count)) = s.split_once(',') {
        Ok((
            start.parse().map_err(|_| "bad_range")?,
            count.parse().map_err(|_| "bad_range")?,
        ))
    } else {
        Ok((s.parse().map_err(|_| "bad_range")?, 1))
    }
}

fn reverse_hunk(hunk: &[&str]) -> Result<Vec<String>, String> {
    let header = *hunk.first().ok_or("empty_hunk")?;
    let header_clean = header.trim_end_matches('\r');
    let (old_start, old_count, new_start, new_count, heading) = parse_hunk_header(header_clean)?;
    let new_header = format!(
        "@@ -{},{} +{},{} @@{}",
        new_start, new_count, old_start, old_count, heading
    );
    let mut out = vec![new_header];
    for &line in &hunk[1..] {
        if line.is_empty() {
            out.push(String::new());
            continue;
        }
        let first = line.as_bytes()[0];
        let rest = &line[1..];
        let reversed = match first {
            b'+' => format!("-{rest}"),
            b'-' => format!("+{rest}"),
            _ => line.to_string(),
        };
        out.push(reversed);
    }
    Ok(out)
}

fn build_reverse_hunk_patch(diff_text: &str, hunk_index: usize) -> Result<String, String> {
    let lines: Vec<&str> = diff_text.split('\n').collect();
    let mut header: Vec<&str> = Vec::new();
    let mut idx = 0;
    while idx < lines.len() && !lines[idx].starts_with("@@") {
        header.push(lines[idx]);
        idx += 1;
    }
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    while idx < lines.len() {
        let line = lines[idx];
        if line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            current = Some(vec![line]);
        } else if let Some(h) = current.as_mut() {
            h.push(line);
        }
        idx += 1;
    }
    if let Some(h) = current.take() {
        hunks.push(h);
    }
    if hunk_index >= hunks.len() {
        return Err(format!("hunk_index_out_of_range:{}:{}", hunk_index, hunks.len()));
    }
    let reversed = reverse_hunk(&hunks[hunk_index])?;
    let mut out: Vec<String> = header.iter().map(|s| s.to_string()).collect();
    out.extend(reversed);
    let mut result = out.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

fn build_reverse_lines_patch(diff_text: &str, selected: &[(String, u32)]) -> Result<String, String> {
    let lines: Vec<&str> = diff_text.split('\n').collect();
    let mut header: Vec<&str> = Vec::new();
    let mut idx = 0;
    while idx < lines.len() && !lines[idx].starts_with("@@") {
        header.push(lines[idx]);
        idx += 1;
    }
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    while idx < lines.len() {
        let line = lines[idx];
        if line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            current = Some(vec![line]);
        } else if let Some(h) = current.as_mut() {
            h.push(line);
        }
        idx += 1;
    }
    if let Some(h) = current.take() {
        hunks.push(h);
    }

    let mut out: Vec<String> = header.iter().map(|s| s.to_string()).collect();
    for (hunk_idx, hunk) in hunks.iter().enumerate() {
        let h = *hunk.first().ok_or("empty_hunk")?;
        let h_clean = h.trim_end_matches('\r');
        let (old_start, old_count, new_start, new_count, heading) = parse_hunk_header(h_clean)?;

        let mut new_lines: Vec<String> = Vec::new();
        let mut old_line = old_start;
        let mut new_line = new_start;

        for line in &hunk[1..] {
            if line.is_empty() {
                new_lines.push(String::new());
                continue;
            }
            let first = line.as_bytes()[0];
            let rest = &line[1..];
            match first {
                b'+' => {
                    let is_selected = selected.iter().any(|(s, n)| s == "add" && *n == new_line);
                    if is_selected {
                        new_lines.push(format!("-{rest}"));
                    } else {
                        new_lines.push(line.to_string());
                    }
                    new_line += 1;
                }
                b'-' => {
                    let is_selected = selected.iter().any(|(s, n)| s == "del" && *n == old_line);
                    if is_selected {
                        new_lines.push(format!("+{rest}"));
                    } else {
                        new_lines.push(line.to_string());
                    }
                    old_line += 1;
                }
                _ => {
                    new_lines.push(line.to_string());
                    old_line += 1;
                    new_line += 1;
                }
            }
        }

        let new_header = format!(
            "@@ -{},{} +{},{} @@{}",
            new_start, new_count, old_start, old_count, heading
        );
        out.push(new_header);
        out.extend(new_lines);
        if hunk_idx < hunks.len() - 1 {
            out.push(String::new());
        }
    }
    let mut result = out.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

fn apply_patch_to_repo(repo: &Repository, reverse_patch: &str) -> Result<(), String> {
    let diff = git2::Diff::from_buffer(reverse_patch.as_bytes())
        .map_err(|e| format!("parse_patch_failed: {e}"))?;
    let mut check_opts = git2::ApplyOptions::new();
    check_opts.check(true);
    repo.apply(&diff, git2::ApplyLocation::WorkDir, Some(&mut check_opts))
        .map_err(|_| "patch_conflict_refresh_needed".to_string())?;
    repo.apply(&diff, git2::ApplyLocation::WorkDir, None)
        .map_err(|e| format!("apply_failed: {e}"))?;
    Ok(())
}

fn apply_patch_to_workdir(project_path: &str, reverse_patch: &str) -> Result<(), String> {
    let path = Path::new(project_path);
    if !path.exists() {
        return Err("path_not_found".to_string());
    }
    let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
    apply_patch_to_repo(&repo, reverse_patch)
}

fn format_diff_to_text(diff: git2::Diff, file_path: &str) -> Result<String, String> {
    let patch_text = format_diff_to_text_allow_empty(diff)?;
    if patch_text.is_empty() {
        return Err(format!("文件 {file_path} 无变更"));
    }
    Ok(patch_text)
}

fn format_diff_to_text_allow_empty(diff: git2::Diff) -> Result<String, String> {
    let mut patch_text = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' | '-' | ' ' => patch_text.push(line.origin()),
            _ => {}
        }
        patch_text.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| format!("打印 diff 失败: {e}"))?;
    Ok(patch_text)
}

// ─────────────────────────── Tauri 命令 ───────────────────────────

/// 查询当前分支名
#[tauri::command]
pub async fn get_current_git_branch(path: String) -> Result<Option<String>, String> {
    if path.is_empty() {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || {
        if !Path::new(&path).exists() {
            return Ok(None);
        }
        let repo = match open_git_repo(&path) {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        let head = match repo.head() {
            Ok(h) => h,
            Err(_) => return Ok(None),
        };
        Ok(head.shorthand().map(|s| s.to_string()))
    })
    .await
    .map_err(|e| format!("git 分支查询任务失败: {e}"))?
}

/// 获取 Git 文件变更列表
#[tauri::command]
pub async fn git_get_changes(project_path: String) -> Result<Vec<GitFileChange>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err(format!("路径不存在: {project_path}"));
        }
        let repo = open_git_repo(path).map_err(|e| format!("不是 Git 仓库: {e}"))?;

        let mut opts = StatusOptions::new();
        opts.include_untracked(true);
        opts.recurse_untracked_dirs(true);

        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| format!("获取 Git 状态失败: {e}"))?;

        let skipped_line_stats = should_skip_diff_line_stats(statuses.len());
        let stats = if skipped_line_stats {
            std::collections::HashMap::new()
        } else {
            compute_diff_line_stats(&repo)
        };

        let mut changes = Vec::new();
        for entry in statuses.iter() {
            let status = entry.status();
            let file_path = entry.path().unwrap_or("").to_string();
            if file_path.is_empty() {
                continue;
            }
            if is_nested_repo_entry(&repo, &file_path) {
                continue;
            }
            let (status_char, staged) = parse_git2_status(status);
            let (added, deleted) = stats
                .get(&normalize_path(&file_path))
                .copied()
                .unwrap_or((0, 0));
            changes.push(GitFileChange {
                path: file_path,
                status: status_char.to_string(),
                staged,
                added,
                deleted,
            });
        }
        Ok(changes)
    })
    .await
    .map_err(|e| format!("Git 变更查询任务失败: {e}"))?
}

/// 获取文件 diff
#[tauri::command]
pub async fn git_get_file_diff(
    project_path: String,
    file_path: String,
    status: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err(format!("路径不存在: {project_path}"));
        }
        let repo = Repository::open(path).map_err(|e| format!("打开仓库失败: {e}"))?;

        match status.as_str() {
            "U" | "??" => {
                let file_full_path = path.join(&file_path);
                if file_full_path.is_dir() {
                    return Err("该条目是目录，无法显示文件 diff".to_string());
                }
                let content = std::fs::read_to_string(&file_full_path)
                    .map_err(|e| format!("读取文件失败: {e}"))?;
                let lines = content.lines().collect::<Vec<_>>();
                let mut diff_text = format!("diff --git a/{} b/{}\n", file_path, file_path);
                diff_text.push_str("new file mode 100644\n");
                diff_text.push_str("--- /dev/null\n");
                diff_text.push_str(&format!("+++ b/{}\n", file_path));
                diff_text.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
                for line in lines {
                    diff_text.push('+');
                    diff_text.push_str(line);
                    diff_text.push('\n');
                }
                Ok(diff_text)
            }
            "D" => {
                let head = repo.head().map_err(|e| format!("获取 HEAD 失败: {e}"))?;
                let head_tree = head.peel_to_tree().map_err(|e| format!("获取 HEAD tree 失败: {e}"))?;
                let mut diff_opts = DiffOptions::new();
                diff_opts.pathspec(&file_path);
                diff_opts.context_lines(3);
                let diff = repo
                    .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut diff_opts))
                    .map_err(|e| format!("生成 diff 失败: {e}"))?;
                format_diff_to_text(diff, &file_path)
            }
            _ => {
                let head = repo.head().map_err(|e| format!("获取 HEAD 失败: {e}"))?;
                let head_tree = head.peel_to_tree().map_err(|e| format!("获取 HEAD tree 失败: {e}"))?;
                let mut diff_opts = DiffOptions::new();
                diff_opts.pathspec(&file_path);
                diff_opts.context_lines(3);
                let diff = repo
                    .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut diff_opts))
                    .map_err(|e| format!("生成 diff 失败: {e}"))?;
                format_diff_to_text(diff, &file_path)
            }
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 丢弃单个文件改动
#[tauri::command]
pub async fn git_discard_file(
    project_path: String,
    file_path: String,
    status: String,
) -> Result<(), String> {
    validate_repo_relative_path(&file_path)?;
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        match status.as_str() {
            "U" | "??" => Err("untracked_not_supported".to_string()),
            "A" => {
                let head_commit = repo
                    .head()
                    .and_then(|h| h.peel_to_commit())
                    .map_err(|e| format!("head_failed: {e}"))?;
                repo.reset_default(Some(head_commit.as_object()), [file_path.as_str()])
                    .map_err(|e| format!("unstage_failed: {e}"))?;
                Ok(())
            }
            _ => {
                if let Ok(commit) = repo.head().and_then(|h| h.peel_to_commit()) {
                    let _ = repo.reset_default(Some(commit.as_object()), [file_path.as_str()]);
                }
                let mut cb = CheckoutBuilder::new();
                cb.force();
                cb.path(file_path.as_str());
                repo.checkout_head(Some(&mut cb))
                    .map_err(|e| format!("checkout_failed: {e}"))?;
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 回滚单个 hunk
#[tauri::command]
pub async fn git_revert_hunk(
    project_path: String,
    diff_text: String,
    hunk_index: usize,
) -> Result<(), String> {
    let reverse_patch = build_reverse_hunk_patch(&diff_text, hunk_index)?;
    tokio::task::spawn_blocking(move || apply_patch_to_workdir(&project_path, &reverse_patch))
        .await
        .map_err(|e| format!("task_failed: {e}"))?
}

/// 回滚选中的行
#[tauri::command]
pub async fn git_revert_lines(
    project_path: String,
    diff_text: String,
    selected_lines: Vec<SelectedLine>,
) -> Result<(), String> {
    if selected_lines.is_empty() {
        return Err("no_lines_selected".to_string());
    }
    let sel: Vec<(String, u32)> = selected_lines
        .into_iter()
        .map(|s| (s.side, s.line_number))
        .collect();
    let reverse_patch = build_reverse_lines_patch(&diff_text, &sel)?;
    tokio::task::spawn_blocking(move || apply_patch_to_workdir(&project_path, &reverse_patch))
        .await
        .map_err(|e| format!("task_failed: {e}"))?
}

/// 暂存单个文件
#[tauri::command]
pub async fn git_stage_file(project_path: String, file_path: String) -> Result<(), String> {
    validate_repo_relative_path(&file_path)?;
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        let rel = Path::new(&file_path);
        if path.join(&file_path).exists() {
            index.add_path(rel).map_err(|e| format!("stage_failed: {e}"))?;
        } else {
            index.remove_path(rel).map_err(|e| format!("stage_remove_failed: {e}"))?;
        }
        index.write().map_err(|e| format!("index_write_failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 取消暂存单个文件
#[tauri::command]
pub async fn git_unstage_file(project_path: String, file_path: String) -> Result<(), String> {
    validate_repo_relative_path(&file_path)?;
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = Repository::open(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        match repo.head().and_then(|h| h.peel_to_commit()) {
            Ok(commit) => {
                repo.reset_default(Some(commit.as_object()), [file_path.as_str()])
                    .map_err(|e| format!("unstage_failed: {e}"))?;
            }
            Err(_) => {
                let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
                index.remove_path(Path::new(&file_path))
                    .map_err(|e| format!("unstage_remove_failed: {e}"))?;
                index.write().map_err(|e| format!("index_write_failed: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 全部暂存
#[tauri::command]
pub async fn git_stage_all(project_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = Repository::open(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        index.add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("stage_all_failed: {e}"))?;
        index.update_all(["*"], None)
            .map_err(|e| format!("stage_all_update_failed: {e}"))?;
        index.write().map_err(|e| format!("index_write_failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 全部取消暂存
#[tauri::command]
pub async fn git_unstage_all(project_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = Repository::open(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        match repo.head().and_then(|h| h.peel_to_commit()) {
            Ok(commit) => {
                let tree = commit.tree().map_err(|e| format!("tree_failed: {e}"))?;
                let reset_result = repo.reset_default(Some(tree.as_object()), ["."]);
                if reset_result.is_err() {
                    let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
                    index.read(true).map_err(|e| format!("index_read_failed: {e}"))?;
                    index.write().map_err(|e| format!("index_write_failed: {e}"))?;
                    repo.reset_default(Some(commit.as_object()), ["*"])
                        .map_err(|e| format!("unstage_all_failed: {e}"))?;
                }
            }
            Err(_) => {
                let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
                index.clear().map_err(|e| format!("index_clear_failed: {e}"))?;
                index.write().map_err(|e| format!("index_write_failed: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 批量暂存
#[tauri::command]
pub async fn git_stage_paths(project_path: String, paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        validate_repo_relative_path(p)?;
    }
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = Repository::open(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        for file_path in &paths {
            let rel = Path::new(file_path);
            if path.join(file_path).exists() {
                let _ = index.add_path(rel);
            } else {
                let _ = index.remove_path(rel);
            }
        }
        index.write().map_err(|e| format!("index_write_failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 批量取消暂存
#[tauri::command]
pub async fn git_unstage_paths(project_path: String, paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        validate_repo_relative_path(p)?;
    }
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = Repository::open(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        match repo.head().and_then(|h| h.peel_to_commit()) {
            Ok(commit) => {
                repo.reset_default(Some(commit.as_object()), paths.iter().map(|s| s.as_str()).collect::<Vec<_>>().as_slice())
                    .map_err(|e| format!("unstage_paths_failed: {e}"))?;
            }
            Err(_) => {
                let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
                for file_path in &paths {
                    let _ = index.remove_path(Path::new(file_path));
                }
                index.write().map_err(|e| format!("index_write_failed: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 提交（全量 index）
#[tauri::command]
pub async fn git_commit(project_path: String, message: String) -> Result<String, String> {
    let msg = message.trim().to_string();
    if msg.is_empty() {
        return Err("empty_message".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = Repository::open(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let mut index = repo.index().map_err(|e| format!("index_failed: {e}"))?;
        let tree_oid = index.write_tree().map_err(|e| format!("write_tree_failed: {e}"))?;
        let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        match &head_commit {
            Some(c) => {
                let head_tree_oid = c.tree().map_err(|e| format!("head_tree_failed: {e}"))?.id();
                if head_tree_oid == tree_oid {
                    return Err("nothing_staged".to_string());
                }
            }
            None => {
                if index.is_empty() {
                    return Err("nothing_staged".to_string());
                }
            }
        }
        let tree = repo.find_tree(tree_oid).map_err(|e| format!("find_tree_failed: {e}"))?;
        let sig = repo.signature().map_err(|_| "no_git_identity".to_string())?;
        let parents: Vec<&git2::Commit> = head_commit.as_ref().map(|c| vec![c]).unwrap_or_default();
        let oid = repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parents)
            .map_err(|e| format!("commit_failed: {e}"))?;
        Ok(oid.to_string().chars().take(7).collect::<String>())
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 仅提交指定路径
#[tauri::command]
pub async fn git_commit_paths(
    project_path: String,
    message: String,
    paths: Vec<String>,
) -> Result<String, String> {
    let msg = message.trim().to_string();
    if msg.is_empty() {
        return Err("empty_message".to_string());
    }
    if paths.is_empty() {
        return Err("nothing_staged".to_string());
    }
    for p in &paths {
        validate_repo_relative_path(p)?;
    }
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["commit", "-m", &msg, "--"];
        for p in &paths {
            args.push(p.as_str());
        }
        match run_git_cli(&project_path, &args) {
            Ok(_) => run_git_cli(&project_path, &["rev-parse", "--short", "HEAD"]),
            Err(e) => {
                let low = e.to_lowercase();
                if low.contains("who you are") || low.contains("identity") || low.contains("user.email") {
                    Err("no_git_identity".to_string())
                } else if low.contains("nothing to commit") || low.contains("no changes added") {
                    Err("nothing_staged".to_string())
                } else {
                    Err(e)
                }
            }
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 查询分支状态
#[tauri::command]
pub async fn git_branch_status(project_path: String) -> Result<GitBranchStatus, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;

        let pending_op = match repo.state() {
            git2::RepositoryState::Merge => Some("merge".to_string()),
            git2::RepositoryState::Rebase
            | git2::RepositoryState::RebaseInteractive
            | git2::RepositoryState::RebaseMerge => Some("rebase".to_string()),
            _ => None,
        };

        let empty = GitBranchStatus {
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            has_upstream: false,
            detached: false,
            pending_op: pending_op.clone(),
        };

        let head = match repo.head() {
            Ok(h) => h,
            Err(_) => return Ok(empty),
        };

        let detached = repo.head_detached().unwrap_or(false);
        let branch = head.shorthand().map(|s| s.to_string());
        let local_oid = head.target();

        if detached {
            return Ok(GitBranchStatus {
                branch: None,
                detached: true,
                ..empty
            });
        }

        let mut upstream = None;
        let mut ahead = 0usize;
        let mut behind = 0usize;
        let mut has_upstream = false;

        if let Some(shorthand) = head.shorthand() {
            if let Ok(local_branch) = repo.find_branch(shorthand, git2::BranchType::Local) {
                if let Ok(up) = local_branch.upstream() {
                    has_upstream = true;
                    if let Ok(Some(name)) = up.name() {
                        upstream = Some(name.to_string());
                    }
                    if let (Some(local), Some(up_oid)) = (local_oid, up.get().target()) {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local, up_oid) {
                            ahead = a;
                            behind = b;
                        }
                    }
                }
            }
        }

        Ok(GitBranchStatus {
            branch,
            upstream,
            ahead,
            behind,
            has_upstream,
            detached: false,
            pending_op,
        })
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 推送
#[tauri::command]
pub async fn git_push(
    project_path: String,
    set_upstream: bool,
    branch: Option<String>,
) -> Result<String, String> {
    if set_upstream {
        let b = branch.clone().ok_or_else(|| "empty_branch".to_string())?;
        validate_branch_name(&b)?;
    }
    tokio::task::spawn_blocking(move || {
        if set_upstream {
            let b = branch.unwrap();
            run_git_cli(&project_path, &["push", "-u", "origin", &b])
        } else {
            run_git_cli(&project_path, &["push"])
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

fn pull_args(strategy: &str) -> Result<Vec<&'static str>, String> {
    match strategy {
        "merge" => Ok(vec!["pull", "--no-rebase", "--no-edit", "--autostash"]),
        "rebase" => Ok(vec!["pull", "--rebase", "--autostash"]),
        "ff-only" => Ok(vec!["pull", "--ff-only"]),
        _ => Err("invalid_strategy".to_string()),
    }
}

/// 拉取
#[tauri::command]
pub async fn git_pull(project_path: String, strategy: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let args = pull_args(&strategy)?;
        run_git_conflict_aware(&project_path, &args)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 中止合并/变基
#[tauri::command]
pub async fn git_pull_abort(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let rebasing = {
            let repo = Repository::open(path).map_err(|e| format!("open_repo_failed: {e}"))?;
            matches!(
                repo.state(),
                git2::RepositoryState::Rebase
                    | git2::RepositoryState::RebaseInteractive
                    | git2::RepositoryState::RebaseMerge
            )
        };
        let args: &[&str] = if rebasing {
            &["rebase", "--abort"]
        } else {
            &["merge", "--abort"]
        };
        run_git_cli(&project_path, args)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 继续变基
#[tauri::command]
pub async fn git_rebase_continue(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_git_conflict_aware(&project_path, &["-c", "core.editor=true", "rebase", "--continue"])
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 枚举项目下的 Git 仓库
#[tauri::command]
pub async fn git_list_repositories(project_path: String) -> Result<Vec<GitRepoInfo>, String> {
    tokio::task::spawn_blocking(move || {
        if project_path.is_empty() {
            return Err("路径不存在: (空)".to_string());
        }
        let root = Path::new(&project_path);
        if !root.exists() {
            return Err(format!("路径不存在: {project_path}"));
        }
        if !root.is_dir() {
            return Err(format!("路径不是目录: {project_path}"));
        }
        let repos = scan_git_repository_paths(root, 3)
            .into_iter()
            .map(|(relative_path, absolute_path)| {
                let branch = open_git_repo(&absolute_path)
                    .ok()
                    .and_then(|repo| repo_branch_name(&repo));
                GitRepoInfo {
                    relative_path,
                    absolute_path: absolute_path.to_string_lossy().to_string(),
                    branch,
                }
            })
            .collect();
        Ok(repos)
    })
    .await
    .map_err(|e| format!("Git 仓库扫描任务失败: {e}"))?
}

/// 开始监听项目目录文件变化
#[tauri::command]
pub async fn git_watch_start(
    app: AppHandle,
    bridge: State<'_, GitWatcherBridge>,
    project_path: String,
) -> Result<(), String> {
    bridge.start(app, project_path)
}

/// 停止监听
#[tauri::command]
pub async fn git_watch_stop(bridge: State<'_, GitWatcherBridge>) -> Result<(), String> {
    bridge.stop()
}

// ────────────────────────── 分支列表与提交历史 ──────────────────────────

/// 将 git2::Commit 转为 GitCommitBrief
fn commit_to_brief(commit: &git2::Commit<'_>) -> GitCommitBrief {
    let sha = commit.id().to_string();
    let short_sha = sha.chars().take(7).collect::<String>();
    let summary = commit.summary().unwrap_or("").to_string();
    let author = commit.author();
    GitCommitBrief {
        sha,
        short_sha,
        summary,
        author: author.name().unwrap_or("").to_string(),
        email: author.email().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
    }
}

/// 列出仓库所有本地与远程分支
#[tauri::command]
pub async fn git_list_branches(project_path: String) -> Result<Vec<GitBranchItem>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;

        // 当前 HEAD 指向的本地分支名（detached 时为 None）
        let current_branch = if repo.head_detached().unwrap_or(false) {
            None
        } else {
            repo.head().ok().and_then(|h| h.shorthand().map(|s| s.to_string()))
        };

        let mut items: Vec<GitBranchItem> = Vec::new();

        let branches_iter = repo
            .branches(None)
            .map_err(|e| format!("list_branches_failed: {e}"))?;

        for br in branches_iter.flatten() {
            let (branch, bt) = br;
            let is_remote = matches!(bt, git2::BranchType::Remote);

            // 短名（例如 "main" 或 "origin/main"）
            let name = match branch.name() {
                Ok(Some(n)) => n.to_string(),
                _ => continue,
            };

            // 跳过 origin/HEAD 伪引用
            if is_remote && name.ends_with("/HEAD") {
                continue;
            }

            let reference = branch.get();
            let full_ref = reference.name().unwrap_or("").to_string();

            let is_current = !is_remote
                && current_branch.as_deref() == Some(name.as_str());

            // 上游与 ahead/behind
            let mut upstream: Option<String> = None;
            let mut ahead = 0usize;
            let mut behind = 0usize;
            if !is_remote {
                if let Ok(up) = branch.upstream() {
                    if let Ok(Some(up_name)) = up.name() {
                        upstream = Some(up_name.to_string());
                    }
                    if let (Some(local_oid), Some(up_oid)) =
                        (reference.target(), up.get().target())
                    {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
                            ahead = a;
                            behind = b;
                        }
                    }
                }
            }

            // 最新提交
            let last_commit = reference
                .peel_to_commit()
                .ok()
                .map(|c| commit_to_brief(&c));

            items.push(GitBranchItem {
                name,
                full_ref,
                is_remote,
                is_current,
                upstream,
                ahead,
                behind,
                last_commit,
            });
        }

        // 排序：本地在前，当前分支置顶；其余按最新提交时间倒序
        items.sort_by(|a, b| {
            match (a.is_remote, b.is_remote) {
                (false, true) => std::cmp::Ordering::Less,
                (true, false) => std::cmp::Ordering::Greater,
                _ => {
                    if a.is_current != b.is_current {
                        return if a.is_current {
                            std::cmp::Ordering::Less
                        } else {
                            std::cmp::Ordering::Greater
                        };
                    }
                    let ta = a.last_commit.as_ref().map(|c| c.timestamp).unwrap_or(0);
                    let tb = b.last_commit.as_ref().map(|c| c.timestamp).unwrap_or(0);
                    tb.cmp(&ta)
                }
            }
        });

        Ok(items)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 获取指定分支（或引用）的提交历史
///
/// - `branch_ref`：完整引用（如 "refs/heads/main"、"refs/remotes/origin/main"）或短名
/// - `limit`：每次获取的最大数量（默认 100，上限 500）
/// - `skip`：跳过前 N 个提交（分页用，默认 0）
#[tauri::command]
pub async fn git_list_branch_commits(
    project_path: String,
    branch_ref: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommitEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;

        // 解析引用→commit oid
        let obj = repo
            .revparse_single(&branch_ref)
            .map_err(|e| format!("revparse_failed: {e}"))?;
        let start_oid = obj
            .peel_to_commit()
            .map_err(|e| format!("peel_commit_failed: {e}"))?
            .id();

        let mut revwalk = repo
            .revwalk()
            .map_err(|e| format!("revwalk_failed: {e}"))?;
        revwalk
            .push(start_oid)
            .map_err(|e| format!("revwalk_push_failed: {e}"))?;
        revwalk
            .set_sorting(git2::Sort::TIME)
            .map_err(|e| format!("revwalk_sort_failed: {e}"))?;

        let cap = limit.unwrap_or(100).min(500) as usize;
        let skip_n = skip.unwrap_or(0) as usize;
        let mut out: Vec<GitCommitEntry> = Vec::with_capacity(cap);

        for (idx, oid_res) in revwalk.enumerate() {
            if idx < skip_n {
                continue;
            }
            if out.len() >= cap {
                break;
            }
            let oid = match oid_res {
                Ok(o) => o,
                Err(_) => continue,
            };
            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let sha = commit.id().to_string();
            let short_sha = sha.chars().take(7).collect::<String>();
            let summary = commit.summary().unwrap_or("").to_string();
            let body = commit.body().unwrap_or("").to_string();
            let author = commit.author();
            let parents: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();
            out.push(GitCommitEntry {
                sha,
                short_sha,
                summary,
                body,
                author: author.name().unwrap_or("").to_string(),
                email: author.email().unwrap_or("").to_string(),
                timestamp: commit.time().seconds(),
                parents,
            });
        }

        Ok(out)
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 获取单个提交的 diff 统计（与父提交对比；首提交与空树对比）
#[tauri::command]
pub async fn git_commit_stat(project_path: String, sha: String) -> Result<GitCommitStat, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&project_path);
        if !path.exists() {
            return Err("path_not_found".to_string());
        }
        let repo = open_git_repo(path).map_err(|e| format!("open_repo_failed: {e}"))?;
        let oid = git2::Oid::from_str(&sha).map_err(|_| "invalid_sha".to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| format!("find_commit_failed: {e}"))?;

        let commit_tree = commit.tree().map_err(|e| format!("tree_failed: {e}"))?;
        let parent_tree = if commit.parent_count() > 0 {
            let parent = commit.parent(0).map_err(|e| format!("parent_failed: {e}"))?;
            Some(parent.tree().map_err(|e| format!("parent_tree_failed: {e}"))?)
        } else {
            None
        };

        let mut opts = DiffOptions::new();
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts))
            .map_err(|e| format!("diff_failed: {e}"))?;

        let stats = diff.stats().map_err(|e| format!("stats_failed: {e}"))?;
        Ok(GitCommitStat {
            files_changed: stats.files_changed(),
            insertions: stats.insertions(),
            deletions: stats.deletions(),
        })
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}

/// 切换到指定分支（避开工作区写入潜在风险，直接 shell out git）
///
/// - 本地分支：`git checkout <name>`
/// - 远程分支：`git checkout --track <origin/branch>`（自动创建同名本地分支）
#[tauri::command]
pub async fn git_checkout_branch(
    project_path: String,
    branch: String,
    is_remote: bool,
) -> Result<String, String> {
    validate_branch_name(&branch)?;
    tokio::task::spawn_blocking(move || {
        if is_remote {
            // 推导本地名：去掉前缀 "remote/"
            let local_name = branch
                .split_once('/')
                .map(|(_, rest)| rest)
                .unwrap_or(&branch);
            // 若同名本地分支已存在 → 直接切换；否则创建跟踪分支
            match run_git_cli(&project_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{local_name}")]) {
                Ok(_) => run_git_cli(&project_path, &["checkout", local_name]),
                Err(_) => run_git_cli(&project_path, &["checkout", "--track", &branch]),
            }
        } else {
            run_git_cli(&project_path, &["checkout", &branch])
        }
    })
    .await
    .map_err(|e| format!("task_failed: {e}"))?
}
