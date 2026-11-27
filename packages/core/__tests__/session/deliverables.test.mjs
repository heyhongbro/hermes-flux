/**
 * 会话与回合成果物纯领域提取与 MEDIA 标签剥离单元测试
 * (packages/core/__tests__/session/deliverables.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeliverableKind,
  normalizeDeliverableKey,
  stripMediaTags,
  extractMessageDeliverables,
  extractTurnDeliverables,
  extractSessionDeliverables,
  extractUnverifiedCandidatePaths,
  findInlineReferencedDeliverableKeys,
} from '../../dist/session/deliverables.js';

test('classifyDeliverableKind & normalizeDeliverableKey: MIME / 扩展名 / DataURL 与路径键归一化', () => {
  assert.equal(classifyDeliverableKind(''), 'file');
  assert.equal(classifyDeliverableKind('unknown', 'image/webp'), 'image');
  assert.equal(classifyDeliverableKind('unknown', 'video/quicktime'), 'video');
  assert.equal(classifyDeliverableKind('unknown', 'text/html'), 'html');
  assert.equal(classifyDeliverableKind('unknown', 'text/markdown'), 'markdown');
  assert.equal(classifyDeliverableKind('plain', undefined), 'file');
  assert.equal(classifyDeliverableKind('plain', 'application/octet-stream'), 'file');
  assert.equal(classifyDeliverableKind('data:image/png;base64,AAAA'), 'image');
  assert.equal(classifyDeliverableKind('data:video/mp4;base64,BBBB'), 'video');
  assert.equal(classifyDeliverableKind('/out/report.pdf   ?v=1#top'), 'document');
  assert.equal(classifyDeliverableKind('/out/trailing/'), 'file');
  assert.equal(classifyDeliverableKind('.html'), 'file');
  assert.equal(classifyDeliverableKind('.pdf'), 'file');
  assert.equal(classifyDeliverableKind('clip.webm'), 'video');
  assert.equal(classifyDeliverableKind('  CLIP.JPG  '), 'image');
  assert.equal(classifyDeliverableKind('/out/preview.htm?v=2#frag'), 'html');
  assert.equal(classifyDeliverableKind('/out/PREVIEW.HTML'), 'html');
  assert.equal(classifyDeliverableKind('/out/.gitignore'), 'file');
  assert.equal(classifyDeliverableKind('/out/README.mdx'), 'markdown');
  assert.equal(classifyDeliverableKind('/out/report.pdf'), 'document');
  assert.equal(classifyDeliverableKind('/out/config.yaml'), 'document');
  assert.equal(classifyDeliverableKind('/out/config.yml'), 'document');
  assert.equal(classifyDeliverableKind('/repo/main.ts'), 'file');

  assert.equal(normalizeDeliverableKey('./C:\\Work\\Out\\chart.png:12:4'), 'C:/Work/Out/chart.png');
  assert.equal(normalizeDeliverableKey('""\'/out/a.png\'""'), '/out/a.png');
  assert.equal(normalizeDeliverableKey('./sub/./a.ts:10:20'), 'sub/./a.ts');
  assert.equal(normalizeDeliverableKey('/out/a.ts:42'), '/out/a.ts');
  assert.equal(normalizeDeliverableKey('/out/a.ts:1:2/extra'), '/out/a.ts:1:2/extra');
  assert.equal(normalizeDeliverableKey('/out/dir///'), '/out/dir');
  assert.equal(normalizeDeliverableKey('`C:\\Work\\Out\\chart.png`'), 'C:/Work/Out/chart.png');
  assert.equal(normalizeDeliverableKey('C:\\Work\\Out\\chart.png/'), 'C:/Work/Out/chart.png');
  assert.equal(normalizeDeliverableKey('   '), '');
  assert.equal(normalizeDeliverableKey('  DATA:image/png;base64,A1  '), 'DATA:image/png;base64,A1');
  assert.equal(normalizeDeliverableKey('  BLOB:https://app/id1  '), 'BLOB:https://app/id1');
  assert.equal(normalizeDeliverableKey('  HTTP://cdn.example.com/a.png  '), 'HTTP://cdn.example.com/a.png');
  assert.equal(normalizeDeliverableKey('  HTTPS://cdn.example.com/a.png?v=1  '), 'HTTPS://cdn.example.com/a.png?v=1');
});

test('stripMediaTags: 剥离真实 MEDIA 指令、忽略畸形值与完整保留围栏代码块（含闭合后恢复）', () => {
  // 非法或空输入守卫
  assert.deepEqual(stripMediaTags(''), { cleanText: '', mediaPaths: [] });
  assert.deepEqual(stripMediaTags(null), { cleanText: '', mediaPaths: [] });
  assert.deepEqual(stripMediaTags(undefined), { cleanText: '', mediaPaths: [] });
  assert.equal(stripMediaTags(123).mediaPaths.length, 0);
  assert.deepEqual(stripMediaTags('plain body without tag'), { cleanText: 'plain body without tag', mediaPaths: [] });

  const input = [
    'MEDIA:/out/head.png',
    '先看渲染结果：',
    'MEDIA:https://cdn.example.com/chart.png',
    'MEDIA:https://cdn.example.com/render/1',
    'MEDIA:http://cdn.example.com/render/2',
    'MEDIA:data:video/mp4;base64,VVVV',
    'MEDIA:""',
    'inline   \t  MEDIA:/out/inline.png  \t ',
    '',
    '',
    'A\nMEDIA:/out/solo.png\nB',
    'no-spaceMEDIA:/out/attached.png',
    '```markdown',
    'MEDIA:/fake/example-in-backticks.png',
    '```',
    '   ```js',
    'MEDIA:/fake/indented-fence.png',
    '   ```',
    '~~~txt',
    'MEDIA:/fake/example-in-tilde.png',
    '~~~',
    '非法语法保留 MEDIA:not_a_path_without_dot_or_slash',
    'MEDIA:#sec/a.png MEDIA:mailto:a@b.com/a.pdf MEDIA:tel:100/a.png MEDIA:data:application/pdf;base64,AA== MEDIA:data:text/plain;base64,QQ== MEDIA:vbscript:run MEDIA:javascript:safe.png MEDIA:data:text/html;base64,QQ==',
    'MEDIA:report.pdf MEDIA:notes.unknown MEDIA:enddata:x',
    'MEDIA:C:\\output\\demo.mp4',
  ].join('\n');

  const stripped = stripMediaTags(input);
  assert.deepEqual(stripped.mediaPaths, [
    '/out/head.png',
    'https://cdn.example.com/chart.png',
    'https://cdn.example.com/render/1',
    'http://cdn.example.com/render/2',
    'data:video/mp4;base64,VVVV',
    '/out/inline.png',
    '/out/solo.png',
    'report.pdf',
    'C:\\output\\demo.mp4',
  ]);
  assert.equal(stripped.cleanText.includes('MEDIA:/fake/example-in-backticks.png'), true, '围栏内示例代码必须完整保留');
  assert.equal(stripped.cleanText.includes('MEDIA:/fake/indented-fence.png'), true, '缩进围栏必须完整保留');
  assert.equal(stripped.cleanText.includes('MEDIA:/fake/example-in-tilde.png'), true, '波浪围栏内示例代码必须完整保留');
  assert.equal(stripped.cleanText.includes('MEDIA:not_a_path_without_dot_or_slash'), true, '非路径字面量不得误删');
  assert.equal(stripped.cleanText.includes('MEDIA:#sec/a.png'), true, '带后缀锚点也不得剥离');
  assert.equal(stripped.cleanText.includes('MEDIA:mailto:a@b.com/a.pdf'), true);
  assert.equal(stripped.cleanText.includes('MEDIA:tel:100/a.png'), true);
  assert.equal(stripped.cleanText.includes('MEDIA:data:text/plain;base64,QQ=='), true);
  assert.equal(stripped.cleanText.includes('no-spaceMEDIA:/out/attached.png'), true);
  assert.ok(stripped.cleanText.includes('\ninline\n\nA\nB\n'));
  assert.equal(stripped.cleanText.includes('inline   '), false, '同行剥离后尾空白必须清空');
  assert.equal(stripped.cleanText.includes('\n\n\n'), false, '连续空行必须收敛为最多两个换行');
  assert.equal(stripped.cleanText.includes('chart.png'), false);
  assert.equal(stripped.cleanText.includes('demo.mp4'), false);
});

test('extractMessageDeliverables: 工具产物（含嵌套数组与深度限制）、tc.output MEDIA 与附件边界守卫', () => {
  const ok2048 = `/out/${'a'.repeat(2039)}.png`;
  const longPath = `/out/${'a'.repeat(2040)}.png`;

  const items = extractMessageDeliverables({
    id: 'm-ast',
    role: 'assistant',
    content: [
      '![ok](https://cdn.example.com/arch.png "arch title")',
      '![ok2](https://cdn.example.com/arch2.png \'single title\')',
      '![angled](<https://cdn.example.com/angled.png>)',
      '![mdRel](/out/rel-img.png)',
      '![mdData](data:image/png;base64,DDDD)',
      '![mdBlob](blob:https://app/md-blob-1)',
      '![mdHttp](http://cdn.example.com/plain.jpg)',
      '![mdNotImg](/repo/not-an-image.ts)',
      '![bad](javascript:alert(1))',
      '![bad2](data:text/html;base64,PGgxPg==)',
      `![ok2048](${ok2048})`,
      `![tooLong](${longPath})`,
      '![ctrl31](/out/bad\x1f.png)',
      '![del](/out/bad\x7f.png)',
      '[httpPdf](http://x.com/a.pdf) [httpsPdf](https://x.com/a.pdf) [mailPdf](mailto:u@x.com/a.pdf) [telPdf](tel:123/a.pdf) [hashPdf](#dir/a.pdf) [dataOnly](data:image/png;base64,ONLYLINK==)',
      '[anchor](#section) [mail](mailto:hi@a.com) [tel](tel:10086) [dir](/out/folder/)',
      '[blob图](blob:https://app/b1)',
      '[文档](/out/spec.pdf)',
      '[specTitle](/out/spec-title.pdf   "my title")',
      '[specSingle](/out/spec-single.md  \'single\')',
      '[   trimmedLabel   ](/out/trimmed-label-doc.pdf)',
      '[源码](/repo/index.ts)',
      '[未知后缀](/repo/unknown.xyz)',
      '[无后缀](plain_token)',
      '```md',
      '![ignoredInFence](/fake/code-shot.png)',
      '[ignoredLink](/fake/in-fence.html)',
      '```',
    ].join('\n'),
    toolCalls: [
      null,
      // 空工具名、只读工具、未知非产出工具与无输出 shell 绝不可误认作成果物
      { id: 't-empty-name', name: '', imagePath: '   ' },
      { id: 't-read', name: 'read_file', args: '{"path":"/secret/key.txt"}', output: '/secret/key.txt' },
      { id: 't-read-prefix', name: 'read_file_write', args: '{"path":"/out/helper-gen.png"}' },
      { id: 't-nonout', name: 'fetch_status', args: '{"path":"/out/unknown-tool-ignored.png"}' },
      { id: 't-term', name: 'terminal', args: 'cat /etc/hosts', output: 'MEDIA:/out/from-term.mp4\n/not/a/deliverable.png' },
      { id: 't-ps', name: 'powershell', output: JSON.stringify({ image_path: '/out/shell-shot.png', path: '/out/ignored-shell-path.png' }) },
      // write/generate 工具：含合法 JSON（深层嵌套 + PATH_ARRAY_FIELDS 数组与对象）与畸形 JSON
      {
        id: 't-bad-json',
        name: 'write_file',
        args: 'plain-not-json',
        output: '[not-json',
      },
      {
        id: 't-prim',
        name: 'write_file',
        rawArgs: 123,
      },
      {
        id: 't-struct',
        name: 'generate_report',
        imagePath: '  < `/out/tool-img.png` >  ',
        rawArgs: {
          path: '<only-open.png',
          output_path: '  "\'\'/out/multi-quote.html\'\'"  ',
          file_path: 'C:\\win\\sub\\pic.png?v=1#h',
          images: ['/out/batch-1.png', ['/out/nested-in-array.png', { output_path: '/out/deep-arr-obj.html' }], { path: '/out/obj-in-arr.webp' }],
          artifacts: [
            null,
            {
              artifacts: [
                {
                  artifacts: [
                    {
                      output_path: '/out/depth3.html',
                      artifacts: [{ output_path: '/out/too-deep.png' }],
                    },
                  ],
                },
              ],
            },
          ],
          files: ['/out/with space.png', '<   >', '/out/dir///', 'plain_not_path', '/out/x.png>', 'D:\\shots\\trail.png/'],
          primitives: 42,
        },
        output: '  ' + JSON.stringify({
          files_modified: ['/out/final.md'],
          artifacts: [{ resolved_path: '/out/deck.pptx' }],
        }) + '  ',
      },
      {
        id: 't-json-arr',
        name: 'patch_file',
        args: '  [{"resolved_path": "/out/patched.md"}]  ',
      },
    ],
    attachments: [
      null,
      { id: 'att-empty', name: '' },
      { id: 'att-inline', name: '', type: 'image', previewUrl: 'data:image/png;base64,INLINE==' },
      { id: 'att-img-nomime', name: '', type: 'image', path: '/out/shot.jpeg' },
      { id: 'att-type-img', name: 'unnamed-photo', type: 'image', previewUrl: 'blob:https://app/img-blob-only' },
      { id: 'att-type-file', name: 'unnamed-doc', type: 'file', previewUrl: 'blob:https://app/file-blob-only' },
      { id: 'att-dup-1', name: 'dup.png', path: '/out/dup-keep.png', previewUrl: 'data:image/png;base64,KEEP1' },
      { id: 'att-dup-2', name: 'dup.png', path: '/out/dup-keep.png', previewUrl: 'data:image/png;base64,SECOND2' },
      { id: 'att-unsafe', name: 'snap.png', path: '/out/snap.png', previewUrl: 'javascript:alert(1)', mime: 'image/webp' },
      { id: 'att-chart-first', name: 'chart.jpg', path: '/out/chart.jpg' },
      { id: 'att-chart-upgrade', name: 'chart.jpg', path: '/out/chart.jpg', previewUrl: 'data:image/jpeg;base64,UPGRADED==' },
    ],
  });

  const paths = items.map((d) => d.path);
  assert.ok(paths.includes('/out/from-term.mp4'));
  assert.ok(paths.includes('/out/shell-shot.png'));
  assert.ok(paths.includes('/out/tool-img.png'));
  assert.ok(paths.includes('<only-open.png'), '仅有左尖括号时不得误裁剪首尾字符');
  assert.ok(paths.includes('/out/multi-quote.html'));
  assert.ok(paths.includes('C:\\win\\sub\\pic.png?v=1#h'));
  assert.ok(paths.includes('/out/helper-gen.png'), '仅完全匹配 READ_ONLY_TOOL_RE 时才跳过，带后缀的非只读名不跳过');
  assert.ok(paths.includes('/out/batch-1.png'));
  assert.ok(paths.includes('/out/nested-in-array.png'));
  assert.ok(paths.includes('/out/deep-arr-obj.html'));
  assert.ok(paths.includes('/out/obj-in-arr.webp'));
  assert.ok(paths.includes('/out/depth3.html'));
  assert.ok(paths.includes('/out/final.md'));
  assert.ok(paths.includes('/out/deck.pptx'));
  assert.ok(paths.includes('/out/patched.md'));
  assert.ok(paths.includes('https://cdn.example.com/arch.png'));
  assert.ok(paths.includes('https://cdn.example.com/arch2.png'));
  assert.ok(paths.includes('https://cdn.example.com/angled.png'));
  assert.ok(paths.includes('/out/rel-img.png'));
  assert.ok(paths.includes('data:image/png;base64,DDDD'));
  assert.ok(paths.includes('blob:https://app/md-blob-1'));
  assert.ok(paths.includes('http://cdn.example.com/plain.jpg'));
  assert.ok(paths.includes(ok2048), '恰好 2048 字符路径必须允许');
  assert.ok(paths.includes('/out/with space.png'), '空格 charCode 32 必须允许');
  assert.ok(paths.includes('blob:https://app/b1'));
  assert.ok(paths.includes('/out/spec.pdf'));
  assert.ok(paths.includes('/out/spec-title.pdf'));
  assert.ok(paths.includes('/out/spec-single.md'));
  assert.ok(paths.includes('/out/trimmed-label-doc.pdf'));
  assert.ok(paths.includes('/repo/index.ts'));
  assert.ok(paths.includes('/out/snap.png'));
  assert.ok(paths.includes('/out/chart.jpg'));
  assert.ok(paths.includes('/out/shot.jpeg'));

  // 危险/围栏/超深/只读/未知工具/非图片 Markdown img/外链/非法字符不得误入产物
  assert.equal(paths.includes('/out/ignored-shell-path.png'), false);
  assert.equal(paths.includes('/out/unknown-tool-ignored.png'), false);
  assert.equal(paths.includes('/out/x.png>'), false);
  assert.equal(paths.includes('/out/dir///'), false);
  assert.equal(paths.includes('plain_not_path'), false);
  assert.equal(paths.includes('/repo/not-an-image.ts'), false, 'Markdown ![]() 指向非图片文件不得误收入成果物');
  assert.equal(paths.includes('/fake/in-fence.html'), false);
  assert.equal(paths.includes('/repo/unknown.xyz'), false);
  assert.equal(paths.includes('plain_token'), false);
  assert.equal(paths.includes('/secret/key.txt'), false);
  assert.equal(paths.includes('/fake/code-shot.png'), false);
  assert.equal(paths.includes('/out/too-deep.png'), false);
  assert.equal(paths.includes(longPath), false);
  assert.equal(paths.includes('#section'), false);
  assert.equal(paths.includes('/out/folder/'), false);
  assert.equal(paths.includes('http://x.com/a.pdf'), false);
  assert.equal(paths.includes('https://x.com/a.pdf'), false);
  assert.equal(paths.includes('mailto:u@x.com/a.pdf'), false);
  assert.equal(paths.includes('tel:123/a.pdf'), false);
  assert.equal(paths.includes('#dir/a.pdf'), false);
  assert.equal(paths.includes('data:image/png;base64,ONLYLINK=='), false);

  const archItem = items.find((d) => d.path === 'https://cdn.example.com/arch.png');
  assert.equal(archItem?.name, 'arch.png');
  assert.equal(archItem?.kind, 'image');
  assert.equal(archItem?.previewUrl, 'https://cdn.example.com/arch.png');
  assert.equal(archItem?.source, 'markdown_image');
  assert.equal(archItem?.messageId, 'm-ast');
  assert.ok(archItem?.id.startsWith('deliv-'));
  assert.equal(items.find((d) => d.path === 'http://cdn.example.com/plain.jpg')?.previewUrl, 'http://cdn.example.com/plain.jpg');
  assert.equal(items.find((d) => d.path === 'data:image/png;base64,DDDD')?.previewUrl, 'data:image/png;base64,DDDD');
  assert.equal(items.find((d) => d.path === 'blob:https://app/md-blob-1')?.previewUrl, 'blob:https://app/md-blob-1');
  assert.equal(items.find((d) => d.path === '/out/rel-img.png')?.previewUrl, undefined);

  assert.equal(items.find((d) => d.path === '/out/tool-img.png')?.source, 'tool_image');
  assert.equal(items.find((d) => d.path === 'C:\\win\\sub\\pic.png?v=1#h')?.name, 'pic.png');
  assert.equal(items.find((d) => d.path === 'C:\\win\\sub\\pic.png?v=1#h')?.source, 'tool_write');
  assert.equal(items.find((d) => d.path === '/out/from-term.mp4')?.source, 'media_tag');
  assert.equal(items.find((d) => d.path === '/out/trimmed-label-doc.pdf')?.source, 'markdown_link');
  assert.equal(items.find((d) => d.path === '/out/trimmed-label-doc.pdf')?.name, 'trimmed-label-doc.pdf');

  const inlineAtt = items.find((d) => d.path === 'data:image/png;base64,INLINE==');
  assert.equal(inlineAtt?.name, 'media');
  assert.equal(inlineAtt?.kind, 'image');
  assert.equal(inlineAtt?.source, 'content_part');

  assert.equal(items.find((d) => d.path === 'blob:https://app/img-blob-only')?.kind, 'image');
  assert.equal(items.find((d) => d.path === 'blob:https://app/file-blob-only')?.kind, 'file');
  assert.equal(items.find((d) => d.path === '/out/dup-keep.png')?.previewUrl, 'data:image/png;base64,KEEP1');

  const jpegAtt = items.find((d) => d.path === '/out/shot.jpeg');
  assert.equal(jpegAtt?.name, 'shot.jpeg');
  assert.equal(jpegAtt?.kind, 'image');

  const unsafeAtt = items.find((d) => d.path === '/out/snap.png');
  assert.equal(unsafeAtt?.previewUrl, undefined, '不安全的 attachment previewUrl 必须被剥离');
  assert.equal(unsafeAtt?.mime, 'image/webp');
  assert.equal(unsafeAtt?.kind, 'image');
  const upgradedChart = items.find((d) => d.path === '/out/chart.jpg');
  assert.equal(upgradedChart?.previewUrl, 'data:image/jpeg;base64,UPGRADED==', '后出现的 previewUrl 必须补全已有去重项');

  // content 缺省 undefined 时安全跳过
  assert.deepEqual(extractMessageDeliverables({ id: 'm-nocontent', role: 'assistant' }), []);

  // 非 assistant 消息（user / system）绝不提取产物
  assert.deepEqual(
    extractMessageDeliverables({ id: 'u1', role: 'user', content: 'MEDIA:/out/user-upload.png' }),
    [],
  );
  const turnItems = extractTurnDeliverables([
    { id: 'u1', role: 'user', content: 'MEDIA:/out/user.png' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'MEDIA:/out/a.png',
      attachments: [{ id: 'at1', name: 'att.png', path: '/out/att.png', mime: 'image/png', previewUrl: 'data:image/png;base64,T1' }],
    },
    { id: 'a2', role: 'assistant', content: 'MEDIA:/out/a.png\nMEDIA:/out/b.html' },
  ]);
  assert.deepEqual(turnItems.map((d) => d.path), ['/out/att.png', '/out/a.png', '/out/b.html']);
  assert.equal(turnItems.find((d) => d.path === '/out/att.png')?.mime, 'image/png');
  assert.equal(turnItems.find((d) => d.path === '/out/att.png')?.previewUrl, 'data:image/png;base64,T1');

  // extractSessionDeliverables 最新消息产出排在最前、保留 mime/previewUrl 并全局去重
  const sessionItems = extractSessionDeliverables([
    {
      id: 'a1',
      role: 'assistant',
      content: 'MEDIA:/out/first.png\nMEDIA:/out/shared.png',
      attachments: [{ id: 's-at', name: 'first-att.png', path: '/out/first-att.png', mime: 'image/png', previewUrl: 'data:image/png;base64,S1' }],
    },
    { id: 'a2', role: 'assistant', content: 'MEDIA:/out/latest.html\nMEDIA:/out/shared.png' },
  ]);
  const sessionOut = sessionItems.map((d) => d.path);
  assert.equal(sessionOut.length, 4);
  assert.ok(sessionOut.indexOf('/out/latest.html') < sessionOut.indexOf('/out/first.png'));
  assert.ok(sessionOut.indexOf('/out/shared.png') < sessionOut.indexOf('/out/first.png'));
  assert.equal(sessionItems.find((d) => d.path === '/out/first-att.png')?.mime, 'image/png');
  assert.equal(sessionItems.find((d) => d.path === '/out/first-att.png')?.previewUrl, 'data:image/png;base64,S1');
});

test('extractTurnDeliverables / findInlineReferencedDeliverableKeys: Tier A inlineDiff + 子代理写入 + Tier B 双锁与读写隔离', () => {
  const htmlPath = '/workspace/demo-project/drafts/release-report.html';
  const mdPath = '/workspace/demo-project/drafts/summary-post.md';
  const pngPath = '/workspace/demo-project/drafts/img/release-timeline.png';
  const silentImg = '/workspace/demo-project/drafts/img/silent.png';

  const turnMessages = [
    {
      id: 'm-1',
      role: 'assistant',
      content: [
        `- 报告：\`${htmlPath}\``,
        `- 摘要：${mdPath}`,
        `- 信息图：\`${pngPath}\``,
        '```sh',
        'cat /etc/hosts',
        '```',
        '参考配置文件 `/etc/hosts` 与 `/opt/data/readonly/secret.md` 以及 `/opt/data/missing/phantom.png`。',
      ].join('\n'),
      toolCalls: [
        {
          id: 'tc-read',
          name: 'read_file',
          args: JSON.stringify({ path: '/opt/data/readonly/secret.md' }),
        },
        {
          id: 'tc-cat',
          name: 'terminal',
          args: JSON.stringify({ command: 'cat /etc/hosts' }),
          output: '/opt/data/readonly/secret.md',
        },
        {
          id: 'tc-write-html',
          name: 'write_file',
          args: JSON.stringify({ path: htmlPath }),
        },
        {
          id: 'tc-diff-md',
          name: 'patch',
          args: JSON.stringify({ path: mdPath }),
          inlineDiff: '@@ -1 +1 @@\n-old\n+new',
        },
        {
          id: 'tc-gen-img',
          name: 'execute_code',
          args: JSON.stringify({ command: 'python3 render_timeline.py' }),
          output: `Saved timeline figure to ${pngPath}`,
        },
        {
          id: 'tc-silent',
          name: 'generate_image',
          imagePath: silentImg,
          args: '{}',
        },
      ],
    },
  ];

  const turnDeliverables = extractTurnDeliverables(turnMessages, {
    verifiedExistingPaths: ['/opt/data/readonly/secret.md', '/etc/hosts', '/opt/data/verified/extra.pdf'],
    subagentWrittenPaths: ['/opt/data/subagent/summary.md'],
  });
  const byPath = new Map(turnDeliverables.map((d) => [d.path, d]));

  assert.equal(byPath.get(htmlPath)?.source, 'tool_write');
  assert.equal(byPath.get(mdPath)?.source, 'tool_write', '带 inlineDiff 的写入工具必须提取');
  assert.equal(byPath.get(pngPath)?.source, 'turn_corroborated', '同回合非只读脚本输出提及 png 必须 Lock 1 放行');
  assert.equal(byPath.get(silentImg)?.source, 'tool_image');
  assert.equal(byPath.get('/opt/data/subagent/summary.md')?.source, 'subagent_write');
  assert.equal(byPath.has('/opt/data/readonly/secret.md'), false, 'read_file 读过的文件绝不可升格为成果物');
  assert.equal(byPath.has('/etc/hosts'), false, 'OS 系统路径绝不可进入成果物');
  assert.equal(byPath.has('/opt/data/missing/phantom.png'), false, '未经双锁印证的幻觉路径不可进入');

  // Lock 2: verified_mention 仅在助手明确提及 + verifiedExistingPaths 包含 + 不在只读集合时放行
  const lock2Msgs = [
    {
      id: 'm-lock2',
      role: 'assistant',
      content: '额外导出 `/opt/data/verified/extra.pdf` 与 `/opt/data/readonly/secret.md`。\n```txt\n/opt/data/fenced/only.md\n```',
      toolCalls: [{ id: 'r1', name: 'read_file', args: '{"path":"/opt/data/readonly/secret.md"}' }],
    },
  ];
  const lock2Unverified = extractUnverifiedCandidatePaths(lock2Msgs);
  assert.deepEqual(lock2Unverified, ['/opt/data/verified/extra.pdf']);
  const lock2Items = extractTurnDeliverables(lock2Msgs, {
    verifiedExistingPaths: ['/opt/data/verified/extra.pdf', '/opt/data/readonly/secret.md'],
  });
  assert.deepEqual(lock2Items.map((d) => ({ path: d.path, source: d.source })), [
    { path: '/opt/data/verified/extra.pdf', source: 'verified_mention' },
  ]);

  // 正文原地引用去重键识别
  const inlineKeys = findInlineReferencedDeliverableKeys(turnMessages[0].content, turnDeliverables);
  assert.equal(inlineKeys.has(normalizeDeliverableKey(htmlPath)), true);
  assert.equal(inlineKeys.has(normalizeDeliverableKey(mdPath)), true, '裸路径同样必须命中原地去重');
  assert.equal(inlineKeys.has(normalizeDeliverableKey(pngPath)), true);
  assert.equal(inlineKeys.has(normalizeDeliverableKey(silentImg)), false, '未在正文出现的 silentImg 保留在末尾展示');

  // 无空格逗号分隔裸路径拆分，以及唯一 basename 原地引用去重键对齐
  const commaAndBase = extractTurnDeliverables(
    [
      {
        id: 'm-comma',
        role: 'assistant',
        content: '产物列表：/out/first.html,/out/second.md',
        toolCalls: [
          { id: 'w-1', name: 'write_file', args: JSON.stringify({ path: '/out/first.html' }) },
          { id: 'w-2', name: 'write_file', args: JSON.stringify({ path: '/out/second.md' }) },
        ],
      },
    ],
    { verifiedExistingPaths: ['/out/first.html', '/out/second.md'] },
  );
  assert.equal(commaAndBase.length, 2);
  const commaKeys = findInlineReferencedDeliverableKeys('见 `first.html` 与 /out/first.html,/out/second.md', commaAndBase);
  assert.equal(commaKeys.has('/out/first.html'), true, '唯一 basename 反引号引用必须命中去重键');
  assert.equal(commaKeys.has('/out/second.md'), true, '无空格英文逗号分隔的裸路径必须拆开识别');
});
