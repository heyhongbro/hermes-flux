import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMessageAttachments,
  formatAttachmentPromptText,
  inferAttachmentType,
} from '../../dist/index.js';

test('inferAttachmentType 覆盖 MIME 类型与文件名扩展名分支', () => {
  assert.equal(inferAttachmentType('photo', 'image/png'), 'image');
  assert.equal(inferAttachmentType('spec', 'application/pdf'), 'pdf');
  assert.equal(inferAttachmentType('screen.WEBP'), 'image');
  assert.equal(inferAttachmentType('photo.jpg?size=100'), 'image');
  assert.equal(inferAttachmentType('report.PDF'), 'pdf');
  assert.equal(inferAttachmentType('notes.md', 'text/markdown'), 'file');
  assert.equal(inferAttachmentType('README'), 'file');
});

test('formatAttachmentPromptText 与 extractMessageAttachments 往返解析中英文清单及多模态分片', () => {
  assert.equal(formatAttachmentPromptText('  hello  ', [], '附件列表'), 'hello');

  const items = [
    { id: '1', name: 'chart.png', label: 'Image 1', type: 'image', previewUrl: 'data:image/png;base64,abc' },
    { id: '2', name: 'spec.pdf', type: 'pdf' },
    { id: '3', name: 'pic.webp', type: 'image' },
  ];

  const zhCombined = formatAttachmentPromptText('请帮我分析这些附件', items, '附件列表');
  assert.match(zhCombined, /^\[附件列表\]\n- Image 1: chart\.png\n- Doc 1: spec\.pdf\n- Image 2: pic\.webp\n\n请帮我分析这些附件$/);

  const parsedZh = extractMessageAttachments(zhCombined, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,img1' }, filename: 'chart.png' },
    { type: 'image', data: 'data:image/webp;base64,img2', name: 'pic.webp' },
    { type: 'image', url: 'https://example.com/extra.png' },
    { type: 'image', url: 'https://example.com/extra.png' },
    { type: 'text', text: 'ignored' },
    null,
  ]);
  assert.equal(parsedZh.cleanText, '请帮我分析这些附件');
  assert.equal(parsedZh.attachments.length, 4);
  assert.equal(parsedZh.attachments[0].name, 'chart.png');
  assert.equal(parsedZh.attachments[0].type, 'image');
  assert.equal(parsedZh.attachments[0].previewUrl, 'data:image/png;base64,img1');
  assert.equal(parsedZh.attachments[1].name, 'spec.pdf');
  assert.equal(parsedZh.attachments[1].type, 'pdf');
  assert.equal(parsedZh.attachments[2].previewUrl, 'data:image/webp;base64,img2');
  assert.equal(parsedZh.attachments[3].previewUrl, 'https://example.com/extra.png');
  assert.equal(parsedZh.attachments[3].name, 'Image 1');

  // 仅发附件无用户输入文字 + 英文 header + 无冒号回退行
  const attachOnly = formatAttachmentPromptText('   ', [{ id: 'a', name: 'doc.txt', type: 'file' }], 'Attachment List');
  assert.equal(attachOnly, '[Attachment List]\n- Doc 1: doc.txt');
  const parsedEn = extractMessageAttachments('[Attachment List]\r\n- bare-file.bin\r\n- Image 1: \r\n\r\nLook here');
  assert.equal(parsedEn.cleanText, 'Look here');
  assert.equal(parsedEn.attachments.length, 2);
  assert.equal(parsedEn.attachments[0].name, 'bare-file.bin');
  assert.equal(parsedEn.attachments[0].label, undefined);
  assert.equal(parsedEn.attachments[1].type, 'image');
  assert.equal(parsedEn.attachments[1].name, 'attachment_2');

  // 安全 URL 白名单与裸 Base64 归一化/拒绝分支（不安全/无效 PreviewURL 应安全过滤）
  const parsedSafe = extractMessageAttachments('check urls', [
    { type: 'image_url', image_url: { url: 'blob:https://app.local/blob-1' }, filename: 'blob.png' },
    { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk', name: 'bare.png' },
    { type: 'image_url', image_url: { url: 'javascript:alert(1)' }, filename: 'xss.png' },
    { type: 'image', url: 'file:///etc/passwd', name: 'local.png' },
    { type: 'image', url: '   ', name: 'blank.png' },
    { type: 'image', data: 'short!', name: 'bad-bare.png' },
  ]);
  assert.equal(parsedSafe.attachments.length, 2);
  assert.equal(parsedSafe.attachments[0].previewUrl, 'blob:https://app.local/blob-1');
  assert.equal(parsedSafe.attachments[1].previewUrl?.startsWith('data:image/png;base64,iVBORw0KGgo'), true);

  // 普通无附件文本原样保留
  const plain = extractMessageAttachments('just text');
  assert.equal(plain.cleanText, 'just text');
  assert.deepEqual(plain.attachments, []);
});
