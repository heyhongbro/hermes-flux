import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTouchedFiles, isTouchedFileRef, normalizeFileRef } from '../dist/lib/fileRefs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const loadMarkdown = async () => {
  const { renderMarkdown } = await import('../dist/components/MiddlePod/MiddlePod.js');
  return renderMarkdown;
};

test('File references - 只有会话真实读写过的文件才可点击', async (t) => {
  await t.test('1. 路径归一化：反斜杠 / 引号 / 行号 / 尾斜杠', () => {
    assert.equal(normalizeFileRef(' `C:\\work\\app\\main.ts` '), 'C:/work/app/main.ts');
    assert.equal(normalizeFileRef('/opt/app/a.ts:42:7'), '/opt/app/a.ts');
    assert.equal(normalizeFileRef('./src/a.ts'), 'src/a.ts');
    assert.equal(normalizeFileRef('/opt/app/'), '/opt/app');
  });

  await t.test('2. 采集：只扫文件类工具的 args / output，命令里的路径不算', () => {
    const files = collectTouchedFiles([
      { name: 'read_file', args: JSON.stringify({ path: '/opt/app/a.ts' }) },
      { name: 'patch', args: '{}', output: JSON.stringify({ files_modified: ['/opt/app/b.ts'], diff: '--- a/b\n+++ b/b' }) },
      { name: 'write_file', args: '{}', output: JSON.stringify({ resolved_path: '/opt/app/c.md', files_modified: ['/opt/app/c.md'] }) },
      { name: 'terminal', args: 'cat /etc/hosts', output: JSON.stringify({ output: 'ok', exit_code: 0 }) },
      { name: 'search_files', args: '{"path":"/opt/app/a.ts"}', output: '{"total_count":1}' },
    ]);
    assert.deepEqual(files.sort(), ['/opt/app/a.ts', '/opt/app/b.ts', '/opt/app/c.md']);
  });

  await t.test('3. 匹配：绝对后缀 / 相对后缀 / basename 唯一', () => {
    const known = ['/opt/app/src/a.ts', '/opt/app/config.yaml'];
    assert.equal(isTouchedFileRef('/opt/app/src/a.ts', known), true, '绝对路径精确命中');
    assert.equal(isTouchedFileRef('src/a.ts', known), true, '相对路径按段后缀命中');
    assert.equal(isTouchedFileRef('a.ts', known), true, '唯一 basename 命中');
    assert.equal(isTouchedFileRef('b.ts', known), false, '未读写文件不命中');
    assert.equal(isTouchedFileRef('', known), false, '空引用不命中');
    assert.equal(isTouchedFileRef('a.ts', []), false, '集合为空时一律不可点击');
  });

  await t.test('4. 匹配：同名文件多个时不得猜测目标', () => {
    const ambiguous = ['/opt/a/index.ts', '/opt/b/index.ts'];
    assert.equal(isTouchedFileRef('index.ts', ambiguous), false, '多个同名文件必须保持不可点击');
    assert.equal(isTouchedFileRef('/opt/b/index.ts', ambiguous), true, '绝对路径仍可精确命中');
  });

  await t.test('5. 行内代码：未写入正文的路径保持普通代码药丸', async () => {
    const renderMarkdown = await loadMarkdown();
    const html = renderMarkdown('配置文件在 `/opt/app/config.yaml` 里');
    assert.ok(html.includes('class="md-code md-file-ref"'), '仍标记为文件引用以便后续识别');
    assert.ok(!html.includes('md-file-ref--linked'), '未读写文件不得带可点击标记');
    assert.ok(!html.includes('data-preview-file'), '未读写文件不得绑定预览');
    assert.ok(!html.includes('md-file__icon'), '未读写文件不显示文件图标');
  });

  await t.test('6. 行内代码：命中集合后变成可点击引用并带图标', async () => {
    const renderMarkdown = await loadMarkdown();
    const html = renderMarkdown('配置文件在 `/opt/app/config.yaml` 里', {
      knownFiles: ['/opt/app/config.yaml'],
    });
    assert.ok(html.includes('md-file-ref--linked'), '已读写文件必须可点击');
    assert.ok(html.includes('data-preview-file="/opt/app/config.yaml"'), '必须绑定预览路径');
    assert.ok(html.includes('data-icon="yaml"'), '必须带文件类型图标');
    assert.ok(html.includes('tool-file-link'), '必须复用宿主既有文件链接委托');
  });

  await t.test('7. 缓存隔离：同一段正文在不同文件集合下结果不同', async () => {
    const renderMarkdown = await loadMarkdown();
    const body = '打开 `/opt/app/only-once.ts` 看看';
    const plain = renderMarkdown(body);
    const linked = renderMarkdown(body, { knownFiles: ['/opt/app/only-once.ts'] });
    assert.ok(!plain.includes('md-file-ref--linked'));
    assert.ok(linked.includes('md-file-ref--linked'), '缓存键必须包含文件集合，否则会命中上一轮结果');
  });

  await t.test('8. Markdown 文件链接：命中才渲染 anchor，未命中保持纯文本', async () => {
    const renderMarkdown = await loadMarkdown();
    const linked = renderMarkdown('[配置](/opt/app/config.yaml)', { knownFiles: ['/opt/app/config.yaml'] });
    assert.ok(linked.includes('<a '), '已读写文件链接必须可点击');
    assert.ok(linked.includes('data-preview-file="/opt/app/config.yaml"'));

    const plain = renderMarkdown('[配置](/opt/app/config.yaml)');
    assert.ok(!plain.includes('<a '), '未读写文件链接不得渲染成锚点');
    assert.ok(plain.includes('data-file-ref="/opt/app/config.yaml"'), '保留引用标记供后续校正');
  });

  await t.test('9. 外部 URL 不受影响，始终可点击', async () => {
    const renderMarkdown = await loadMarkdown();
    const html = renderMarkdown('文档见 `https://example.com/docs`');
    assert.ok(html.includes('data-preview-url="https://example.com/docs"'), 'URL 引用必须保持可点击');
  });

  await t.test('10. 样式不变量：文件图标走 vertical-align，链接不再常显下划线', () => {
    const css = read('packages/ui/src/styles/conversation.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const iconBlock = css.match(/\.md-file__icon,\s*\.md-link__icon\s*\{([\s\S]*?)\}/);
    assert.ok(iconBlock, '必须存在文件图标样式块');
    assert.ok(iconBlock[1].includes('vertical-align: -0.18em'), '图标必须用 vertical-align 对齐文字中腰');
    assert.ok(!iconBlock[1].includes('align-self: center'), '禁止再用 align-self 居中（会与基线混搭导致上浮）');

    const labelBlock = css.match(/\.md-link__label\s*\{([\s\S]*?)\}/);
    assert.ok(labelBlock, '必须存在链接文字样式块');
    assert.ok(labelBlock[1].includes('text-decoration: none'), '文件引用默认不得常显下划线');
    assert.ok(css.includes('.md-file-ref--linked'), '必须存在可点击文件引用样式');
  });

  await t.test('11. 安全隔离：未命中文件图片不渲染可点链 + 危险链接协议被阻断', async () => {
    const renderMarkdown = await loadMarkdown();
    const unlinkedImg = renderMarkdown('![cfg](/secret/config.json)');
    assert.equal(unlinkedImg.includes('data-preview-file'), false, '未命中 knownFiles 的本地图片路径不得生成可点探针链');

    const linkedImg = renderMarkdown('![chart](/out/arch.png)', { knownFiles: ['/out/arch.png'] });
    assert.ok(linkedImg.includes('data-preview-file="/out/arch.png"'));

    const xssLink = renderMarkdown('[click](javascript:alert(1))');
    assert.equal(xssLink.includes('javascript:'), false, 'Markdown 链接不得放行 javascript: 协议');
  });

  await t.test('12. collectTouchedFiles 提取 imagePath 忽略空项 + Markdown 直链图片与非路径回退', async () => {
    const touched = collectTouchedFiles([
      null,
      { name: 'draw_chart', imagePath: '/out/tool-chart.png', args: '{}' },
    ]);
    assert.deepEqual(touched, ['/out/tool-chart.png']);

    const renderMarkdown = await loadMarkdown();
    const mdDirect = renderMarkdown(
      [
        '![ext](https://cdn.example.com/fig.png "图题")',
        '![inline](data:image/png;base64,AA==)',
        '![badJs](javascript:alert(1))',
        '![notPath](just_a_label)',
      ].join('\n\n'),
    );
    assert.ok(mdDirect.includes('class="md-inline-image"'));
    assert.ok(mdDirect.includes('data-media-src="https://cdn.example.com/fig.png"'));
    assert.ok(mdDirect.includes('data-media-src="data:image/png;base64,AA=="'));
    assert.equal(mdDirect.includes('javascript:'), false);
    assert.ok(mdDirect.includes('notPath') && !mdDirect.includes('data-preview-file="just_a_label"'));
  });

  await t.test('13. deliverableFiles 原地渲染紧凑成果物小卡片（反引号、裸路径、图片缩略槽位、代码块免疫、纯文件名展示）', async () => {
    const renderMarkdown = await loadMarkdown();
    const htmlPath = '/opt/data/projects/mp-langchao/drafts/2026-11-23-t3code-telemetry.html';
    const mdPath = '/opt/data/projects/mp-langchao/drafts/2026-11-23-t3code-xiaohongshu.md';
    const pngPath = '/opt/data/projects/mp-langchao/drafts/img/t3-timeline.png';
    const html = renderMarkdown(
      [
        `- 公众号：\`${htmlPath}\``,
        `- 小红书：${mdPath}`,
        `- 信息图：\`${pngPath}\``,
        '只读源码参考 `/repo/src/readonly.ts`',
        '',
        '```sh',
        `echo ${htmlPath}`,
        '```',
      ].join('\n'),
      {
        knownFiles: ['/repo/src/readonly.ts', htmlPath, mdPath, pngPath],
        deliverableFiles: [htmlPath, mdPath, pngPath],
      },
    );

    assert.equal((html.match(/data-deliverable-card="true"/g) || []).length, 3, '正文中 3 个成果物（含裸路径）应原地渲染 3 张卡片，代码块不误替');
    assert.ok(html.includes('<span class="conv-inline-deliverable__name">2026-11-23-t3code-telemetry.html</span>'));
    assert.ok(html.includes('<span class="conv-inline-deliverable__name">2026-11-23-t3code-xiaohongshu.md</span>'));
    assert.ok(html.includes('<span class="conv-inline-deliverable__name">t3-timeline.png</span>'));
    assert.ok(html.includes('<span class="conv-inline-deliverable__ext">HTML</span>'));
    assert.ok(html.includes('<span class="conv-inline-deliverable__ext">MD</span>'));
    assert.ok(html.includes('<span class="conv-inline-deliverable__ext">PNG</span>'));
    assert.ok(html.includes(`data-deliverable-thumb="${pngPath}"`), '图片小卡片必须包含 24x24 缩略图槽位');
    assert.equal(html.includes('md-file-ref--linked'), true, '只有普通只读文件引用保留 md-file-ref--linked');
    const inlineCardMatch = html.match(/<button[^>]*data-deliverable-card="true"[^>]*>/)?.[0] || '';
    assert.equal(inlineCardMatch.includes('md-file-ref--linked'), false, '原地卡片禁止挂 md-file-ref--linked 以防悬停下划线');
    assert.equal(inlineCardMatch.includes('tool-file-link'), false, '原地卡片禁止挂 tool-file-link 以免主题变色漂移');
    assert.equal(html.includes('<span class="conv-inline-deliverable__name">/opt/data/'), false, '小卡片可见文本仅显示文件名，不显示完整目录前缀');
    assert.ok(html.includes(`data-file-ref="/repo/src/readonly.ts"`) && html.includes('md-file-ref--linked'), '普通已读文件保留传统可点药丸而不误变成成果物卡片');

    // XSS 协议阻断优先于路径扩展名匹配，raw HTML 属性不被 wrapBareDeliverablePaths 误包反引号，图片小卡不含 data-preview-file
    const xssAndRaw = renderMarkdown(
      [
        '[bad](javascript:alert(1)//out.html)',
        '`javascript:alert(1)//out.html`',
        `看图 \`t3-timeline.png\``,
        `<a href="${htmlPath}">raw-link</a>`,
      ].join('\n\n'),
      { deliverableFiles: [htmlPath, pngPath] },
    );
    assert.ok(xssAndRaw.includes('<p>bad</p>'), '含扩展名的 javascript: Markdown 链接必须剥离为纯文本');
    assert.equal(
      /href="javascript:|data-preview-file="javascript:|data-file-ref="javascript:/i.test(xssAndRaw),
      false,
      'javascript: 含扩展名后缀绝不得生成可点击属性或链接',
    );
    assert.ok(
      xssAndRaw.includes('<code class="md-code">javascript:alert(1)//out.html</code>'),
      '反引号内危险协议文本仅保留为惰性普通代码展示',
    );
    assert.ok(xssAndRaw.includes('<span class="conv-inline-deliverable__name">t3-timeline.png</span>'), '唯一纯文件名引用也应原地渲染卡片');
    assert.equal(xssAndRaw.includes('data-deliverable-kind="image" data-deliverable-path="/opt/data/projects/mp-langchao/drafts/img/t3-timeline.png" data-deliverable-name="t3-timeline.png" data-preview-file='), false, '图片成果物卡片不挂 data-preview-file，确保点击专走灯箱');
    assert.equal(xssAndRaw.includes(`href="\`${htmlPath}\`"`), false, 'HTML 属性内部路径不得被裸路径扫描篡改');
  });
});
