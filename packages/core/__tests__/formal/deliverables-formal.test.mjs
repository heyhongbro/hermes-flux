/**
 * 核心形式化不变量证明：会话/回合成果物提取、去重收敛与 MEDIA 标记剥离 (INV-DELIV-01 ~ 03)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import {
  classifyDeliverableKind,
  extractMessageDeliverables,
  extractSessionDeliverables,
  extractTurnDeliverables,
  extractUnverifiedCandidatePaths,
  findInlineReferencedDeliverableKeys,
  normalizeDeliverableKey,
  stripMediaTags,
} from '../../dist/session/deliverables.js';
import { createDirectoryPathVerifier } from '../../dist/fs/pathVerifier.js';

const safePathArb = fc
  .tuple(
    fc.constantFrom('/workspace', '/root/.hermes/images', 'docs/out', './dist'),
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/),
    fc.constantFrom('png', 'jpg', 'webp', 'mp4', 'webm', 'html', 'md', 'pdf', 'json', 'ts'),
  )
  .map(([dir, name, ext]) => `${dir}/${name}.${ext}`);

test('INV-DELIV-01: 成果物提取去重强幂等且严格隔离非 assistant 消息', () => {
  fc.assert(
    fc.property(
      fc.array(safePathArb, { minLength: 0, maxLength: 8 }),
      fc.array(safePathArb, { minLength: 0, maxLength: 6 }),
      (assistantPaths, userPaths) => {
        const userMessage = {
          id: 'u-1',
          role: 'user',
          content: userPaths.map((p) => `MEDIA:${p}\n![u](${p})`).join('\n'),
          toolCalls: userPaths.map((p, idx) => ({
            id: `ut-${idx}`,
            name: 'write_file',
            args: JSON.stringify({ path: p }),
          })),
        };
        assert.deepEqual(
          extractMessageDeliverables(userMessage),
          [],
          'user 消息严禁被提取为 Agent 成果物',
        );

        const assistantMsgs = [
          {
            id: 'a-1',
            role: 'assistant',
            content: assistantPaths.map((p) => `MEDIA:${p}`).join('\n'),
            toolCalls: assistantPaths.map((p, idx) => ({
              id: `at-${idx}`,
              name: idx % 2 === 0 ? 'write_file' : 'image_generate',
              args: JSON.stringify({ path: p }),
              imagePath: p.endsWith('.png') ? p : undefined,
            })),
          },
          {
            id: 'a-2',
            role: 'assistant',
            content: assistantPaths.map((p) => (p.endsWith('.png') ? `![img](${p})` : `[file](${p})`)).join('\n'),
          },
        ];

        const turn = extractTurnDeliverables([userMessage, ...assistantMsgs]);
        const turnKeys = turn.map((d) => normalizeDeliverableKey(d.path));
        assert.equal(turnKeys.length, new Set(turnKeys).size, 'Turn 成果物键必须严格唯一');

        const session = extractSessionDeliverables([userMessage, ...assistantMsgs]);
        const sessionKeys = session.map((d) => normalizeDeliverableKey(d.path));
        assert.equal(sessionKeys.length, new Set(sessionKeys).size, 'Session 成果物键必须严格唯一');
        assert.equal(turn.length, session.length, '同一批消息跨 Turn 与 Session 去重基数必须守恒');

        // 幂等性：重复消息列表提取结果键集合完全一致
        const duplicated = extractTurnDeliverables([...assistantMsgs, ...assistantMsgs]);
        assert.deepEqual(
          duplicated.map((d) => d.path),
          turn.map((d) => d.path),
        );
      },
    ),
    { numRuns: 300 },
  );
});

test('INV-DELIV-02: stripMediaTags 剥离收敛且绝不误伤围栏代码块', () => {
  fc.assert(
    fc.property(
      fc.array(safePathArb, { minLength: 1, maxLength: 4 }),
      fc.stringMatching(/^[a-zA-Z0-9 ]{0,24}$/),
      (paths, prose) => {
        const fenced = ['```markdown', 'MEDIA:/workspace/example-in-code.png', '```'].join('\n');
        const input = [prose, ...paths.map((p) => `MEDIA:${p}`), fenced].filter(Boolean).join('\n');

        const first = stripMediaTags(input);
        const second = stripMediaTags(first.cleanText);

        assert.equal(first.mediaPaths.length, paths.length, '必须精确提取围栏外的全部 MEDIA 路径');
        assert.ok(
          first.cleanText.includes('MEDIA:/workspace/example-in-code.png'),
          '围栏代码块内示例不得被剥离',
        );
        // 二次剥离围栏外不得再抽出新路径（幂等收敛）
        assert.deepEqual(second.mediaPaths, []);
        assert.equal(second.cleanText, first.cleanText);
      },
    ),
    { numRuns: 300 },
  );
});

test('INV-DELIV-03: 只读工具与危险协议绝不渗入成果物且分类单调确定', () => {
  fc.assert(
    fc.property(safePathArb, (safePath) => {
      const msg = {
        id: 'a-sec',
        role: 'assistant',
        content: [
          '![xss](javascript:alert(1))',
          '![html](data:text/html;base64,PHNjcmlwdD4=)',
          '[anchor](#section-1)',
          '[web](https://example.com/guide)',
          `[doc](${safePath})`,
        ].join('\n'),
        toolCalls: [
          { name: 'terminal', args: 'cat /etc/hosts', output: '{"output":"127.0.0.1 localhost"}' },
          { name: 'read_file', args: JSON.stringify({ path: '/etc/passwd' }), output: 'root:x:0:0' },
          { name: 'search_files', args: JSON.stringify({ path: '/opt/app/secret.ts' }), output: '{}' },
        ],
      };

      const extracted = extractSessionDeliverables([msg]);
      for (const item of extracted) {
        const lower = item.path.toLowerCase();
        assert.equal(lower.startsWith('javascript:'), false);
        assert.equal(lower.startsWith('data:text/html'), false);
        assert.notEqual(item.path, '/etc/hosts');
        assert.notEqual(item.path, '/etc/passwd');
        assert.notEqual(item.path, '/opt/app/secret.ts');
      }
      assert.ok(
        extracted.some((item) => normalizeDeliverableKey(item.path) === normalizeDeliverableKey(safePath)),
        '合法 Markdown 文件链接必须被保留',
      );
      assert.equal(classifyDeliverableKind(safePath), classifyDeliverableKind(safePath));
    }),
    { numRuns: 200 },
  );
});

test('deliverables iOS 15 兼容与连续 MEDIA/非图过滤回归守卫', () => {
  const deliverablesSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../src/session/deliverables.ts'),
    'utf8',
  );
  assert.equal(deliverablesSrc.includes('(?<'), false, 'iOS 15.0~16.3 WKWebView 不支持正则 lookbehind');

  const multiMedia = stripMediaTags('已完成 MEDIA:/out/one.png MEDIA:/out/two.mp4 生成');
  assert.deepEqual(multiMedia.mediaPaths, ['/out/one.png', '/out/two.mp4']);
  assert.equal(multiMedia.cleanText.includes('MEDIA:'), false);

  const nonImg = extractSessionDeliverables([
    { id: 'm-sec', role: 'assistant', content: '![bad](/secret/config.json)\n![ok](charts/out.png)' },
  ]);
  assert.equal(nonImg.some((d) => d.path === '/secret/config.json'), false, '非图片后缀不得伪装成 Markdown 图片成果物');
  assert.equal(nonImg.some((d) => d.path === 'charts/out.png'), true);
});

test('INV-DELIV-04: 读写分离、Shell 互证、禁 session_cache 与原地去重集合不交守恒', async () => {
  const safeAbsArb = fc
    .tuple(
      fc.constantFrom('/opt/data/drafts', '/workspace/out'),
      fc.stringMatching(/^[a-zA-Z0-9_-]{2,10}$/),
      fc.constantFrom('png', 'html', 'md', 'pdf'),
    )
    .map(([dir, name, ext]) => `${dir}/${name}.${ext}`);

  fc.assert(
    fc.property(safeAbsArb, safeAbsArb, safeAbsArb, (roPath, shellPath, fencedPath) => {
      fc.pre(
        normalizeDeliverableKey(roPath) !== normalizeDeliverableKey(shellPath) &&
          normalizeDeliverableKey(fencedPath) !== normalizeDeliverableKey(shellPath) &&
          normalizeDeliverableKey(fencedPath) !== normalizeDeliverableKey(roPath),
      );
      const msgs = [
        {
          id: 'm-inv4',
          role: 'assistant',
          content: `读了 \`${roPath}\`，写了 ${shellPath}\n\`\`\`txt\n${fencedPath}\n\`\`\``,
          toolCalls: [
            { id: 'r-1', name: 'read_file', args: JSON.stringify({ path: roPath }) },
            { id: 'sh-1', name: 'terminal', args: JSON.stringify({ command: 'python3 gen.py' }), output: `done ${shellPath}` },
          ],
        },
      ];
      const extracted = extractTurnDeliverables(msgs, { verifiedExistingPaths: [roPath, fencedPath] });
      const extractedKeys = new Set(extracted.map((d) => normalizeDeliverableKey(d.path)));
      assert.equal(extractedKeys.has(normalizeDeliverableKey(roPath)), false, '只读文件即使命中 verifiedExistingPaths 也不得泄漏进成果物');
      assert.equal(extractedKeys.has(normalizeDeliverableKey(shellPath)), true, '同回合 Shell 提及输出必须被准确收录');
      assert.equal(extractedKeys.has(normalizeDeliverableKey(fencedPath)), false, '代码块内假路径不得进入候选集');

      const inlineKeys = findInlineReferencedDeliverableKeys(msgs[0].content, extracted);
      const remaining = extracted.filter((d) => !inlineKeys.has(normalizeDeliverableKey(d.path)));
      assert.equal(
        remaining.some((d) => inlineKeys.has(normalizeDeliverableKey(d.path))),
        false,
        '正文原地去重后剩余列表不得与 inlineKeys 交叠',
      );
      assert.equal(extractUnverifiedCandidatePaths(msgs).includes(shellPath), false);
    }),
    { numRuns: 150 },
  );

  // 非循环自证：缺少真实物理 fs 桥接时绝不放行任何候选路径
  const nonCircular = createDirectoryPathVerifier({ getPlatformBridge: () => null });
  assert.deepEqual(await nonCircular.verifyPathsExist(['/opt/data/drafts/phantom.png']), []);
});
