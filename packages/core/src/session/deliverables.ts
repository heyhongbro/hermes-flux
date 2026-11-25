/**
 * 会话与回合成果物纯领域提取与媒体标记剥离引擎 (packages/core/src/session/deliverables.ts)
 *
 * 【设计意图 (Why)】
 *   统一跨桌面端与移动端的“真实产出物（Deliverables / Artifacts）”单一真值口径：
 *   1. 官方 Hermes Gateway 并无 `artifact.created` 下行事件，而是通过 `tool.complete.image_path` /
 *      `inline_diff`、文件写/生成类工具的结构化路径、`subagent.*.files_written`、`MEDIA:<path>` 媒体行、
 *      Markdown 图片/文档链接以及助手多模态分片表达每轮产出的成果物；
 *   2. 对正文反引号或裸路径中的文件提及采用「读写分离 + 同回合脚本交叉印证 + 父目录物理实证」双锁策略，
 *      既彻底找回 Python/Shell 脚本隐式生成的文件（如信息图 PNG），又绝不将只读读取或示例代码路径误判为成果物；
 *   3. 本模块提供零 DOM / React / Electron 依赖的纯函数，分别支撑：
 *      - `stripMediaTags`：剥离正文中的 `MEDIA:` 机器指令行（豁免围栏代码块），避免聊天窗出现裸路径指令；
 *      - `extractTurnDeliverables`：提取单个助手回合的成果物列表；
 *      - `extractSessionDeliverables`：按最新优先去重汇聚整段会话成果物，驱动桌面成果物侧边栏与移动端「成果物」Tab；
 *      - `findInlineReferencedDeliverableKeys`：判别哪些成果物已在正文原地渲染成小卡片，避免底部重复堆叠。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `terminal` 执行 `cat /etc/hosts` 或只读工具 `read_file` / `search_files` 中的路径绝不能误判为“新生成成果物”，
 *      否则既会污染成果物列表，也会破坏只允许真实写/产出的边界；
 *      纯只读工具与纯只读 Shell 命令仅进入 `readOnlyKeys` 隔离集，不构成写作印证；
 *   2. 围栏代码块（``` / ~~~）内的示例代码（如说明 `MEDIA:` 语法或示例路径）严禁被清洗或当作真实文件渲染；
 *   3. 绝不允许 `javascript:` / `data:text/html` / 含控制字符 / 系统敏感到位示例路径进入成果物列表或预览 DOM。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React / Node API 依赖，纯函数、无副作用；
 *   - 同路径多次引用或跨数据源重复出现时确定性去重（单回合保持首次出现顺序，跨会话保持最近产出优先）；
 *   - 非 `assistant` 角色消息不提取为 Agent 成果物（用户上传归属气泡附件）。
 */

import { isImageExtension, isVideoExtension } from '../fs/fileService.js';

export type DeliverableKind = 'image' | 'video' | 'html' | 'markdown' | 'document' | 'file';

export type DeliverableSource =
  | 'tool_image'
  | 'tool_write'
  | 'subagent_write'
  | 'turn_corroborated'
  | 'verified_mention'
  | 'media_tag'
  | 'markdown_image'
  | 'content_part'
  | 'markdown_link';

export interface DeliverableToolInput {
  id?: string;
  name: string;
  status?: string;
  args?: string;
  rawArgs?: unknown;
  output?: string;
  imagePath?: string;
  inlineDiff?: string;
}

export interface DeliverableAttachmentInput {
  id?: string;
  name: string;
  type?: 'image' | 'file' | 'pdf';
  mime?: string;
  previewUrl?: string;
  path?: string;
}

export interface DeliverableMessageInput {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content?: string;
  toolCalls?: readonly DeliverableToolInput[];
  attachments?: readonly DeliverableAttachmentInput[];
}

export interface DeliverableExtractionOptions {
  /** 已通过本地 PAL 或远端网关父目录列表物理核验真实存在的文件路径集合 */
  verifiedExistingPaths?: ReadonlySet<string> | readonly string[];
  /** 来自 SubagentStore (`subagent.*.files_written`) 的显式写入路径 */
  subagentWrittenPaths?: readonly string[];
}

export interface DeliverableItem {
  id: string;
  kind: DeliverableKind;
  path: string;
  name: string;
  mime?: string;
  previewUrl?: string;
  messageId: string;
  source: DeliverableSource;
}

const READ_ONLY_TOOL_RE = /^(read|read_file|view|cat|grep|ripgrep|rg|search|search_files|find|find_files|glob|list|list_files|list_directory|ls|stat|head|tail)$/i;
const SHELL_EXEC_TOOL_RE = /^(terminal|execute_code|shell|bash|sh|zsh|powershell|pwsh|cmd|python|run_command)$/i;
const OUTPUT_TOOL_RE = /(write|edit|patch|create|save|export|render|generate|image|draw|plot|chart|diagram|screenshot|browser_screenshot|video|media|send_file|artifact|upload|apply)/i;

