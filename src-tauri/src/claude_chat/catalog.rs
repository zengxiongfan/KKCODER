use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_FILE_RESULTS: usize = 80;
const MAX_CATALOG_ENTRIES: usize = 500;
const MAX_SCAN_DEPTH: usize = 8;
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "venv",
    ".venv",
];

/// Claude Code 内置 slash 命令：优先展示，描述对齐 desktop-cc-gui 并中文化。
/// 用户自定义同名命令不覆盖内置。
const BUILTIN_COMMANDS: &[(&str, &str)] = &[
    ("clear", "清空当前对话的历史记录，重新开始"),
    ("new", "开启一个新的对话会话"),
    ("status", "查看当前会话的执行状态"),
    ("context", "查看上下文占用与模型信息"),
    ("resume", "恢复之前的 Claude 会话继续对话"),
    ("review", "让 Claude 审查当前分支的代码变更"),
    ("fork", "从当前对话创建一个新的分支会话"),
    ("export", "导出当前对话历史"),
    ("import", "导入一段对话历史继续"),
    ("share", "生成当前对话的分享链接"),
    ("compact", "压缩对话历史以释放上下文空间"),
    ("mcp", "管理 MCP 服务器"),
    ("init", "初始化项目的 CLAUDE.md 配置"),
    ("help", "查看可用的命令与帮助"),
    ("cost", "查看当前会话的 token 花费"),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompletionEntry {
    kind: String,
    name: String,
    description: Option<String>,
    source: String,
    path: Option<String>,
    is_dir: bool,
}

#[tauri::command]
pub fn chat_search_project_entries(
    directory: String,
    query: String,
) -> Result<Vec<CompletionEntry>, String> {
    let root = PathBuf::from(directory);
    if !root.is_dir() {
        return Err("项目目录不存在".to_string());
    }
    let query = query.trim().replace('\\', "/").to_ascii_lowercase();
    let mut matches = Vec::new();
    scan_project_entries(&root, &root, &query, 0, &mut matches);
    matches.sort_by(|left, right| {
        let left_path = left.path.as_deref().unwrap_or("");
        let right_path = right.path.as_deref().unwrap_or("");
        let left_exact = left_path.to_ascii_lowercase() == query;
        let right_exact = right_path.to_ascii_lowercase() == query;
        right_exact
            .cmp(&left_exact)
            .then_with(|| left.is_dir.cmp(&right.is_dir))
            .then_with(|| left_path.len().cmp(&right_path.len()))
            .then_with(|| left_path.cmp(right_path))
    });
    matches.truncate(MAX_FILE_RESULTS);
    Ok(matches)
}

#[tauri::command]
pub fn chat_get_slash_items(directory: String) -> Result<Vec<CompletionEntry>, String> {
    let project = PathBuf::from(directory);
    if !project.is_dir() {
        return Err("项目目录不存在".to_string());
    }

    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    // 内置 Claude Code 命令排最前；seen 预置内置名，同名自定义命令不覆盖
    for (name, description) in BUILTIN_COMMANDS {
        seen.insert(name.to_string());
        entries.push(CompletionEntry {
            kind: "command".to_string(),
            name: (*name).to_string(),
            description: Some((*description).to_string()),
            source: "内置命令".to_string(),
            path: None,
            is_dir: false,
        });
    }
    let builtin_count = entries.len();

    let mut sources: Vec<(PathBuf, &str, &str)> = vec![
        (
            project.join(".claude").join("commands"),
            "command",
            "项目命令",
        ),
        (project.join(".claude").join("skills"), "skill", "项目技能"),
        (project.join(".agents").join("skills"), "skill", "项目技能"),
    ];
    if let Some(home) = dirs::home_dir() {
        sources.extend([
            (home.join(".claude").join("commands"), "command", "用户命令"),
            (home.join(".claude").join("skills"), "skill", "用户技能"),
            (home.join(".agents").join("skills"), "skill", "用户技能"),
        ]);
    }

    for (root, kind, source) in sources {
        if entries.len() >= MAX_CATALOG_ENTRIES {
            break;
        }
        if kind == "command" {
            discover_commands(&root, &root, source, &mut seen, &mut entries);
        } else {
            discover_skills(&root, source, &mut seen, &mut entries);
        }
    }

    // 内置保持数组顺序在前，其余按名称排序
    let mut rest = entries.split_off(builtin_count);
    rest.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.kind.cmp(&right.kind))
    });
    entries.extend(rest);
    Ok(entries)
}

