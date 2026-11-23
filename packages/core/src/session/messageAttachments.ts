/**
 * 消息附件纯领域解析与格式化原语 (packages/core/src/session/messageAttachments.ts)
 *
 * 【设计意图 (Why)】
 *   统一跨桌面端与移动端的用户附件清单格式、历史记录还原与多模态分片提取：
 *   1. 发送前由 `formatAttachmentPromptText` 生成结构化 `[附件列表]` / `[Attachment List]` 清单，
 *      既让远端模型感知附件文件名，又确保仅发送图片/文件不输入文字时也能提交非空提示；
 *   2. 发送后或历史重载 (`transcriptRows.ts` / `desktopCacheBridge.ts`) 时，由 `extractMessageAttachments`
 *      将清单元数据与正文剥离并还原为结构化 `MessageAttachmentItem[]`，让用户气泡展示真实缩略图或文件卡片，
 *      不再把机器清单原文赤裸堆进气泡里或丢失附件展示。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 仅发附件不打字时，若调用方只检查 `text.trim()` 会误拦提交或生成空气泡；
 *   2. 网关历史行中的 `content` 可能是纯文本清单、也可能带多模态 `{ type: 'image_url' }` 数组分片，
 *      二者必须在同一纯函数内去重融合，防止缩略图与文件名重复或错配；
 *   3. 英文与中文界面发送的清单头分别是 `[Attachment List]` 与 `[附件列表]`，切换语言后必须仍能双向识别。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React / Electron 依赖；
 *   - 纯函数、无副作用，不修改入参数组。
 */

export interface MessageAttachmentItem {
  id: string;
  name: string;
  label?: string;
  type: 'image' | 'file' | 'pdf';
  previewUrl?: string;
  sizeBytes?: number;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const ATTACHMENT_MANIFEST_RE = /^\[(附件列表|Attachment List)\]\r?\n((?:- [^\r\n]+(?:\r?\n|$))+)(?:\r?\n)?/;

/**
 * 依据 MIME 类型与文件名扩展名归一化附件类别（图片 / PDF / 普通文件）。
 */
export function inferAttachmentType(name: string, mimeType = ''): 'image' | 'file' | 'pdf' {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  const cleanName = name.split(/[?#]/)[0].trim().toLowerCase();
  if (IMAGE_EXT_RE.test(cleanName)) return 'image';
  if (cleanName.endsWith('.pdf')) return 'pdf';
  return 'file';
}

/**
 * 将用户输入正文与待发送附件列表拼接为发送给网关的标准化 Prompt 文本。
 */
export function formatAttachmentPromptText(
  text: string,
  attachments: readonly MessageAttachmentItem[],
  headerLabel: string,
): string {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;

  let imgIndex = 0;
  let docIndex = 0;
  const lines = attachments.map((att) => {
    const isImg = att.type === 'image';
    const fallbackLabel = isImg ? `Image ${++imgIndex}` : `Doc ${++docIndex}`;
    const label = att.label || fallbackLabel;
    return `- ${label}: ${att.name}`;
  });

  const manifest = `[${headerLabel}]\n${lines.join('\n')}`;
  return trimmed ? `${manifest}\n\n${trimmed}` : manifest;
}

function readRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
}

const SAFE_PREVIEW_URL_RE = /^(?:data:image\/|https?:\/\/|blob:)/i;
const BARE_BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

function normalizeAttachmentPreviewUrl(raw: unknown, allowBareBase64 = false): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (SAFE_PREVIEW_URL_RE.test(trimmed)) return trimmed;
  if (allowBareBase64 && !trimmed.includes(':') && BARE_BASE64_RE.test(trimmed)) {
    const compact = trimmed.replace(/\s+/g, '');
    return `data:image/png;base64,${compact}`;
  }
  return '';
}

/**
 * 从网关原始文本及多模态分片数组中剥离附件清单并还原结构化附件条目。
 */
export function extractMessageAttachments(
  rawText: string,
  rawContentParts?: readonly unknown[],
): { cleanText: string; attachments: MessageAttachmentItem[] } {
  const attachments: MessageAttachmentItem[] = [];
  let cleanText = rawText;

  const manifestMatch = ATTACHMENT_MANIFEST_RE.exec(rawText);
  if (manifestMatch) {
    const linesBlock = manifestMatch[2];
    const rawLines = linesBlock.split(/\r?\n/).filter((line) => line.startsWith('- '));
    rawLines.forEach((line, idx) => {
      const body = line.slice(2).trim();
      const kvMatch = /^([^:\r\n]+):(?:\s*(.*))?$/.exec(body);
      const label = kvMatch ? kvMatch[1].trim() : '';
      const name = kvMatch ? (kvMatch[2] ?? '').trim() : body;
      const type = /^image\b/i.test(label) ? 'image' : inferAttachmentType(name);
      attachments.push({
        id: `hist-att-${idx}-${name}`,
        name: name || `attachment_${idx + 1}`,
        ...(label ? { label } : {}),
        type,
      });
    });
    cleanText = rawText.slice(manifestMatch[0].length).replace(/^\r?\n+/, '');
  }

  if (rawContentParts) {
    let partIdx = 0;
    for (const part of rawContentParts) {
      const rec = readRecord(part);
      if (!rec) continue;
      let previewUrl = '';
      if (rec.type === 'image_url') {
        const imgObj = readRecord(rec.image_url);
        previewUrl = normalizeAttachmentPreviewUrl(imgObj?.url, false);
      } else if (rec.type === 'image') {
        previewUrl = normalizeAttachmentPreviewUrl(rec.url, false) || normalizeAttachmentPreviewUrl(rec.data, true);
      }
      if (!previewUrl) continue;

      const partName =
        typeof rec.filename === 'string' && rec.filename.trim()
          ? rec.filename.trim()
          : typeof rec.name === 'string' && rec.name.trim()
            ? rec.name.trim()
            : `Image ${++partIdx}`;

      const pendingImage = attachments.find((a) => a.type === 'image' && !a.previewUrl);
      if (pendingImage) {
        pendingImage.previewUrl = previewUrl;
        continue;
      }

      const duplicate = attachments.some((a) => a.previewUrl === previewUrl);
      if (!duplicate) {
        attachments.push({
          id: `part-att-${attachments.length}`,
          name: partName,
          type: 'image',
          previewUrl,
        });
      }
    }
  }

  return { cleanText, attachments };
}