const READ_ONLY_SHELL_CMD_RE = /^(cat|head|tail|less|more|grep|egrep|fgrep|rg|ripgrep|ls|ll|la|dir|stat|file|wc|find|fd|pwd|which|type|diff)\b/i;
const SHELL_WRITE_HINT_RE = /(?:^|[^0-9-])>>?\s*\S|\b(?:tee|cp|mv|rm|touch|mkdir|python3?|node|ruby|perl|ffmpeg|convert|magick|playwright|curl\s+-[^\n]*[oO]|wget|sed\s+-i)\b/i;

const EXCLUDED_PATH_PREFIXES = [
  '/etc/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/boot/',
  '/var/log/',
  '/path/to/',
  '/your/',
  'c:/windows/',
  'c:/program files/',
  'c:/program files (x86)/',
] as const;

const STRUCTURED_OUTPUT_FIELDS = [
  'image_path',
  'imagePath',
  'video_path',
  'videoPath',
  'media_path',
  'mediaPath',
  'output_path',
  'outputPath',
  'output_file',
  'outputFile',
  'saved_to',
  'savedTo',
  'screenshot_path',
  'screenshotPath',
] as const;

const WRITE_TOOL_PATH_FIELDS = [
  ...STRUCTURED_OUTPUT_FIELDS,
  'resolved_path',
  'file_path',
  'filePath',
  'path',
  'file',
  'target',
] as const;

const PATH_ARRAY_FIELDS = ['files_modified', 'artifacts', 'images', 'videos', 'media', 'outputs', 'files'] as const;

const HTML_EXTS = new Set(['html', 'htm']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const DOCUMENT_EXTS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'tsv',
  'txt',
  'json',
  'yaml',
  'yml',
  'xml',
  'rtf',
  'odt',
  'ods',
  'odp',
]);
const LINKABLE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm|mov|m4v|ogv|html?|mdx?|pdf|docx?|xlsx?|pptx?|csv|tsv|txt|json|ya?ml|xml|ts|tsx|js|jsx|mjs|py|css|scss|sql|sh|go|rs|java|kt|swift)$/i;