fn scan_project_entries(
    root: &Path,
    directory: &Path,
    query: &str,
    depth: usize,
    matches: &mut Vec<CompletionEntry>,
) {
    if depth > MAX_SCAN_DEPTH || matches.len() >= MAX_FILE_RESULTS * 4 {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in read_dir.flatten() {
        if matches.len() >= MAX_FILE_RESULTS * 4 {
            break;
        }
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir && (IGNORED_DIRS.contains(&file_name.as_str()) || file_name.starts_with('.')) {
            continue;
        }
        if file_name.starts_with('.') && file_name != ".env" && file_name != ".gitignore" {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let haystack = relative.to_ascii_lowercase();
        if query.is_empty() || haystack.contains(query) {
            matches.push(CompletionEntry {
                kind: if is_dir { "directory" } else { "file" }.to_string(),
                name: file_name.clone(),
                description: None,
                source: "项目".to_string(),
                path: Some(relative),
                is_dir,
            });
        }
        if is_dir {
            scan_project_entries(root, &path, query, depth + 1, matches);
        }
    }
}

fn discover_commands(
    root: &Path,
    directory: &Path,
    source: &str,
    seen: &mut HashSet<String>,
    entries: &mut Vec<CompletionEntry>,
) {
    if entries.len() >= MAX_CATALOG_ENTRIES {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() {
            discover_commands(root, &path, source, seen, entries);
            continue;
        }
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let name = relative
            .with_extension("")
            .to_string_lossy()
            .replace('\\', ":");
        let key = name.to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        entries.push(CompletionEntry {
            kind: "command".to_string(),
            name,
            description: frontmatter_value(&content, "description"),
            source: source.to_string(),
            path: Some(path.to_string_lossy().to_string()),
            is_dir: false,
        });
    }
}

fn discover_skills(
    root: &Path,
    source: &str,
    seen: &mut HashSet<String>,
    entries: &mut Vec<CompletionEntry>,
) {
    if entries.len() >= MAX_CATALOG_ENTRIES {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(root) else {
        return;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_path = path.join("SKILL.md");
        if skill_path.is_file() {
            let content = std::fs::read_to_string(&skill_path).unwrap_or_default();
            let name = frontmatter_value(&content, "name")
                .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
            let key = name.to_ascii_lowercase();
            if seen.insert(key) {
                entries.push(CompletionEntry {
                    kind: "skill".to_string(),
                    name,
                    description: frontmatter_value(&content, "description"),
                    source: source.to_string(),
                    path: Some(skill_path.to_string_lossy().to_string()),
                    is_dir: false,
                });
            }
        } else {
            discover_skills(&path, source, seen, entries);
        }
    }
}

fn frontmatter_value(content: &str, wanted_key: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let frontmatter = lines.take_while(|line| line.trim() != "---").collect::<Vec<_>>();
    for (index, raw_line) in frontmatter.iter().enumerate() {
        let line = raw_line.trim();
        let Some((key, raw_value)) = line.split_once(':') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case(wanted_key) {
            continue;
        }

        let value = raw_value.trim();
        if matches!(value.chars().next(), Some('>') | Some('|')) {
            let separator = if value.starts_with('|') { "\n" } else { " " };
            let block = frontmatter[index + 1..]
                .iter()
                .take_while(|next| next.trim().is_empty() || next.starts_with([' ', '\t']))
                .map(|next| next.trim())
                .filter(|next| !next.is_empty())
                .collect::<Vec<_>>()
                .join(separator);
            return (!block.is_empty()).then_some(block);
        }

        let value = value.trim_matches(['\'', '"']);
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_quoted_frontmatter_values() {
        let content = "---\nname: demo\ndescription: \"Demo skill\"\n---\nbody";
        assert_eq!(frontmatter_value(content, "name").as_deref(), Some("demo"));
        assert_eq!(
            frontmatter_value(content, "description").as_deref(),
            Some("Demo skill")
        );
    }

    #[test]
    fn folds_multiline_frontmatter_values() {
        let content = "---\nname: demo\ndescription: >\n  First line.\n  Second line.\n---\nbody";
        assert_eq!(
            frontmatter_value(content, "description").as_deref(),
            Some("First line. Second line.")
        );
    }

    #[test]
    fn builtin_commands_are_unique_and_have_descriptions() {
        assert!(!BUILTIN_COMMANDS.is_empty());
        let names = BUILTIN_COMMANDS.iter().map(|(name, _)| name).collect::<Vec<_>>();
        let unique = names.iter().collect::<HashSet<_>>();
        assert_eq!(unique.len(), names.len(), "内置命令名不能重复");
        assert!(BUILTIN_COMMANDS.iter().all(|(name, desc)| {
            !name.is_empty() && !desc.is_empty()
        }));
    }

    #[test]
    fn slash_items_prepend_builtins() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("kkcoder-catalog-test-{timestamp}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");

        let items = chat_get_slash_items(dir.to_string_lossy().to_string())
            .expect("slash items should not fail for an empty project");
        assert!(items.len() >= BUILTIN_COMMANDS.len());
        for (index, (name, _)) in BUILTIN_COMMANDS.iter().enumerate() {
            assert_eq!(items[index].name, *name, "内置命令应排在最前");
            assert_eq!(items[index].source, "内置命令");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 项目命令 + 技能发现的集成测试（独立模块名，避免与其他测试模块同名）
#[cfg(test)]
mod slash_catalog_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn slash_items_include_project_commands_and_skills() {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("kkcoder-catalog-skill-{timestamp}"));
        std::fs::create_dir_all(dir.join(".claude/commands")).unwrap();
        std::fs::create_dir_all(dir.join(".claude/skills/docx2md")).unwrap();
        std::fs::write(
            dir.join(".claude/skills/docx2md/SKILL.md"),
            "---\nname: docx2md\ndescription: Office 转 Markdown 助手\n---\n# docx2md\n",
        )
        .unwrap();
        std::fs::write(dir.join(".claude/commands/mycmd.md"), "# 我的项目命令\n").unwrap();

        let items = chat_get_slash_items(dir.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = items.iter().map(|e| e.name.as_str()).collect();
        assert!(names.iter().any(|n| *n == "clear"), "内置命令应存在");
        assert!(
            names.iter().any(|n| *n == "mycmd"),
            "应包含项目命令 mycmd, got {names:?}"
        );
        let skill = items.iter().find(|e| e.name == "docx2md").expect("应包含技能 docx2md");
        assert_eq!(skill.kind, "skill");
        assert_eq!(skill.source, "项目技能");
        assert_eq!(names.iter().filter(|n| **n == "mycmd").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
