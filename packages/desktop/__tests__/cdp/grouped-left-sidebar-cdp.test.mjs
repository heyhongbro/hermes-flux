/**
 * 分组左侧栏与新版新建会话弹窗端到端真实浏览器验证（Blink CDP，驱动 packages/desktop/dist 真实产物）。
 *
 * 【覆盖场景（对照 .agents/skills/verify-hermes-flux/features/grouped-left-sidebar-and-new-chat.md）】
 *   1. grouped-expanded：设置切到 grouped 后无独立 BOT 微轨、顶部新建按钮、BOT->群聊->普通会话三段、
 *      跨 Bot 会话继承所属头像、hidden 会话隔离、悬停底色（!important 级联无覆盖）验证并落盘 screenshot.png；
 *   2. grouped-accordion-collapse：BOT 分组折叠后 visibility === 'hidden'、运行指示点只亮 BOT/群聊不亮 sessions；
 *   3. new-chat-dialog：SegmentedControl + Surface(raised) + bg-input 在 dark 与 jade-white 皮肤下的对比度层次；
 *   4. grouped-collapsed：grouped 折叠态 #flux-left-rail 收拢至 0px、顶栏左段让位；
 *   5. dual-rail-regression：切回 dual-rail 后 #flux-station-rail 与双轨结构完整恢复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const RENDERER_ENTRY = 'packages/desktop/dist/renderer/index.html';

const SVG_DEFAULT_AVA = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#3b82f6"/></svg>');
const SVG_WANG_AVA = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#10b981"/></svg>');

test('grouped-left-sidebar-and-new-chat: 真实 Blink CDP 五场景物理渲染与截图取证', async (t) => {
  const browserPath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browserPath) {
    t.skip('未找到 Edge/Chrome');
    return;
  }
  const rootDir = process.cwd();
  if (!fs.existsSync(path.join(rootDir, RENDERER_ENTRY))) {
    t.skip('renderer 产物缺失，请先 npm run build');
    return;
  }

  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url?.split('?')[0] || '/');
    if (reqPath === '/') reqPath = `/${RENDERER_ENTRY}`;
    const filePath = path.join(rootDir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.map': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;

  const portProbe = http.createServer();
  await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
  const cdpPort = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));

  const tmpUserDataDir = path.resolve(
    os.tmpdir(),
    `flux-cdp-grouped-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const proc = spawn(
    browserPath,
    [
      `--remote-debugging-port=${cdpPort}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${tmpUserDataDir}`,
      '--window-size=1280,820',
      `http://127.0.0.1:${serverPort}/${RENDERER_ENTRY}`,
    ],
    { stdio: 'ignore' },
  );

  let ws = null;
  t.after(async () => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
        await new Promise((r) => setTimeout(r, 400));
        ws.close();
      }
    // gate-degrade: CDP 测试退出清理失败不应掩盖主测试结果
    } catch {}
    try {
      proc.kill();
    // gate-degrade: 进程已退出时 kill 忽略
    } catch {}
    try {
      server.close();
    // gate-degrade: HTTP 服务关闭兜底
    } catch {}
    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    // gate-degrade: 临时 Chrome profile 目录释放锁偶发失败平滑跳过
    } catch {}
  });

  let wsUrl = null;
  const start = Date.now();
  while (Date.now() - start < 15000 && !wsUrl) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (page) wsUrl = page.webSocketDebuggerUrl;
      }
    // gate-degrade: 等待浏览器调试端口就绪轮询
    } catch {}
    if (!wsUrl) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(wsUrl, 'CDP page target 必须可达');

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error('页面表达式异常: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('CSS.enable');

  const booted = await (async () => {
    for (let i = 0; i < 60; i++) {
      if (await evaluate('Boolean(window.__fluxState && window.__fluxRender)')) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })();
  assert.ok(booted, '真实 renderer 调试面必须挂载');

  const outDir = path.join(rootDir, 'artifacts', 'verification', 'grouped-left-sidebar-and-new-chat');
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();
  const evidence = {
    featureId: 'grouped-left-sidebar-and-new-chat',
    startedAtMs: startedAt,
    scenes: {},
  };

  // 1. grouped-expanded：切入 grouped 布局并注入确定性多 Bot / 群聊 / 跨 Bot 会话 / hidden 主工位
  const seeded = await evaluate(`(() => {
    const now = Date.now();
    window.__fluxState.leftRailLayout = 'grouped';
    window.__fluxState.leftRailCollapsed = false;
    window.__fluxState.theme = 'obsidian-gold';
    document.documentElement.dataset.theme = 'obsidian-gold';
    window.__fluxState.isBotsGroupExpanded = true;
    window.__fluxState.isGroupsGroupExpanded = true;
    window.__fluxState.isSessionsGroupExpanded = true;
    window.__fluxState.profilesPhase = 'ready';
    window.__fluxState.sessionsPhase = 'ready';
    window.__fluxState.gatewayConnected = true;
    window.__fluxState.profiles = [
      {
        name: 'default',
        displayName: 'Default 助理',
        description: '全局中枢协调者',
        avatar: ${JSON.stringify(SVG_DEFAULT_AVA)},
        lastMessage: '随时协助规划与审查',
        timestamp: now - 300000,
        isDefault: true,
      },
      {
        name: 'arch-wang',
        displayName: '架构老王',
        description: '分布式与状态机专家',
        avatar: ${JSON.stringify(SVG_WANG_AVA)},
        lastMessage: '正在核对事务日志',
        timestamp: now - 60000,
        activityState: 'running',
      },
    ];
    window.__fluxState.groupRooms = [
      {
        roomId: 'room-arch',
        name: '架构攻关研讨群',
        members: ['default', 'arch-wang'],
        lastMessage: '确认单向分层契约',
        updatedAt: now - 120000,
        activityState: 'running',
      },
    ];
    window.__fluxState.projects = [
      { id: 'proj-alpha', name: 'Flux Core', path: '/flux' },
    ];
    window.__fluxState.sessions = [
      {
        id: 'sess-wang-task',
        title: '老王重构专项讨论',
        preview: '已定位并发竞态',
        botName: 'arch-wang',
        botDisplayName: '架构老王',
        timestamp: now - 20000,
        activityState: 'running',
      },
      {
        id: 'sess-default-task',
        title: '日常日志巡检',
        preview: '一切指标正常',
        botName: 'default',
        botDisplayName: 'Default 助理',
        timestamp: now - 180000,
        activityState: 'read',
      },
      {
        id: 'sess-hidden-forever',
        title: 'Bot 终身主工位内部会话',
        preview: '禁止泄漏到普通会话区',
        botName: 'arch-wang',
        hidden: true,
        timestamp: now - 5000,
      },
    ];
    window.__fluxState.activeSessionId = 'sess-wang-task';
    window.__fluxState.activeFocus = { type: 'session', sessionId: 'sess-wang-task' };
    window.__fluxRender();
    return true;
  })()`);
  assert.ok(seeded);
  await new Promise((r) => setTimeout(r, 350));

  const expandedCheck = await evaluate(`(() => {
    const rail = document.getElementById('flux-left-rail');
    const station = document.getElementById('flux-station-rail');
    const searchInput = document.getElementById('session-search-input');
    const newChatBtn = document.getElementById('rail-grouped-new-chat-btn');
    const searchRect = searchInput?.getBoundingClientRect();
    const btnRect = newChatBtn?.getBoundingClientRect();
    const searchRadius = searchInput ? parseFloat(getComputedStyle(searchInput).borderTopLeftRadius) : 0;
    const btnRadius = newChatBtn ? parseFloat(getComputedStyle(newChatBtn).borderTopLeftRadius) : 0;
    const botsTrig = document.getElementById('rail-bots-accordion-trigger');
    const groupsTrig = document.getElementById('rail-groups-accordion-trigger');
    const sessionsTrig = document.getElementById('rail-sessions-accordion-trigger');
    const wangRow = document.querySelector('.session-item[data-id="sess-wang-task"]');
    const wangImg = wangRow?.querySelector('img')?.getAttribute('src') || '';
    const hiddenRow = document.querySelector('.session-item[data-id="sess-hidden-forever"]');
    return {
      layoutAttr: rail?.getAttribute('data-rail-layout') || '',
      rootLayoutAttr: document.documentElement.getAttribute('data-left-rail-layout') || '',
      railWidth: Math.round(rail?.getBoundingClientRect().width || 0),
      hasStationRail: Boolean(station),
      hasNewChatBtn: Boolean(newChatBtn),
      searchTop: searchRect ? Math.round(searchRect.top) : -1,
      btnTop: btnRect ? Math.round(btnRect.top) : -1,
      searchHeight: searchRect ? Math.round(searchRect.height) : -1,
      btnHeight: btnRect ? Math.round(btnRect.height) : -1,
      btnLeft: btnRect ? Math.round(btnRect.left) : -1,
      searchRight: searchRect ? Math.round(searchRect.right) : -1,
      searchRadius,
      btnRadius,
      botsText: botsTrig?.textContent?.trim() || '',
      groupsText: groupsTrig?.textContent?.trim() || '',
      sessionsText: sessionsTrig?.textContent?.trim() || '',
      botsTrigHeight: botsTrig ? Math.round(botsTrig.getBoundingClientRect().height) : -1,
      groupsTrigHeight: groupsTrig ? Math.round(groupsTrig.getBoundingClientRect().height) : -1,
      sessionsTrigHeight: sessionsTrig ? Math.round(sessionsTrig.getBoundingClientRect().height) : -1,
      botsTop: botsTrig?.getBoundingClientRect().top || 0,
      groupsTop: groupsTrig?.getBoundingClientRect().top || 0,
      sessionsTop: sessionsTrig?.getBoundingClientRect().top || 0,
      wangAvatarInherited: wangImg.includes('10b981'),
      hiddenLeaked: Boolean(hiddenRow),
    };
  })()`);
  assert.equal(expandedCheck.layoutAttr, 'grouped');
  assert.equal(expandedCheck.rootLayoutAttr, 'grouped');
  assert.ok(expandedCheck.railWidth >= 240);
  assert.equal(expandedCheck.hasStationRail, false, 'grouped 模式不得渲染独立 #flux-station-rail');
  assert.equal(expandedCheck.hasNewChatBtn, true, 'grouped 模式必须渲染新建会话按钮');
  assert.ok(
    Math.abs(expandedCheck.searchTop - expandedCheck.btnTop) <= 2,
    `顶部搜索框与新建按钮必须在同一水平行 (searchTop=${expandedCheck.searchTop}, btnTop=${expandedCheck.btnTop})`,
  );
  assert.equal(expandedCheck.searchHeight, 32, '搜索框高度必须锁死 32px');
  assert.equal(expandedCheck.btnHeight, 32, '新建圆形按钮高度必须锁死 32px');
  assert.ok(expandedCheck.btnLeft > expandedCheck.searchRight, '新建按钮必须在搜索框右侧且有间隙');
  assert.ok(expandedCheck.searchRadius >= 16, '搜索框必须呈胶囊圆角');
  assert.ok(expandedCheck.btnRadius >= 16, '新建按钮必须呈纯圆造型');
  assert.ok(expandedCheck.botsTrigHeight >= 32, `BOT 分组标题热区必须 >= 32px (实测 ${expandedCheck.botsTrigHeight})`);
  assert.ok(expandedCheck.groupsTrigHeight >= 32, `群聊分组标题热区必须 >= 32px (实测 ${expandedCheck.groupsTrigHeight})`);
  assert.ok(expandedCheck.sessionsTrigHeight >= 32, `会话分组标题热区必须 >= 32px (实测 ${expandedCheck.sessionsTrigHeight})`);
  assert.equal(Number.isInteger(expandedCheck.sessionsTop), true, `分组垂直坐标不得落出像素网格 (${expandedCheck.sessionsTop})`);
  assert.ok(
    expandedCheck.botsTop < expandedCheck.groupsTop && expandedCheck.groupsTop < expandedCheck.sessionsTop,
    '分组垂直顺序必须为 BOT -> 群聊 -> 普通会话',
  );
  for (const label of [expandedCheck.botsText, expandedCheck.groupsText, expandedCheck.sessionsText]) {
    assert.equal(/\d/.test(label), false, `分组标题不得包含数量数字: ${label}`);
  }
  assert.equal(expandedCheck.wangAvatarInherited, true, '跨 Bot 会话必须继承归属 Bot 头像');
  assert.equal(expandedCheck.hiddenLeaked, false, 'hidden 主工位会话绝不能进入分组会话列表');

  // 悬停实测（CDP CSS.forcePseudoState 证明 :not(.active) 未再压死 :hover）
  const docRoot = await send('DOM.getDocument', { depth: -1 });
  const hoverNode = await send('DOM.querySelector', {
    nodeId: docRoot.root.nodeId,
    selector: '.rail-grouped-bot-row:not(.active)',
  });
  assert.ok(hoverNode.nodeId > 0, '必须存在非激活态 BOT 行供悬停测试');
  await send('CSS.forcePseudoState', { nodeId: hoverNode.nodeId, forcedPseudoClasses: ['hover'] });
  // 等待 RailEntityRow 的 150ms transition-colors 完成过渡后再采样计算背景色
  await new Promise((r) => setTimeout(r, 220));
  const hoverCheck = await evaluate(`(() => {
    const botRow = document.querySelector('.rail-grouped-bot-row:not(.active)');
    return {
      bg: botRow ? getComputedStyle(botRow).backgroundColor : '',
    };
  })()`);
  await send('CSS.forcePseudoState', { nodeId: hoverNode.nodeId, forcedPseudoClasses: [] });
  assert.notEqual(hoverCheck.bg, 'rgba(0, 0, 0, 0)', '悬停非激活 BOT 行必须呈现可见 --card-hover 底色');
  // 清除伪类后等待退场过渡完全结束，确保 screenshot.png 不残余 hover 底色
  await new Promise((r) => setTimeout(r, 250));

  const mainShot = await send('Page.captureScreenshot', { format: 'png' });
  const mainShotPath = path.join(outDir, 'screenshot.png');
  fs.writeFileSync(mainShotPath, Buffer.from(mainShot.data, 'base64'));
  evidence.scenes['grouped-expanded'] = { ...expandedCheck, hoverBg: hoverCheck.bg, screenshot: 'screenshot.png' };

  // 2. grouped-accordion-collapse：点击折叠 BOT 与 普通会话，验证 visibility: hidden、height: 0 与 sessions 无运行指示器
  await evaluate(`(() => {
    document.getElementById('rail-bots-accordion-trigger')?.click();
    document.getElementById('rail-sessions-accordion-trigger')?.click();
  })()`);
  await new Promise((r) => setTimeout(r, 320));

  const collapseSecCheck = await evaluate(`(() => {
    const botsTrig = document.getElementById('rail-bots-accordion-trigger');
    const botsBody = document.getElementById('rail-bots-nested-list');
    const sessionsTrig = document.getElementById('rail-sessions-accordion-trigger');
    const sessionsBody = document.getElementById('rail-sessions-nested-list');
    return {
      botsExpanded: botsTrig?.getAttribute('aria-expanded'),
      botsVisibility: botsBody ? getComputedStyle(botsBody).visibility : '',
      botsHeight: botsBody ? Math.round(botsBody.getBoundingClientRect().height) : -1,
      sessionsExpanded: sessionsTrig?.getAttribute('aria-expanded'),
      sessionsVisibility: sessionsBody ? getComputedStyle(sessionsBody).visibility : '',
      sessionsHeight: sessionsBody ? Math.round(sessionsBody.getBoundingClientRect().height) : -1,
      sessionsHasIndicator: Boolean(sessionsTrig?.querySelector('[data-status]')),
    };
  })()`);
  assert.equal(collapseSecCheck.botsExpanded, 'false');
  assert.equal(collapseSecCheck.botsVisibility, 'hidden', '折叠体必须 visibility: hidden 防键盘误落焦点');
  assert.equal(collapseSecCheck.botsHeight, 0, '折叠体 Grid 行高必须收拢至 0px');
  assert.equal(collapseSecCheck.sessionsExpanded, 'false');
  assert.equal(collapseSecCheck.sessionsVisibility, 'hidden');
  assert.equal(collapseSecCheck.sessionsHeight, 0);
  assert.equal(collapseSecCheck.sessionsHasIndicator, false, '普通会话大标题即使折叠也严禁出现状态指示器');
  evidence.scenes['grouped-accordion-collapse'] = collapseSecCheck;

  // 恢复展开态以便后续流程，并验证 visibility 恢复 visible
  await evaluate(`(() => {
    document.getElementById('rail-bots-accordion-trigger')?.click();
    document.getElementById('rail-sessions-accordion-trigger')?.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const reopenedVisibility = await evaluate(
    `getComputedStyle(document.getElementById('rail-bots-nested-list')).visibility`,
  );
  assert.equal(reopenedVisibility, 'visible');

  // 3. new-chat-dialog：点击顶部圆形新建按钮 -> 验证工作区下拉 -> 先拍纯净暗色截图 -> 验证双皮肤对比 -> 选 Agent 直发与内联错误 -> 切群聊多选与确认提交 -> 双色截图 -> 返回 -> Esc
  await evaluate(`document.getElementById('rail-grouped-new-chat-btn')?.click()`);
  await new Promise((r) => setTimeout(r, 280));

  // 测试 Step 1 工作区选择器真实打开与选择
  const hasProjectSelect = await evaluate(`Boolean(document.getElementById('new-chat-project-select'))`);
  assert.equal(hasProjectSelect, true, '注入 projects 后 Step 1 必须渲染 #new-chat-project-select');
  await evaluate(`(() => {
    const sel = document.getElementById('new-chat-project-select');
    sel?.focus();
    sel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 180));
  const pickedProject = await evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    const target = items.find((el) => el.textContent?.includes('Flux Core'));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert.equal(pickedProject, true, '工作区下拉必须渲染并可选中 Flux Core');
  await new Promise((r) => setTimeout(r, 160));
  const projectTriggerLabel = await evaluate(
    `document.getElementById('new-chat-project-select')?.textContent?.trim() || ''`,
  );
  assert.ok(projectTriggerLabel.includes('Flux Core'), `选中后触发器必须展示 Flux Core (实测 "${projectTriggerLabel}")`);
  await evaluate(`document.getElementById('new-chat-project-select')?.blur?.()`);
  await new Promise((r) => setTimeout(r, 100));

  // 先在纯净 settled 的 obsidian-gold 态拍摄 new-chat-dialog-solo.png（禁止受后续切肤过渡污染）
  const soloDialogShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'new-chat-dialog-solo.png'), Buffer.from(soloDialogShot.data, 'base64'));

  const soloDialogCheck = await evaluate(`(() => {
    const dlg = document.querySelector('[data-testid="new-chat-dialog"]');
    const titleInput = document.getElementById('new-chat-title-input');
    const composerInput = document.getElementById('new-chat-composer-input');
    const submitBtn = dlg?.querySelector('[data-testid="new-chat-submit-btn"]');
    const botButtons = dlg ? dlg.querySelectorAll('[data-new-chat-bot]') : [];
    const groupEntry = dlg?.querySelector('[data-testid="new-chat-start-group"]');

    const darkPopoverBg = dlg ? getComputedStyle(dlg).backgroundColor : '';
    const darkGroupEntryBg = groupEntry ? getComputedStyle(groupEntry).backgroundColor : '';
    const darkGroupEntryColor = groupEntry ? getComputedStyle(groupEntry).color : '';

    document.documentElement.classList.add('oc-theme-switching');
    document.documentElement.dataset.theme = 'jade-white';
    void document.documentElement.offsetHeight;
    const lightPopoverBg = dlg ? getComputedStyle(dlg).backgroundColor : '';
    const lightGroupEntryBg = groupEntry ? getComputedStyle(groupEntry).backgroundColor : '';
    const lightGroupEntryColor = groupEntry ? getComputedStyle(groupEntry).color : '';

    document.documentElement.dataset.theme = 'obsidian-gold';
    void document.documentElement.offsetHeight;
    document.documentElement.classList.remove('oc-theme-switching');

    return {
      open: Boolean(dlg),
      mode: dlg?.getAttribute('data-mode') || '',
      hasTitleInput: Boolean(titleInput),
      hasComposerInput: Boolean(composerInput),
      hasSubmitBtnInSolo: Boolean(submitBtn),
      botCount: botButtons.length,
      hasDefaultBot: Boolean(dlg?.querySelector('[data-new-chat-bot="default"]')),
      hasGroupEntry: Boolean(groupEntry),
      darkPopoverBg,
      darkGroupEntryBg,
      darkGroupEntryColor,
      lightPopoverBg,
      lightGroupEntryBg,
      lightGroupEntryColor,
    };
  })()`);
  assert.equal(soloDialogCheck.open, true, '点击新建会话按钮必须打开 NewChatDialog');
  assert.equal(soloDialogCheck.mode, 'solo');
  assert.equal(soloDialogCheck.hasTitleInput, false, '不得出现手动填写名称的输入框');
  assert.equal(soloDialogCheck.hasComposerInput, false, '不得出现多余开场白输入框');
  assert.equal(soloDialogCheck.hasSubmitBtnInSolo, false, '第一步直接点 Agent 生效，不得存在确认按钮');
  assert.equal(soloDialogCheck.botCount, 2);
  assert.equal(soloDialogCheck.hasDefaultBot, true);
  assert.equal(soloDialogCheck.hasGroupEntry, true);
  assert.notEqual(
    soloDialogCheck.darkGroupEntryBg,
    soloDialogCheck.darkPopoverBg,
    'obsidian-gold 下底部群聊入口卡 surface-raised 不得与 --popover 底色塌陷为同色',
  );
  assert.notEqual(
    soloDialogCheck.lightGroupEntryBg,
    soloDialogCheck.lightPopoverBg,
    'jade-white 下底部群聊入口卡 surface-raised 不得与 --popover 白底塌陷为同色',
  );

  // 验证第一步点击 Agent 无需点确认按钮即直接触发建聊流程，且失败错误内联呈现在弹窗内部（不被遮罩挡住）
  await evaluate(`(() => {
    window.__fluxState.dockNotice = '';
    document.querySelector('[data-testid="new-chat-dialog"] [data-new-chat-bot="arch-wang"]')?.click();
  })()`);
  await new Promise((r) => setTimeout(r, 220));
  const directClickCheck = await evaluate(`(() => {
    const dlg = document.querySelector('[data-testid="new-chat-dialog"]');
    const errEl = dlg?.querySelector('[data-testid="new-chat-error"]');
    return {
      dockNotice: window.__fluxState.dockNotice || '',
      inlineError: errEl?.textContent?.trim() || '',
      stillOpenOnNoGateway: Boolean(dlg),
    };
  })()`);
  assert.ok(
    directClickCheck.inlineError.length > 0,
    '建聊失败时必须在弹窗内部 [data-testid="new-chat-error"] 可见展示错误',
  );
  assert.equal(directClickCheck.stillOpenOnNoGateway, true, '无后端连通失败时不得悄然吞掉弹窗');
  await evaluate(`(() => { window.__fluxState.dockNotice = ''; window.__fluxRender(); })()`);
  await new Promise((r) => setTimeout(r, 120));

  // 验证断线状态下 Agent 直选按钮禁用
  await evaluate(`(() => { window.__fluxState.gatewayConnected = false; window.__fluxRender(); })()`);
  await new Promise((r) => setTimeout(r, 150));
  const offlineDisabled = await evaluate(
    `Boolean(document.querySelector('[data-testid="new-chat-dialog"] [data-new-chat-bot="default"]')?.hasAttribute('disabled'))`,
  );
  assert.equal(offlineDisabled, true, '断线状态下 Agent 直选按钮必须禁用');
  await evaluate(`(() => { window.__fluxState.gatewayConnected = true; window.__fluxRender(); })()`);
  await new Promise((r) => setTimeout(r, 150));

  // 点击底部「发起多智能体群聊」进入第二步
  await evaluate(`document.querySelector('[data-testid="new-chat-dialog"] [data-testid="new-chat-start-group"]')?.click()`);
  await new Promise((r) => setTimeout(r, 220));

  const groupStepInitialCheck = await evaluate(`(() => {
    const dlg = document.querySelector('[data-testid="new-chat-dialog"]');
    const submitBtn = dlg?.querySelector('[data-testid="new-chat-submit-btn"]');
    return {
      mode: dlg?.getAttribute('data-mode') || '',
      hasBackBtn: Boolean(dlg?.querySelector('[data-testid="new-chat-back-btn"]')),
      hasTitleInput: Boolean(document.getElementById('new-chat-title-input')),
      memberCount: dlg ? dlg.querySelectorAll('[data-new-chat-member]').length : 0,
      initiallyDisabled: Boolean(submitBtn?.hasAttribute('disabled')),
    };
  })()`);
  assert.equal(groupStepInitialCheck.mode, 'group');
  assert.equal(groupStepInitialCheck.hasBackBtn, true);
  assert.equal(groupStepInitialCheck.hasTitleInput, false, '群聊步不得出现手工命名输入框');
  assert.equal(groupStepInitialCheck.memberCount, 2);
  assert.equal(groupStepInitialCheck.initiallyDisabled, true, '初始未勾选满 2 人时确认按钮必须禁用');

  // 多选 2 位成员后等待颜色过渡彻底稳定，在纯净 obsidian-gold 态拍摄 new-chat-dialog.png
  await evaluate(`(() => {
    document.querySelector('[data-testid="new-chat-dialog"] [data-new-chat-member="default"]')?.click();
    document.querySelector('[data-testid="new-chat-dialog"] [data-new-chat-member="arch-wang"]')?.click();
  })()`);
  await new Promise((r) => setTimeout(r, 260));

  const darkGroupShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'new-chat-dialog.png'), Buffer.from(darkGroupShot.data, 'base64'));

  // 采样暗色 obsidian-gold 指标，然后切换洁净 jade-white（强制回流刷新）并拍摄 new-chat-dialog-light.png，再无过渡复原暗色
  const groupThemeContrast = await evaluate(`(() => {
    const dlg = document.querySelector('[data-testid="new-chat-dialog"]');
    const memberBox = dlg?.querySelector('[data-new-chat-member]')?.parentElement || null;
    const pickedRow = dlg?.querySelector('[data-new-chat-member="default"]');
    const submitBtn = dlg?.querySelector('[data-testid="new-chat-submit-btn"]');

    const darkMemberBoxBg = memberBox ? getComputedStyle(memberBox).backgroundColor : '';
    const darkPickedRowBg = pickedRow ? getComputedStyle(pickedRow).backgroundColor : '';
    const darkPickedRowColor = pickedRow ? getComputedStyle(pickedRow).color : '';
    const submitDisabledAfterPick = Boolean(submitBtn?.hasAttribute('disabled'));
    const confirmText = submitBtn?.textContent?.trim() || '';

    document.documentElement.classList.add('oc-theme-switching');
    document.documentElement.dataset.theme = 'jade-white';
    void document.documentElement.offsetHeight;
    const lightMemberBoxBg = memberBox ? getComputedStyle(memberBox).backgroundColor : '';
    const lightPickedRowBg = pickedRow ? getComputedStyle(pickedRow).backgroundColor : '';
    const lightPickedRowColor = pickedRow ? getComputedStyle(pickedRow).color : '';

    return {
      mode: dlg?.getAttribute('data-mode') || '',
      submitDisabledAfterPick,
      confirmText,
      darkMemberBoxBg,
      darkPickedRowBg,
      darkPickedRowColor,
      lightMemberBoxBg,
      lightPickedRowBg,
      lightPickedRowColor,
    };
  })()`);
  const lightGroupShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'new-chat-dialog-light.png'), Buffer.from(lightGroupShot.data, 'base64'));

  await evaluate(`(() => {
    document.documentElement.dataset.theme = 'obsidian-gold';
    void document.documentElement.offsetHeight;
    document.documentElement.classList.remove('oc-theme-switching');
  })()`);
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(groupThemeContrast.mode, 'group');
  assert.equal(groupThemeContrast.submitDisabledAfterPick, false, '勾选 2 位成员后确认创建必须可用');
  assert.ok(groupThemeContrast.confirmText.includes('2'), '确认按钮应展示已选成员数量');
  assert.notEqual(
    groupThemeContrast.darkPickedRowBg,
    groupThemeContrast.darkMemberBoxBg,
    'obsidian-gold 下已选成员行底色必须与列表容器底色明显分层',
  );
  assert.notEqual(
    groupThemeContrast.lightPickedRowBg,
    groupThemeContrast.lightMemberBoxBg,
    'jade-white 下已选成员行底色必须与列表容器底色明显分层',
  );

  // 点击 Step 2 「确认创建」验证群聊真实提交流程与失败内联提示/留窗
  await evaluate(`document.querySelector('[data-testid="new-chat-dialog"] [data-testid="new-chat-submit-btn"]')?.click()`);
  await new Promise((r) => setTimeout(r, 220));
  const groupSubmitCheck = await evaluate(`(() => {
    const dlg = document.querySelector('[data-testid="new-chat-dialog"]');
    const errEl = dlg?.querySelector('[data-testid="new-chat-error"]');
    return {
      groupInlineError: errEl?.textContent?.trim() || '',
      stillOpenOnGroupFail: Boolean(dlg),
    };
  })()`);
  assert.ok(groupSubmitCheck.groupInlineError.length > 0, 'Step 2 确认创建失败必须在弹窗内呈现错误提示');
  assert.equal(groupSubmitCheck.stillOpenOnGroupFail, true, 'Step 2 建群失败不得关闭弹窗');

  // 验证返回按钮可平滑切回第一步且清除上次错误，随后 Esc 关闭弹窗
  await evaluate(`document.querySelector('[data-testid="new-chat-dialog"] [data-testid="new-chat-back-btn"]')?.click()`);
  await new Promise((r) => setTimeout(r, 180));
  const afterBackCheck = await evaluate(`(() => {
    const dlg = document.querySelector('[data-testid="new-chat-dialog"]');
    return {
      modeAfterBack: dlg?.getAttribute('data-mode') || '',
      hasErrorAfterBack: Boolean(dlg?.querySelector('[data-testid="new-chat-error"]')),
    };
  })()`);
  assert.equal(afterBackCheck.modeAfterBack, 'solo', '点击返回按钮必须切回单聊选角列表');
  assert.equal(afterBackCheck.hasErrorAfterBack, false, '返回上一步必须清空陈旧错误提示');

  evidence.scenes['new-chat-dialog'] = {
    ...soloDialogCheck,
    directClickNotice: directClickCheck.dockNotice,
    directClickInlineError: directClickCheck.inlineError,
    offlineDisabled,
    ...groupStepInitialCheck,
    ...groupThemeContrast,
    groupInlineError: groupSubmitCheck.groupInlineError,
    modeAfterBack: afterBackCheck.modeAfterBack,
    soloScreenshot: 'new-chat-dialog-solo.png',
    screenshot: 'new-chat-dialog.png',
    lightScreenshot: 'new-chat-dialog-light.png',
  };

  // Esc 关闭弹窗
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  const afterEscClosed = await evaluate(`!document.querySelector('[data-testid="new-chat-dialog"]')`);
  assert.equal(afterEscClosed, true, '按 Esc 必须关闭 NewChatDialog');

  // 4. grouped-collapsed：grouped 折叠态收拢为 0px
  await evaluate(`(() => {
    window.__fluxState.leftRailCollapsed = true;
    window.__fluxRender();
  })()`);
  await new Promise((r) => setTimeout(r, 320));

  const collapsedCheck = await evaluate(`(() => {
    const rail = document.getElementById('flux-left-rail');
    const titlebar = document.querySelector('.flux-titlebar');
    return {
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : -1,
      hasCollapsedClass: Boolean(rail?.classList.contains('rail-collapsed')),
      titlebarLayout: titlebar?.getAttribute('data-left-rail-layout') || '',
      titlebarCollapsed: titlebar?.getAttribute('data-left-rail-collapsed') || '',
      newChatStillMounted: Boolean(document.getElementById('rail-grouped-new-chat-btn')),
    };
  })()`);
  assert.equal(collapsedCheck.railWidth, 0, 'grouped 折叠态左栏宽度必须彻底收拢至 0px');
  assert.equal(collapsedCheck.hasCollapsedClass, true);
  assert.equal(collapsedCheck.titlebarLayout, 'grouped');
  assert.equal(collapsedCheck.titlebarCollapsed, 'true');
  assert.equal(collapsedCheck.newChatStillMounted, false);

  const collapsedShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'grouped-collapsed.png'), Buffer.from(collapsedShot.data, 'base64'));
  evidence.scenes['grouped-collapsed'] = { ...collapsedCheck, screenshot: 'grouped-collapsed.png' };

  // 5. dual-rail-regression：切回 dual-rail，验证经典微轨完全恢复
  await evaluate(`(() => {
    window.__fluxState.leftRailLayout = 'dual-rail';
    window.__fluxState.leftRailCollapsed = false;
    window.__fluxRender();
  })()`);
  await new Promise((r) => setTimeout(r, 250));

  const dualCheck = await evaluate(`(() => {
    const station = document.getElementById('flux-station-rail');
    const stationWidth = station ? Math.round(station.getBoundingClientRect().width) : 0;
    const groupedBtn = document.getElementById('rail-grouped-new-chat-btn');
    return {
      stationExists: Boolean(station),
      stationWidth,
      groupedBtnAbsent: !groupedBtn,
    };
  })()`);
  assert.equal(dualCheck.stationExists, true, '切回 dual-rail 必须恢复 #flux-station-rail');
  assert.ok(dualCheck.stationWidth >= 50, `微轨宽度必须正常恢复: ${dualCheck.stationWidth}`);
  assert.equal(dualCheck.groupedBtnAbsent, true);
  evidence.scenes['dual-rail-regression'] = dualCheck;
  evidence.ok = true;
  evidence.durationMs = Date.now() - startedAt;

  fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`  ✔ grouped-left-sidebar-and-new-chat 截图与证据已落盘: ${outDir}`);
});