function extractExtension(target: string): string {
  const clean = target.split(/[?#]/)[0].trim();
  const base = clean.split(/[/\\]/).pop() || '';
  const dotIdx = base.lastIndexOf('.');
  return dotIdx > 0 ? base.slice(dotIdx + 1).toLowerCase() : '';
}

function extractBasename(target: string): string {
  if (!target) return '';
  if (target.startsWith('data:')) return 'media';
  const clean = target.split(/[?#]/)[0].replace(/\\/g, '/').replace(/\/+$/, '');
  return clean.split('/').pop() || clean;
}

/**
 * 依据路径/URL/MIME 对成果物进行确定性分类。
 */
export function classifyDeliverableKind(pathOrName: string, mime?: string): DeliverableKind {
  const lowerMime = (mime || '').toLowerCase();
  if (lowerMime.startsWith('image/')) return 'image';
  if (lowerMime.startsWith('video/')) return 'video';
  if (lowerMime === 'text/html') return 'html';
  if (lowerMime === 'text/markdown') return 'markdown';

  const trimmed = (pathOrName || '').trim();
  if (trimmed.startsWith('data:image/')) return 'image';
  if (trimmed.startsWith('data:video/')) return 'video';

  if (isImageExtension(trimmed)) return 'image';
  if (isVideoExtension(trimmed)) return 'video';

  const ext = extractExtension(trimmed);
  if (HTML_EXTS.has(ext)) return 'html';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (DOCUMENT_EXTS.has(ext)) return 'document';
  return 'file';
}

function isSafeDeliverablePath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text/html')) {
    return false;
  }
  if (lower.startsWith('data:')) {
    return lower.startsWith('data:image/') || lower.startsWith('data:video/');
  }
  return true;
}

function normalizeCandidateTarget(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return '';
  if (value.startsWith('<') && value.endsWith('>')) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/^[`"']+|[`"']+$/g, '').trim();
  if (!isSafeDeliverablePath(value)) return '';
  return value;
}

function looksLikePathOrMediaUrl(target: string): boolean {
  if (!target) return false;
  const lower = target.toLowerCase();
  if (
    lower.startsWith('https://') ||
    lower.startsWith('http://') ||
    lower.startsWith('blob:') ||
    lower.startsWith('data:image/') ||
    lower.startsWith('data:video/')
  ) {
    return true;
  }
  if (target.startsWith('#') || lower.startsWith('mailto:') || lower.startsWith('tel:')) {
    return false;
  }
  const clean = target.split(/[?#]/)[0].replace(/\\/g, '/');
  if (clean.endsWith('/')) return false;
  const hasSlash = clean.includes('/');
  const isDrive = /^[a-zA-Z]:\//.test(clean);
  const ext = extractExtension(clean);
  if (isImageExtension(clean) || isVideoExtension(clean)) return true;
  if (hasSlash || isDrive) {
    return LINKABLE_FILE_EXT_RE.test(clean);
  }
  return Boolean(ext && LINKABLE_FILE_EXT_RE.test(clean));
}

export function normalizeDeliverableKey(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('data:')) return trimmed;
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('blob:')) {
    return trimmed;
  }
  return trimmed
    .replace(/^[`"']+|[`"']+$/g, '')
    .replace(/\\/g, '/')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

const FENCE_RE = /^\s*(```|~~~)/;
const MEDIA_TAG_RE = /(^|\s)MEDIA:([^\s`"'<>|]+)/g;

/**
 * 从 Markdown 正文中安全剥离 `MEDIA:<path>` 指令标记，并返回提取出的路径集合。
 *
 * 【规则 (Rules)】
 *   1. 跳过围栏代码块（``` / ~~~），示例代码中的 `MEDIA:` 原文完整保留；
 *   2. 剥离后不得在正文残留裸 `MEDIA:` token，并将多余空行收敛至最多两个换行。
 */
export function stripMediaTags(text: string): { cleanText: string; mediaPaths: string[] } {
  if (!text || typeof text !== 'string') {
    return { cleanText: text || '', mediaPaths: [] };
  }
  if (!text.includes('MEDIA:')) {
    return { cleanText: text, mediaPaths: [] };
  }

  const lines = text.split(/\r?\n/);
  const outLines: string[] = [];
  const mediaPaths: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      outLines.push(line);
      continue;
    }
    if (inFence) {
      outLines.push(line);
      continue;
    }

    let lineHadMedia = false;
    const strippedLine = line.replace(MEDIA_TAG_RE, (_full, lead: string, rawPath: string) => {
      const candidate = normalizeCandidateTarget(rawPath);
      if (candidate && looksLikePathOrMediaUrl(candidate)) {
        mediaPaths.push(candidate);
        lineHadMedia = true;
        return lead;
      }
      return _full;
    });

    const trimmedLine = strippedLine.trim();
    if (lineHadMedia && !trimmedLine) {
      continue;
    }
    outLines.push(lineHadMedia ? strippedLine.replace(/[ \t]+$/g, '') : strippedLine);
  }

  const cleanText = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, mediaPaths };
}

function parseJsonSafe(raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  // gate-degrade: 非法 JSON 文本视为普通文本输出，按降级链路继续扫描 MEDIA 标记
  } catch {
    return undefined;
  }
}

function collectPathsFromStructured(
  value: unknown,
  fields: readonly string[],
  out: string[],
  depth = 0,
): void {
  if (value === null || value === undefined || depth > 3) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        const candidate = normalizeCandidateTarget(item);
        if (candidate && looksLikePathOrMediaUrl(candidate)) {
          out.push(candidate);
        }
      } else {
        collectPathsFromStructured(item, fields, out, depth + 1);
      }
    }
    return;
  }
  if (typeof value !== 'object') return;
  const rec = value as Record<string, unknown>;
  for (const field of fields) {
    const val = rec[field];
    if (typeof val === 'string') {
      const candidate = normalizeCandidateTarget(val);
      if (candidate && looksLikePathOrMediaUrl(candidate)) {
        out.push(candidate);
      }
    }
  }
  for (const listField of PATH_ARRAY_FIELDS) {
    const arr = rec[listField];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'string') {
          const candidate = normalizeCandidateTarget(item);
          if (candidate && looksLikePathOrMediaUrl(candidate)) {
            out.push(candidate);
          }
        } else if (item && typeof item === 'object') {
          collectPathsFromStructured(item, fields, out, depth + 1);
        }
      }
    }
  }
}

function stripFenceBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const visible: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) visible.push(line);
  }
  return visible.join('\n');
}

