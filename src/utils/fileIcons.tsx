/**
 * 文件图标映射 —— 按扩展名 / 特殊文件名返回对应的 lucide-react 图标。
 *
 * 所有图标均使用 currentColor，颜色由 App.css 中的 .file-icon / .file-icon-{category}
 * 控制，因此能自动适配 KKCODER 的 7 套主题（4 暗 + 3 亮）。
 *
 * 用法：
 *   import { FileIcon } from "@/utils/fileIcons";
 *   <FileIcon name={node.name} size={14} />
 */

import React from "react";
import {
  FileCode2,
  FileJson2,
  FileImage,
  FileVideo,
  FileAudio,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileKey,
  FileLock,
  FileText,
  FileQuestion,
  File,
  type LucideProps,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  类型                                                                */
/* ------------------------------------------------------------------ */

/** 类别用于 CSS 着色：code / data / text / media / doc / config / other */
export type IconCategory = "code" | "data" | "text" | "media" | "doc" | "config" | "other";

type IconEntry = [React.ComponentType<LucideProps>, IconCategory];

/* ------------------------------------------------------------------ */
/*  扩展名 → [图标组件, 语义类别]                                        */
/*  小写扩展名（不含点）。重复 key 后者覆盖前者，请勿重复声明。            */
/* ------------------------------------------------------------------ */

const EXT_MAP: Record<string, IconEntry> = {
  /* ---------- 编程语言：代码类 ---------- */
  // TypeScript / JavaScript 生态
  ts: [FileCode2, "code"],
  tsx: [FileCode2, "code"],
  mts: [FileCode2, "code"],
  cts: [FileCode2, "code"],
  js: [FileCode2, "code"],
  jsx: [FileCode2, "code"],
  mjs: [FileCode2, "code"],
  cjs: [FileCode2, "code"],
  // Python
  py: [FileCode2, "code"],
  pyw: [FileCode2, "code"],
  pyi: [FileCode2, "code"],
  pyx: [FileCode2, "code"],
  pxd: [FileCode2, "code"],
  pxi: [FileCode2, "code"],
  // Java / JVM
  java: [FileCode2, "code"],
  class: [FileCode2, "code"],
  jar: [FileCode2, "code"],
  kt: [FileCode2, "code"],
  kts: [FileCode2, "code"],
  scala: [FileCode2, "code"],
  sc: [FileCode2, "code"],
  sbt: [FileCode2, "code"],
  // C / C++ / 家族
  c: [FileCode2, "code"],
  h: [FileCode2, "code"],
  cpp: [FileCode2, "code"],
  cc: [FileCode2, "code"],
  cxx: [FileCode2, "code"],
  hpp: [FileCode2, "code"],
  hxx: [FileCode2, "code"],
  cs: [FileCode2, "code"],
  csx: [FileCode2, "code"],
  // Rust / Go / Swift / Objective-C
  rs: [FileCode2, "code"],
  go: [FileCode2, "code"],
  swift: [FileCode2, "code"],
  m: [FileCode2, "code"],
  mm: [FileCode2, "code"],
  // 脚本语言
  rb: [FileCode2, "code"],
  php: [FileCode2, "code"],
  lua: [FileCode2, "code"],
  r: [FileCode2, "code"],
  sh: [FileTerminal, "code"],
  bash: [FileTerminal, "code"],
  zsh: [FileTerminal, "code"],
  fish: [FileTerminal, "code"],
  ps1: [FileTerminal, "code"],
  bat: [FileTerminal, "code"],
  cmd: [FileTerminal, "code"],
  // 函数式 / 其他语言
  ex: [FileCode2, "code"],
  exs: [FileCode2, "code"],
  elm: [FileCode2, "code"],
  erl: [FileCode2, "code"],
  hrl: [FileCode2, "code"],
  hs: [FileCode2, "code"],
  ml: [FileCode2, "code"],
  fs: [FileCode2, "code"],
  fsx: [FileCode2, "code"],
  clj: [FileCode2, "code"],
  cljs: [FileCode2, "code"],
  cljc: [FileCode2, "code"],
  coffee: [FileCode2, "code"],
  dart: [FileCode2, "code"],
  groovy: [FileCode2, "code"],
  jl: [FileCode2, "code"],
  nim: [FileCode2, "code"],
  pas: [FileCode2, "code"],
  pl: [FileCode2, "code"],
  pm: [FileCode2, "code"],
  rkt: [FileCode2, "code"],
  sql: [FileCode2, "code"],
  v: [FileCode2, "code"],
  zig: [FileCode2, "code"],

  /* ---------- 标记 / 数据：数据类 ---------- */
  json: [FileJson2, "data"],
  jsonc: [FileJson2, "data"],
  json5: [FileJson2, "data"],
  jsonl: [FileJson2, "data"],
  ndjson: [FileJson2, "data"],
  yaml: [FileJson2, "data"],
  yml: [FileJson2, "data"],
  toml: [FileJson2, "data"],
  xml: [FileJson2, "data"],
  xsd: [FileJson2, "data"],
  xsl: [FileJson2, "data"],
  xslt: [FileJson2, "data"],
  csv: [FileSpreadsheet, "data"],
  tsv: [FileSpreadsheet, "data"],
  xls: [FileSpreadsheet, "data"],
  xlsx: [FileSpreadsheet, "data"],
  ods: [FileSpreadsheet, "data"],
  db: [FileJson2, "data"],
  sqlite: [FileJson2, "data"],
  sqlitedb: [FileJson2, "data"],
  graphql: [FileJson2, "data"],
  gql: [FileJson2, "data"],
  plist: [FileJson2, "data"],
  proto: [FileJson2, "data"],

  /* ---------- 图片：媒体类 ---------- */
  png: [FileImage, "media"],
  jpg: [FileImage, "media"],
  jpeg: [FileImage, "media"],
  gif: [FileImage, "media"],
  bmp: [FileImage, "media"],
  webp: [FileImage, "media"],
  avif: [FileImage, "media"],
  ico: [FileImage, "media"],
  svg: [FileImage, "media"],
  tif: [FileImage, "media"],
  tiff: [FileImage, "media"],
  psd: [FileImage, "media"],
  ai: [FileImage, "media"],
  eps: [FileImage, "media"],
  raw: [FileImage, "media"],
  heic: [FileImage, "media"],
  heif: [FileImage, "media"],

  /* ---------- 视频：媒体类 ---------- */
  mp4: [FileVideo, "media"],
  mov: [FileVideo, "media"],
  avi: [FileVideo, "media"],
  mkv: [FileVideo, "media"],
  webm: [FileVideo, "media"],
  flv: [FileVideo, "media"],
  wmv: [FileVideo, "media"],
  m4v: [FileVideo, "media"],
  mpg: [FileVideo, "media"],
  mpeg: [FileVideo, "media"],
  "3gp": [FileVideo, "media"],

  /* ---------- 音频：媒体类 ---------- */
  mp3: [FileAudio, "media"],
  wav: [FileAudio, "media"],
  flac: [FileAudio, "media"],
  ogg: [FileAudio, "media"],
  wma: [FileAudio, "media"],
  aac: [FileAudio, "media"],
  m4a: [FileAudio, "media"],
  opus: [FileAudio, "media"],
  aiff: [FileAudio, "media"],
  mid: [FileMusic, "media"],
  midi: [FileMusic, "media"],

  /* ---------- 文档：文档类 ---------- */
  md: [FileText, "doc"],
  mdx: [FileText, "doc"],
  markdown: [FileText, "doc"],
  mdown: [FileText, "doc"],
  mkd: [FileText, "doc"],
  txt: [FileText, "doc"],
  log: [FileText, "doc"],
  rtf: [FileText, "doc"],
  doc: [FileText, "doc"],
  docx: [FileText, "doc"],
  odt: [FileText, "doc"],
  pages: [FileText, "doc"],
  pdf: [FileText, "doc"],
  tex: [FileText, "doc"],
  latex: [FileText, "doc"],
  bib: [FileText, "doc"],
  ppt: [FileText, "doc"],
  pptx: [FileText, "doc"],
  odp: [FileText, "doc"],
  key: [FileText, "doc"],
  ott: [FileText, "doc"],

  /* ---------- 压缩包：其他类 ---------- */
  zip: [File, "other"],
  "7z": [File, "other"],
  rar: [File, "other"],
  tar: [File, "other"],
  gz: [File, "other"],
  tgz: [File, "other"],
  bz2: [File, "other"],
  xz: [File, "other"],
  lz: [File, "other"],
  zst: [File, "other"],
  cab: [File, "other"],
  iso: [File, "other"],
  img: [File, "other"],
  dmg: [File, "other"],
  deb: [File, "other"],
  rpm: [File, "other"],
  apk: [File, "other"],
  msi: [File, "other"],

  /* ---------- 可执行 / 库：其他类 ---------- */
  exe: [File, "other"],
  dll: [File, "other"],
  so: [File, "other"],
  dylib: [File, "other"],
  bin: [File, "other"],
  app: [File, "other"],
  out: [File, "other"],

  /* ---------- 字体：其他类 ---------- */
  ttf: [File, "other"],
  otf: [File, "other"],
  woff: [File, "other"],
  woff2: [File, "other"],
  eot: [File, "other"],

  /* ---------- Web 前端：代码类 ---------- */
  html: [FileCode2, "code"],
  htm: [FileCode2, "code"],
  css: [FileCode2, "code"],
  scss: [FileCode2, "code"],
  sass: [FileCode2, "code"],
  less: [FileCode2, "code"],
  styl: [FileCode2, "code"],
  vue: [FileCode2, "code"],
  svelte: [FileCode2, "code"],
  astro: [FileCode2, "code"],

  /* ---------- 配置 / 基础设施：配置类 ---------- */
  ini: [FileKey, "config"],
  conf: [FileKey, "config"],
  cfg: [FileKey, "config"],
  env: [FileLock, "config"],
  properties: [FileKey, "config"],
  lock: [FileLock, "config"],
  pem: [FileLock, "config"],
  crt: [FileLock, "config"],
  cer: [FileLock, "config"],
  pub: [FileKey, "config"],
  asc: [FileLock, "config"],
  gpg: [FileLock, "config"],
  rc: [FileKey, "config"],
};

/* ------------------------------------------------------------------ */
/*  特殊文件名（小写）→ 图标 + 类别，优先级高于扩展名                    */
/* ------------------------------------------------------------------ */

const NAME_MAP: Record<string, IconEntry> = {
  // JS 生态
  "package.json": [FileJson2, "data"],
  "package-lock.json": [FileLock, "config"],
  "tsconfig.json": [FileJson2, "data"],
  "tsconfig.build.json": [FileJson2, "data"],
  "tslint.json": [FileJson2, "data"],
  ".eslintrc": [FileJson2, "data"],
  ".eslintrc.json": [FileJson2, "data"],
  ".eslintrc.js": [FileCode2, "code"],
  ".eslintrc.cjs": [FileCode2, "code"],
  ".eslintignore": [FileKey, "config"],
  ".prettierrc": [FileJson2, "data"],
  ".prettierrc.json": [FileJson2, "data"],
  ".prettierrc.yaml": [FileJson2, "data"],
  ".prettierrc.yml": [FileJson2, "data"],
  "prettier.config.js": [FileCode2, "code"],
  ".babelrc": [FileJson2, "data"],
  "babel.config.js": [FileCode2, "code"],
  ".browserslistrc": [FileKey, "config"],
  "webpack.config.js": [FileCode2, "code"],
  "vite.config.ts": [FileCode2, "code"],
  "vite.config.js": [FileCode2, "code"],
  "rollup.config.js": [FileCode2, "code"],
  "turbo.json": [FileJson2, "data"],
  ".npmrc": [FileKey, "config"],
  ".nvmrc": [FileKey, "config"],
  ".node-version": [FileKey, "config"],
  "pnpm-lock.yaml": [FileLock, "config"],
  "yarn.lock": [FileLock, "config"],
  ".yarnrc": [FileKey, "config"],
  ".yarnrc.yml": [FileJson2, "data"],
  "bun.lockb": [FileLock, "config"],
  "bunfig.toml": [FileJson2, "data"],
  // Python
  "pyproject.toml": [FileJson2, "data"],
  "requirements.txt": [FileText, "doc"],
  "pipfile": [FileJson2, "data"],
  "pipfile.lock": [FileLock, "config"],
  "setup.py": [FileCode2, "code"],
  "setup.cfg": [FileKey, "config"],
  "tox.ini": [FileKey, "config"],
  "poetry.lock": [FileLock, "config"],
  "pdm.lock": [FileLock, "config"],
  "pdm.toml": [FileJson2, "data"],
  "manifest.in": [FileText, "doc"],
  "pylintrc": [FileKey, "config"],
  ".pylintrc": [FileKey, "config"],
  "mypy.ini": [FileKey, "config"],
  ".flake8": [FileKey, "config"],
  "pytest.ini": [FileKey, "config"],
  "py.typed": [FileKey, "config"],
  // Rust
  "cargo.toml": [FileJson2, "data"],
  "cargo.lock": [FileLock, "config"],
  // Go
  "go.mod": [FileCode2, "code"],
  "go.sum": [FileLock, "config"],
  // Ruby
  "gemfile": [FileCode2, "code"],
  "gemfile.lock": [FileLock, "config"],
  "rakefile": [FileCode2, "code"],
  // Docker / CI
  dockerfile: [FileCode2, "code"],
  "dockerfile.dev": [FileCode2, "code"],
  "dockerfile.prod": [FileCode2, "code"],
  ".dockerignore": [FileKey, "config"],
  "docker-compose.yml": [FileJson2, "data"],
  "docker-compose.yaml": [FileJson2, "data"],
  "docker-compose.override.yml": [FileJson2, "data"],
  "compose.yml": [FileJson2, "data"],
  "compose.yaml": [FileJson2, "data"],
  ".github": [FileKey, "config"],
  ".gitlab-ci.yml": [FileJson2, "data"],
  ".travis.yml": [FileJson2, "data"],
  "jenkinsfile": [FileCode2, "code"],
  "azure-pipelines.yml": [FileJson2, "data"],
  "cloudbuild.yaml": [FileJson2, "data"],
  "cloudbuild.yml": [FileJson2, "data"],
  "vercel.json": [FileJson2, "data"],
  "netlify.toml": [FileJson2, "data"],
  ".editorconfig": [FileKey, "config"],
  ".gitignore": [FileKey, "config"],
  ".gitattributes": [FileKey, "config"],
  ".gitmodules": [FileKey, "config"],
  ".gitkeep": [FileKey, "config"],
  ".hgignore": [FileKey, "config"],
  ".svnignore": [FileKey, "config"],
  // 构建 / 工具
  makefile: [FileCode2, "code"],
  "makefile.inc": [FileCode2, "code"],
  cmakelists: [FileCode2, "code"],
  "cmakelists.txt": [FileCode2, "code"],
  "procfile": [FileCode2, "code"],
  "gruntfile.js": [FileCode2, "code"],
  "gulpfile.js": [FileCode2, "code"],
  // 安全 / 证书
  ".env": [FileLock, "config"],
  ".env.example": [FileLock, "config"],
  ".env.local": [FileLock, "config"],
  ".env.development": [FileLock, "config"],
  ".env.production": [FileLock, "config"],
  ".env.test": [FileLock, "config"],
  // 其他
  license: [FileText, "doc"],
  licence: [FileText, "doc"],
  "license.md": [FileText, "doc"],
  "license.txt": [FileText, "doc"],
  copying: [FileText, "doc"],
  readme: [FileText, "doc"],
  "readme.md": [FileText, "doc"],
  changelog: [FileText, "doc"],
  "changelog.md": [FileText, "doc"],
  authors: [FileText, "doc"],
  contributors: [FileText, "doc"],
  "code_of_conduct.md": [FileText, "doc"],
  "contributing.md": [FileText, "doc"],
  ".mailmap": [FileKey, "config"],
  ".watchmanconfig": [FileJson2, "data"],
  ".flowconfig": [FileKey, "config"],
  "jest.config.js": [FileCode2, "code"],
  "jest.config.ts": [FileCode2, "code"],
  ".jestrc": [FileJson2, "data"],
  "vitest.config.ts": [FileCode2, "code"],
  "vitest.config.js": [FileCode2, "code"],
  "playwright.config.ts": [FileCode2, "code"],
  "postcss.config.js": [FileCode2, "code"],
  "tailwind.config.js": [FileCode2, "code"],
  "tailwind.config.ts": [FileCode2, "code"],
  "svelte.config.js": [FileCode2, "code"],
  "next.config.js": [FileCode2, "code"],
  "next.config.mjs": [FileCode2, "code"],
  "nuxt.config.ts": [FileCode2, "code"],
  "nuxt.config.js": [FileCode2, "code"],
  "astro.config.mjs": [FileCode2, "code"],
  "remix.config.js": [FileCode2, "code"],
  "gatsby-config.js": [FileCode2, "code"],
  "docusaurus.config.js": [FileCode2, "code"],
  "vue.config.js": [FileCode2, "code"],
  "ionic.config.json": [FileJson2, "data"],
  "capacitor.config.json": [FileJson2, "data"],
  "capacitor.config.ts": [FileCode2, "code"],
  "tauri.conf.json": [FileJson2, "data"],
  "cargo-metadata.json": [FileJson2, "data"],
  "angular.json": [FileJson2, "data"],
  ".angular-cli.json": [FileJson2, "data"],
  "nx.json": [FileJson2, "data"],
  "project.json": [FileJson2, "data"],
  "firebase.json": [FileJson2, "data"],
  ".firebaserc": [FileJson2, "data"],
};

/* ------------------------------------------------------------------ */
/*  兜底图标                                                            */
/* ------------------------------------------------------------------ */

const FALLBACK: IconEntry = [FileQuestion, "other"];

/* ------------------------------------------------------------------ */
/*  工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 从文件名提取扩展名（小写，不含点）；无扩展名返回空串 */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // dot <= 0  →  ".eslintrc" 这类以点开头的隐藏文件视为无扩展名，走 NAME_MAP
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 查询单个文件的图标 + 类别；不处理目录（目录由调用方渲染） */
export function resolveFileIcon(name: string): {
  Icon: React.ComponentType<LucideProps>;
  category: IconCategory;
} {
  const lower = name.toLowerCase();

  // 1. 特殊文件名优先（精确匹配，含点号 / 路径无关）
  const byName = NAME_MAP[lower];
  if (byName) return { Icon: byName[0], category: byName[1] };

  // 2. 扩展名匹配
  const byExt = EXT_MAP[extOf(lower)];
  if (byExt) return { Icon: byExt[0], category: byExt[1] };

  // 3. 兜底
  return { Icon: FALLBACK[0], category: FALLBACK[1] };
}

/* ------------------------------------------------------------------ */
/*  React 组件 —— 渲染用                                                */
/* ------------------------------------------------------------------ */

export interface FileIconProps extends Omit<LucideProps, "name"> {
  /** 文件名（含扩展名）或特殊文件名，如 "index.ts"、"package.json" */
  name: string;
}

/**
 * 文件类型图标组件。
 *
 * 自动根据扩展名 / 特殊文件名选择图标，并通过 className 携带语义类别
 * （file-icon-{category}），由 App.css 控制主题色。
 *
 * 用法：
 *   import { FileIcon } from "@/utils/fileIcons";
 *   <FileIcon name={node.name} size={14} />
 */
export const FileIcon: React.FC<FileIconProps> = ({ name, className = "", ...rest }) => {
  const { Icon, category } = resolveFileIcon(name);
  const cls = `file-icon file-icon-${category}${className ? " " + className : ""}`;
  return <Icon className={cls} {...rest} />;
};
