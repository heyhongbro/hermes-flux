/**
 * 输入舱附件拾取与 DataURL 编码读取辅助（Input Attachment Picker Helpers）
 *
 * 【设计意图 (Why)】
 *   将浏览器原生文件选择弹窗与 FileReader DataURL 预读编码逻辑从 inputDockController 中拆出，
 *   降低单文件复杂度并保持输入舱交互控制器的高内聚与可测性。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 图片超出 10MB 时必须立即告警并跳过，非图片超出 5MB 时保留文件名摘要但不塞入超大 Base64；
 *   2. 隐藏 `<input type="file">` 无论选定或取消都必须解绑回调并从 body 移除，防止 DOM 节点泄漏。
 *
 * 【约束与规则 (Rules)】
 *   仅依赖 @hermes-flux/core 与 @hermes-flux/ui 纯导出，严禁反向依赖宿主控制器。
 */

import { inferAttachmentType } from '@hermes-flux/core';
import type { InputAttachmentItem } from '@hermes-flux/ui';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILE_READ_SIZE = 5 * 1024 * 1024; // 5MB

function readFileAsDataUrl(targetFile: File): Promise<string> {
  return new Promise<string>((resolve) => {
    if (typeof FileReader === 'undefined') {
      resolve('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) || '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(targetFile);
  });
}

/**
 * 将 FileList 或 File[] 转换为统一输入舱附件列表（超限图片触发回调告警）。
 */
export async function buildInputAttachmentsFromFiles(
  fileList: FileList | File[],
  existingAttachments: readonly InputAttachmentItem[],
  onImageTooLarge: () => void,
): Promise<InputAttachmentItem[]> {
  const files = Array.from(fileList);
  if (files.length === 0) return [];

  let imgIndex = existingAttachments.filter((a) => a.type === 'image').length;
  let docIndex = existingAttachments.filter((a) => a.type !== 'image').length;
  const newItems: InputAttachmentItem[] = [];

  for (const file of files) {
    const attType = inferAttachmentType(file.name, file.type);
    const isImg = attType === 'image';
    if (isImg && file.size > MAX_IMAGE_SIZE) {
      onImageTooLarge();
      continue;
    }

    if (isImg) {
      imgIndex++;
      const dataUrl = await readFileAsDataUrl(file);
      newItems.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name || `image_${imgIndex}.png`,
        label: `Image ${imgIndex}`,
        type: 'image',
        previewUrl: dataUrl,
        sizeBytes: file.size,
      });
    } else {
      docIndex++;
      const dataUrl = file.size <= MAX_FILE_READ_SIZE ? await readFileAsDataUrl(file) : '';
      newItems.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name || `file_${docIndex}`,
        label: `Doc ${docIndex}`,
        type: attType,
        sizeBytes: file.size,
        contentBase64: dataUrl || undefined,
      });
    }
  }

  return newItems;
}

/**
 * 唤起浏览器原生多选文件弹窗，并在确认选定后回调 FileList。
 */
export function openBrowserAttachmentPicker(onPicked: (files: FileList) => void): void {
  if (typeof document === 'undefined' || !document.body) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:0;height:0;';
  const cleanup = (): void => {
    inp.onchange = null;
    inp.oncancel = null;
    if (inp.parentNode) inp.parentNode.removeChild(inp);
  };
  inp.onchange = () => {
    const picked = inp.files;
    cleanup();
    if (picked && picked.length > 0) {
      onPicked(picked);
    }
  };
  inp.oncancel = cleanup;
  document.body.appendChild(inp);
  inp.click();
}