function extractMarkdownLinkTargets(text: string): {
  images: Array<{ alt: string; path: string }>;
  links: Array<{ label: string; path: string }>;
} {
  const images: Array<{ alt: string; path: string }> = [];
  const links: Array<{ label: string; path: string }> = [];
  const outsideFence = stripFenceBlocks(text);

  const mdImageRe = /!\[([^\]]*)\]\(([^)\s]+(?:\s+["'][^"']*["'])?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdImageRe.exec(outsideFence)) !== null) {
    const rawTarget = match[2].replace(/\s+["'][^"']*["']$/, '').trim();
    const target = normalizeCandidateTarget(rawTarget);
    if (target && looksLikePathOrMediaUrl(target)) {
      images.push({ alt: match[1].trim(), path: target });
    }
  }

  const mdLinkRe = /(!?)\[([^\]]+)\]\(([^)\s]+(?:\s+["'][^"']*["'])?)\)/g;
  while ((match = mdLinkRe.exec(outsideFence)) !== null) {
    if (match[1] === '!') continue;
    const rawTarget = match[3].replace(/\s+["'][^"']*["']$/, '').trim();
    const target = normalizeCandidateTarget(rawTarget);
    const lower = target.toLowerCase();
    // 网页链接在气泡正文中保留普通超链语义，仅收集工作区/本地生成文件路径，避免把外部网页参考链接混入成果物
    if (
      !target ||
      lower.startsWith('http://') ||
      lower.startsWith('https://') ||
      lower.startsWith('mailto:') ||
      lower.startsWith('tel:') ||
      lower.startsWith('#') ||
      lower.startsWith('data:')
    ) {
      continue;
    }
    if (looksLikePathOrMediaUrl(target)) {
      links.push({ label: match[2].trim(), path: target });
    }
  }

  return { images, links };
}

function pushDeliverable(
  items: DeliverableItem[],
  seen: Map<string, number>,
  entry: Omit<DeliverableItem, 'id'>,
): void {
  const key = normalizeDeliverableKey(entry.path);
  if (!key) return;

  const existingIdx = seen.get(key);
  if (existingIdx !== undefined) {
    const existing = items[existingIdx];
    if (!existing.previewUrl && entry.previewUrl) {
      items[existingIdx] = { ...existing, previewUrl: entry.previewUrl };
    }
    return;
  }

  seen.set(key, items.length);
  items.push({
    ...entry,
    id: `deliv-${items.length}-${key}`,
  });
}

/**
 * 判断规范化后的路径是否属于 OS 系统目录或常见占位符示例代码路径。
 */
export function isExcludedSystemOrPlaceholderPath(raw: string): boolean {
  const clean = normalizeDeliverableKey(raw).toLowerCase();
  if (!clean) return true;
  if (clean.startsWith('//')) return true;
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => clean.startsWith(prefix) || clean === prefix.slice(0, -1))) {
    return true;
  }
  return clean.includes('/path/to/');
}

function normalizeCandidateMention(raw: string): string {
  const withoutPos = (raw || '').trim().replace(/:\d+(?::\d+)?$/, '');
  const candidate = normalizeCandidateTarget(withoutPos);
  if (!candidate) return '';
  const lower = candidate.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    candidate.startsWith('#')
  ) {
    return '';
  }
  const clean = candidate.split(/[?#]/)[0].replace(/\\/g, '/');
  if (clean.endsWith('/')) return '';
  if (!clean.includes('/') && !/^[a-zA-Z]:\//.test(clean)) return '';
  if (isExcludedSystemOrPlaceholderPath(clean)) return '';
  if (!LINKABLE_FILE_EXT_RE.test(clean)) return '';
  return candidate;
}

function extractShellCommandText(tool: DeliverableToolInput): string {
  const parsed = parseJsonSafe(tool.rawArgs ?? tool.args);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const cmd = rec.command ?? rec.cmd ?? rec.script ?? rec.code;
    if (typeof cmd === 'string') return cmd;
  }
  if (typeof tool.args === 'string') return tool.args;
  if (typeof tool.rawArgs === 'string') return tool.rawArgs;
  return '';
}

function isReadOnlyShellInvocation(commandText: string): boolean {
  const trimmed = commandText.trim();
  if (!trimmed) return true;
  if (SHELL_WRITE_HINT_RE.test(trimmed)) return false;
  const segments = trimmed.split(/(?:&&|\|\||;|\||\r?\n)+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return true;
  return segments.every((seg) => READ_ONLY_SHELL_CMD_RE.test(seg));
}

function scanRawFilePathsInText(text: string): string[] {
  const found: string[] = [];
  if (!text) return found;
  const bareRe = /(?:^|[\s(>\[{"'`：:，,;；、])((?:[A-Za-z]:[/\\]|\.{1,2}[/\\]|\/|[A-Za-z0-9._-]+[/\\])[^\s`"'<>|()\[\]{},;，。；：、]+)/g;
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(text)) !== null) {
    const cleaned = m[1].replace(/[.,;:!?)'"`]+$/, '');
    if (cleaned) found.push(cleaned);
  }
  return found;
}

/**
 * 收集会话/回合中所有仅通过只读工具或纯只读 Shell 命令读取过的路径键（读写分离守卫）。
 * 只要同一文件之后或同回合被写类工具 / `files_written` / 脚本产生，写入集合优先于只读集合。
 */
export function collectReadOnlyToolPaths(messages: readonly DeliverableMessageInput[]): Set<string> {
  const readOnlyKeys = new Set<string>();
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue;
    for (const tc of msg.toolCalls ?? []) {
      if (!tc) continue;
      const toolName = (tc.name || '').trim();
      if (READ_ONLY_TOOL_RE.test(toolName)) {
        const rawPaths: string[] = [];
        collectPathsFromStructured(parseJsonSafe(tc.rawArgs ?? tc.args), WRITE_TOOL_PATH_FIELDS, rawPaths);
        collectPathsFromStructured(parseJsonSafe(tc.output), WRITE_TOOL_PATH_FIELDS, rawPaths);
        for (const p of scanRawFilePathsInText(typeof tc.args === 'string' ? tc.args : '')) {
          rawPaths.push(p);
        }
        for (const p of rawPaths) {
          const key = normalizeDeliverableKey(p);
          if (key) readOnlyKeys.add(key);
        }
        continue;
      }
      if (SHELL_EXEC_TOOL_RE.test(toolName)) {
        const cmd = extractShellCommandText(tc);
        if (isReadOnlyShellInvocation(cmd)) {
          for (const p of scanRawFilePathsInText(cmd)) {
            const key = normalizeDeliverableKey(p);
            if (key) readOnlyKeys.add(key);
          }
        }
      }
    }
  }
  return readOnlyKeys;
}

/**
 * 扫描助手正文中明确提及的文件路径候选（跳过围栏代码块、Markdown 链接/图片、MEDIA: 与外部 URL）。
 * 支持行内反引号 `` `/opt/data/.../t3-timeline.png` `` 与正文裸路径。
 */
export function extractCandidateMentionPaths(messages: readonly DeliverableMessageInput[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const recordCandidate = (raw: string): void => {
    const normalized = normalizeCandidateMention(raw);
    if (!normalized) return;
    const key = normalizeDeliverableKey(normalized);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant' || !msg.content) continue;
    const outsideFence = stripFenceBlocks(msg.content);
    // 先剥离显式协议 / MEDIA: / Markdown 图片与链接，避免误将外链或 ![not-img](a.ts) 二次当成裸路径
    const masked = outsideFence
      .replace(/(^|\s)MEDIA:([^\s`"'<>|]+)/g, '$1 ')
      .replace(/!?\[[^\]]*\]\([^)\n]*\)/g, ' ')
      .replace(/(?:https?|ftp|blob|mailto|tel|javascript|vbscript):[^\s`"'<>|()\[\]{}]+/gi, ' ')
      .replace(/data:[^\s`"'<>|()\[\]{}]+/gi, ' ');

    const withoutBackticks = masked.replace(/`([^`\r\n]+)`/g, (_full, inner: string) => {
      recordCandidate(inner);
      return ' ';
    });

    for (const bare of scanRawFilePathsInText(withoutBackticks)) {
      recordCandidate(bare);
    }
  }

  return out;
}

function collectTurnCorroborationCorpus(messages: readonly DeliverableMessageInput[]): string[] {
  const corpus: string[] = [];
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue;
    for (const tc of msg.toolCalls ?? []) {
      if (!tc) continue;
      const toolName = (tc.name || '').trim();
      if (!SHELL_EXEC_TOOL_RE.test(toolName)) continue;
      const cmd = extractShellCommandText(tc);
      if (isReadOnlyShellInvocation(cmd)) continue;
      const rawArgsStr =
        typeof tc.rawArgs === 'string'
          ? tc.rawArgs
          : tc.rawArgs && typeof tc.rawArgs === 'object'
            ? JSON.stringify(tc.rawArgs)
            : '';
      const combined = [cmd, tc.args || '', rawArgsStr, tc.output || '']
        .filter(Boolean)
        .join('\n')
        .replace(/\\/g, '/');
      if (combined) corpus.push(combined);
    }
  }
  return corpus;
}

function isPathMentionedInCorpus(candidatePath: string, corpus: readonly string[]): boolean {
  if (corpus.length === 0) return false;
  const norm = normalizeDeliverableKey(candidatePath);
  if (!norm) return false;
  const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryRe = new RegExp(`(?:^|[\\s"'\\\`=:,(])${escaped}(?:$|[\\s"'\\\`.,;:)?#|])`);
  return corpus.some((entry) => boundaryRe.test(entry));
}

function toNormalizedKeySet(paths?: ReadonlySet<string> | readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!paths) return out;
  for (const p of paths) {
    const key = normalizeDeliverableKey(p);
    if (key) out.add(key);
  }
  return out;
}

/**
 * 提取单条助手消息中包含的强证据成果物（图片、视频、HTML、Markdown、文档与文件）。
 * 不含只依靠正文反引号出现、尚待回合交叉印证或目录实证核验的候选路径。
 */
export function extractMessageDeliverables(
  message: DeliverableMessageInput,
  options?: DeliverableExtractionOptions,
): DeliverableItem[] {
  if (!message || message.role !== 'assistant') return [];

  const items: DeliverableItem[] = [];
  const seen = new Map<string, number>();

  // 1. 工具调用直接产物（tool.complete.image_path、inline_diff、写/生成工具路径、以及工具输出里的 MEDIA: 指令）
  for (const tc of message.toolCalls ?? []) {
    if (!tc) continue;
    const toolName = (tc.name || '').trim();

    if (typeof tc.imagePath === 'string' && tc.imagePath.trim()) {
      const target = normalizeCandidateTarget(tc.imagePath);
      if (target) {
        pushDeliverable(items, seen, {
          kind: classifyDeliverableKind(target),
          path: target,
          name: extractBasename(target) || target,
          messageId: message.id,
          source: 'tool_image',
        });
      }
    }

    const isReadOnly = READ_ONLY_TOOL_RE.test(toolName);
    const isShell = SHELL_EXEC_TOOL_RE.test(toolName);
    const hasInlineDiff = typeof tc.inlineDiff === 'string' && tc.inlineDiff.trim().length > 0;
    const isOutputTool = !isReadOnly && (OUTPUT_TOOL_RE.test(toolName) || hasInlineDiff);

    const structuredPaths: string[] = [];
    if (isOutputTool) {
      collectPathsFromStructured(parseJsonSafe(tc.rawArgs ?? tc.args), WRITE_TOOL_PATH_FIELDS, structuredPaths);
      collectPathsFromStructured(parseJsonSafe(tc.output), WRITE_TOOL_PATH_FIELDS, structuredPaths);
    } else if (isShell) {
      collectPathsFromStructured(parseJsonSafe(tc.output), STRUCTURED_OUTPUT_FIELDS, structuredPaths);
    }

    for (const p of structuredPaths) {
      pushDeliverable(items, seen, {
        kind: classifyDeliverableKind(p),
        path: p,
        name: extractBasename(p) || p,
        messageId: message.id,
        source: 'tool_write',
      });
    }

    if (typeof tc.output === 'string' && tc.output.includes('MEDIA:')) {
      const { mediaPaths } = stripMediaTags(tc.output);
      for (const p of mediaPaths) {
        pushDeliverable(items, seen, {
          kind: classifyDeliverableKind(p),
          path: p,
          name: extractBasename(p) || p,
          messageId: message.id,
          source: 'media_tag',
        });
      }
    }
  }

  // 2. 助手正文中显式携带的多模态附件分片（例如图像生成回传的 image_url / data_url）
  for (const att of message.attachments ?? []) {
    if (!att) continue;
    const rawTarget = (att.path || att.previewUrl || att.name || '').trim();
    const target = normalizeCandidateTarget(rawTarget);
    if (!target) continue;
    const previewUrl = att.previewUrl && isSafeDeliverablePath(att.previewUrl) ? att.previewUrl : undefined;
    pushDeliverable(items, seen, {
      kind: classifyDeliverableKind(att.name || target, att.mime ?? (att.type === 'image' ? 'image/png' : undefined)),
      path: target,
      name: att.name || extractBasename(target) || 'asset',
      ...(att.mime ? { mime: att.mime } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      messageId: message.id,
      source: 'content_part',
    });
  }

  // 3. 助手正文里的 `MEDIA:<path>` 与 Markdown 图片/文档链接
  const content = message.content || '';
  if (content) {
    if (content.includes('MEDIA:')) {
      const { mediaPaths } = stripMediaTags(content);
      for (const p of mediaPaths) {
        pushDeliverable(items, seen, {
          kind: classifyDeliverableKind(p),
          path: p,
          name: extractBasename(p) || p,
          messageId: message.id,
          source: 'media_tag',
        });
      }
    }

    if (content.includes('](')) {
      const { images, links } = extractMarkdownLinkTargets(content);
      for (const img of images) {
        const lowerImg = img.path.toLowerCase();
        const isDirectUrl =
          lowerImg.startsWith('http://') ||
          lowerImg.startsWith('https://') ||
          lowerImg.startsWith('data:image/') ||
          lowerImg.startsWith('blob:');
        if (!isDirectUrl && classifyDeliverableKind(img.path) !== 'image') {
          continue;
        }
        pushDeliverable(items, seen, {
          kind: 'image',
          path: img.path,
          name: extractBasename(img.path) || img.alt || 'image',
          ...(isDirectUrl ? { previewUrl: img.path } : {}),
          messageId: message.id,
          source: 'markdown_image',
        });
      }
      for (const lnk of links) {
        pushDeliverable(items, seen, {
          kind: classifyDeliverableKind(lnk.path),
          path: lnk.path,
          name: extractBasename(lnk.path) || lnk.label || lnk.path,
          messageId: message.id,
          source: 'markdown_link',
        });
      }
    }
  }

  // 4. Tier B 可选双锁（单消息视角：若传入已核验存在集合且不在只读集合中）
  const verifiedKeys = options?.verifiedExistingPaths
    ? toNormalizedKeySet(options.verifiedExistingPaths)
    : undefined;
  if (verifiedKeys && verifiedKeys.size > 0) {
    const readOnlyKeys = collectReadOnlyToolPaths([message]);
    for (const candidate of extractCandidateMentionPaths([message])) {
      const key = normalizeDeliverableKey(candidate);
      if (!key || seen.has(key) || readOnlyKeys.has(key)) continue;
      if (verifiedKeys.has(key)) {
        pushDeliverable(items, seen, {
          kind: classifyDeliverableKind(candidate),
          path: candidate,
          name: extractBasename(candidate) || candidate,
          messageId: message.id,
          source: 'verified_mention',
        });
      }
    }
  }

  return items;
}

/**
 * 提取单个助手回合的成果物列表：Tier A 强证据 + Tier B 双锁核验（同回合脚本印证 / 父目录物理存在）。
 */
export function extractTurnDeliverables(
  messages: readonly DeliverableMessageInput[],
  options?: DeliverableExtractionOptions,
): DeliverableItem[] {
  const combined: DeliverableItem[] = [];
  const seen = new Map<string, number>();

  for (const msg of messages) {
    const perMsg = extractMessageDeliverables(msg);
    for (const item of perMsg) {
      pushDeliverable(combined, seen, {
        kind: item.kind,
        path: item.path,
        name: item.name,
        ...(item.mime ? { mime: item.mime } : {}),
        ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
        messageId: item.messageId,
        source: item.source,
      });
    }
  }

  // Tier A 补充：子代理显式写入文件（subagent.*.files_written）
  const assistantIds = messages.filter((m) => m.role === 'assistant').map((m) => m.id);
  const anchorMsgId = assistantIds[assistantIds.length - 1] || messages[0]?.id || 'subagent';
  if (assistantIds.length > 0 && options?.subagentWrittenPaths?.length) {
    for (const rawWritten of options.subagentWrittenPaths) {
      const target = normalizeCandidateTarget(rawWritten);
      if (!target) continue;
      pushDeliverable(combined, seen, {
        kind: classifyDeliverableKind(target),
        path: target,
        name: extractBasename(target) || target,
        messageId: anchorMsgId,
        source: 'subagent_write',
      });
    }
  }

  // Tier B：正文候选路径的双锁核验（排除只读工具与示例代码）
  const corpus = collectTurnCorroborationCorpus(messages);
  const verifiedKeys = toNormalizedKeySet(options?.verifiedExistingPaths);
  if (corpus.length === 0 && verifiedKeys.size === 0) {
    return combined;
  }
  const readOnlyKeys = collectReadOnlyToolPaths(messages);

  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant' || !msg.content) continue;
    for (const candidate of extractCandidateMentionPaths([msg])) {
      const key = normalizeDeliverableKey(candidate);
      if (!key || seen.has(key) || readOnlyKeys.has(key)) continue;

      if (isPathMentionedInCorpus(candidate, corpus)) {
        pushDeliverable(combined, seen, {
          kind: classifyDeliverableKind(candidate),
          path: candidate,
          name: extractBasename(candidate) || candidate,
          messageId: msg.id,
          source: 'turn_corroborated',
        });
        continue;
      }

      if (verifiedKeys.has(key)) {
        pushDeliverable(combined, seen, {
          kind: classifyDeliverableKind(candidate),
          path: candidate,
          name: extractBasename(candidate) || candidate,
          messageId: msg.id,
          source: 'verified_mention',
        });
      }
    }
  }

  return combined;
}

/**
 * 筛选尚待通过物理文件系统（本地 PAL / 远端网关目录列表）核验的正文候选路径。
 * 【规则】已确认 Tier A、已由同回合非只读 Shell 印证、以及出现在只读工具集合中的路径不重复外发探测。
 */
export function extractUnverifiedCandidatePaths(
  messages: readonly DeliverableMessageInput[],
  options?: DeliverableExtractionOptions,
): string[] {
  const confirmed = extractSessionDeliverables(messages, options);
  const confirmedKeys = new Set(confirmed.map((d) => normalizeDeliverableKey(d.path)));
  const readOnlyKeys = collectReadOnlyToolPaths(messages);

  const pending: string[] = [];
  const seen = new Set<string>();
  for (const candidate of extractCandidateMentionPaths(messages)) {
    const key = normalizeDeliverableKey(candidate);
    if (!key || seen.has(key) || confirmedKeys.has(key) || readOnlyKeys.has(key)) continue;
    seen.add(key);
    pending.push(candidate);
  }
  return pending;
}

function splitMessagesByAssistantTurn(messages: readonly DeliverableMessageInput[]): DeliverableMessageInput[][] {
  const turns: DeliverableMessageInput[][] = [];
  let current: DeliverableMessageInput[] = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'assistant') {
      current.push(msg);
    } else if (current.length > 0) {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/**
 * 汇聚整个会话的全部真实成果物：最新回合产出的成果物排在最前并确定性去重。
 */
export function extractSessionDeliverables(
  messages: readonly DeliverableMessageInput[],
  options?: DeliverableExtractionOptions,
): DeliverableItem[] {
  const result: DeliverableItem[] = [];
  const seen = new Map<string, number>();

  // 按回合切片分别计算 Tier A + 锁1/锁2，保证与 extractTurnDeliverables 严格守恒
  const turns = splitMessagesByAssistantTurn(messages);
  const readOnlyKeys = collectReadOnlyToolPaths(messages);
  const verifiedKeys = toNormalizedKeySet(options?.verifiedExistingPaths);

  for (let i = turns.length - 1; i >= 0; i--) {
    const turnItems = extractTurnDeliverables(turns[i], {
      verifiedExistingPaths: verifiedKeys,
    });
    for (let j = turnItems.length - 1; j >= 0; j--) {
      const item = turnItems[j];
      const key = normalizeDeliverableKey(item.path);
      if (item.source === 'verified_mention' && readOnlyKeys.has(key)) continue;
      pushDeliverable(result, seen, {
        kind: item.kind,
        path: item.path,
        name: item.name,
        ...(item.mime ? { mime: item.mime } : {}),
        ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
        messageId: item.messageId,
        source: item.source,
      });
    }
  }

  // 会话级子代理写入清单（兜底并去重合并）
  if (options?.subagentWrittenPaths?.length) {
    const fallbackMsgId = messages.filter((m) => m.role === 'assistant').at(-1)?.id || 'subagent';
    for (let j = options.subagentWrittenPaths.length - 1; j >= 0; j--) {
      const rawWritten = options.subagentWrittenPaths[j];
      const target = normalizeCandidateTarget(rawWritten);
      if (!target) continue;
      pushDeliverable(result, seen, {
        kind: classifyDeliverableKind(target),
        path: target,
        name: extractBasename(target) || target,
        messageId: fallbackMsgId,
        source: 'subagent_write',
      });
    }
  }

  return result;
}

/**
 * 判断正文字符串中已被「原地渲染成交互式成果物小卡片」的路径键集合，
 * 供 `TurnGroup` 从末尾 `TurnDeliverables` 列表中剔除，消除正文与页脚双份重复展示。
 */
export function findInlineReferencedDeliverableKeys(
  content: string,
  deliverables: readonly DeliverableItem[],
): Set<string> {
  const matched = new Set<string>();
  if (!content || deliverables.length === 0) return matched;

  const outsideFence = stripFenceBlocks(stripMediaTags(content).cleanText);
  if (!outsideFence) return matched;

  const refs: string[] = [];
  let m: RegExpExecArray | null;
  const codeRe = /`([^`\r\n]+)`/g;
  while ((m = codeRe.exec(outsideFence)) !== null) {
    const key = normalizeDeliverableKey(m[1]);
    if (key) refs.push(key);
  }
  const mdLinkRe = /!?\[[^\]]*\]\(([^)\s]+(?:\s+["'][^"']*["'])?)\)/g;
  while ((m = mdLinkRe.exec(outsideFence)) !== null) {
    const rawTarget = m[1].replace(/\s+["'][^"']*["']$/, '').trim();
    const key = normalizeDeliverableKey(rawTarget);
    if (key) refs.push(key);
  }
  for (const bare of scanRawFilePathsInText(outsideFence)) {
    const key = normalizeDeliverableKey(bare);
    if (key) refs.push(key);
  }

  const basenameCounts = new Map<string, number>();
  for (const item of deliverables) {
    const itemKey = normalizeDeliverableKey(item.path);
    if (!itemKey) continue;
    const base = extractBasename(itemKey);
    if (base) basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }

  for (const item of deliverables) {
    const itemKey = normalizeDeliverableKey(item.path);
    if (!itemKey) continue;
    const itemBase = extractBasename(itemKey);
    const isHit = refs.some((refKey) => {
      if (refKey === itemKey) return true;
      if (!refKey.includes('/') && itemBase && refKey === itemBase && basenameCounts.get(itemBase) === 1) {
        return true;
      }
      const isAbs = itemKey.startsWith('/') || /^[a-zA-Z]:\//.test(itemKey);
      if (!isAbs) return false;
      if (refKey.startsWith('/') || /^[a-zA-Z]:\//.test(refKey)) {
        return itemKey.endsWith(refKey);
      }
      if (refKey.includes('/')) {
        return itemKey.endsWith(`/${refKey}`);
      }
      return false;
    });
    if (isHit) matched.add(itemKey);
  }

  return matched;
}
