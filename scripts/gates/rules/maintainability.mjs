/**
 * Hermes Flux 门禁规则集 · 可维护性与测试完整性（Gate 0f / Gate 2）
 *
 * 设计意图 (Why)：
 *   这组规则守护的不是业务代码，而是「让人能继续修改代码」与「让门禁不能被糊弄」。
 *   它们与视觉/换肤规则关注点完全不同，且都在代码规模与测试手法层面生效，
 *   因此独立成模块，也避免 rules.mjs 本身越过单文件行数上限。
 *
 * 约束与规则 (Rules)：
 *   - 规则只用 scanner 提供的「去注释源码行视图」，不得直接读原始行做判定。
 *   - 违规对象统一形状：{ file, line, ruleId, message, snippet, lineIdx? }。
 *   - 本模块不得引入新的第三方依赖，门禁必须在干净环境可运行。
 */

/* ------------------------------------------------------------------ *
 * Gate 0f · 单文件行数上限
 * ------------------------------------------------------------------ */

/**
 * 单文件行数上限。
 *
 * 设计意图 (Why)：
 *   文件超过约 1500 行后，「读到理解」的成本按超线性上升：读者必须同时持有
 *   过多互不相干的分支，修改任何一处都要重新校准全局。本仓曾有一个 12000 行的
 *   renderer/index.ts，在其中定位一个行为要先读上千行上下文，这是缺陷的温床。
 *   把「文件规模」变成可机器判定的红线，而不是靠自觉。
 *
 * 防范的历史坑 (Pitfall)：
 *   只警告不阻断时，超限文件只增不减（存量已证明）。因此本规则是阻断型；
 *   存量超限登记在 KNOWN_OVERSIZE 冻结，只允许缩小，禁止新增。
 *
 * 约束与规则 (Rules)：
 *   1. 硬上限 1500 行，按物理行计（空行与注释同样占用读者的滚动与定位成本）。
 *   2. 存量超限文件必须登记 max，当前行数不得超过登记值。
 *   3. 文件降到上限以下后，应从登记表移除该条目以固化成果。
 */
export const FILE_LINE_LIMIT = 1500;

/**
 * 存量超限登记表。
 *
 * 【冻结规则】每条的 max 是"拆分工作开始时的实测行数"，只允许调低。
 * 文件无论因为什么理由涨回去了，本规则都会阻断，逼出"继续拆"而不是"再放宽一次"。
 * `generated: true` 是构建产物（由生成器写出），人工拆分无意义。
 */
export const KNOWN_OVERSIZE = {
  'packages/core/src/rpc/contracts/gateway-contract.generated.ts': { max: 7515, generated: true },
  'scripts/verify/control-flux.mjs': { max: 1701 },
  'packages/ui/src/components/InspectionPod/InspectionPod.ts': { max: 979 },
  'scripts/contract/probe.mjs': { max: 966 },
  'packages/desktop/__tests__/unit/reconnect-stage-preservation.test.mjs': { max: 1707 },
  'packages/desktop/__tests__/unit/render-coordinator.test.mjs': { max: 1519 },
  'packages/desktop/__tests__/unit/stream-viewport-manager.test.mjs': { max: 2898 },
  'packages/ui/__tests__/mobile-workspace-shell.test.mjs': { max: 5863 },
  'packages/ui/__tests__/settings-modal.test.mjs': { max: 3819 },
};

export const fileLineLimitRules = {
  id: 'size',
  gate: 'Gate 0',
  testAware: true,
  title: `单文件行数上限（≤ ${FILE_LINE_LIMIT} 行，存量冻结只降不升）`,
  check(file, ctx) {
    // 只约束可执行源码；样式表与文档另有口径
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) return [];

    const lines = ctx.rawLines.length;
    const known = KNOWN_OVERSIZE[file];

    // 生成产物由生成器负责
    if (known?.generated) return [];

    if (known) {
      if (lines <= FILE_LINE_LIMIT) {
        /**
         * 已达标：提示移除登记，不阻断。
         * 移除动作留在拆分 PR 里由人工确认，避免门禁自动改文件。
         */
        if (ctx.warnings) {
          ctx.warnings.push({
            file,
            line: 1,
            ruleId: 'size/oversize-paid-off',
            message: `已降至 ${lines} 行（≤ ${FILE_LINE_LIMIT}），请从 KNOWN_OVERSIZE 移除该登记项以固化成果`,
          });
        }
        return [];
      }
      if (lines > known.max) {
        return [{
          file,
          line: known.max + 1,
          lineIdx: known.max,
          ruleId: 'size/oversize-grown',
          message: `文件从登记的 ${known.max} 行涨到 ${lines} 行。超限文件只允许继续拆分，禁止再增长；新增逻辑必须放进新模块`,
          snippet: (ctx.rawLines[known.max] ?? '').trim().slice(0, 110),
        }];
      }
      return [];
    }

    if (lines <= FILE_LINE_LIMIT) return [];

    return [{
      file,
      line: FILE_LINE_LIMIT + 1,
      lineIdx: FILE_LINE_LIMIT,
      ruleId: 'size/oversize-new',
      message: `文件 ${lines} 行超过上限 ${FILE_LINE_LIMIT} 行。请按领域拆分为多个模块（每个不超过上限），而不是继续在单文件里堆逻辑`,
      snippet: (ctx.rawLines[FILE_LINE_LIMIT] ?? '').trim().slice(0, 110),
    }];
  },
};

/* ------------------------------------------------------------------ *
 * Gate 2 · 测试完整性（防"让门禁变绿"的作弊手法）
 * ------------------------------------------------------------------ */

/**
 * 测试完整性规则。
 *
 * 设计意图 (Why)：
 *   AI 最容易的作弊路径不是写错代码，而是让门禁变绿：吞掉覆盖率豁免、
 *   在测试里强制成功退出、或用行内豁免注释吸收新增违规。这些手法不会报错，
 *   只会让"保护"静默消失，因此必须由静态规则计数并只降不升。
 *
 * 防范的历史坑 (Pitfall)（均有实测依据）：
 *   1. `/* c8 ignore next *\/` 让新增行根本不进 lcov，增量覆盖门禁对这段代码直接失效。
 *   2. 测试文件里的顶层 `process.exit(0)` 与 `uncaughtException` 内 `process.exit(0)`
 *      都能把真实失败吞成 exit=0 / pass=1（census 能识破，静态规则让它一开始就写不出来）。
 *   3. `gate-*-allow` 不设上限时，"加一条 allow"会成为让门禁变绿的最短路径。
 *
 * 约束与规则 (Rules)：
 *   - 三条计数都进 baseline 棘轮体系（键含规则 + 文件 + 行内容指纹）。
 *   - 显式失败退出（非 0）是合法的，只拦"强制成功"。
 */
export const testIntegrityRules = {
  id: 'test-integrity',
  gate: 'Gate 2',
  title: '测试完整性（禁止覆盖率豁免 / 测试内强制成功退出 / 豁免注释堆积）',
  check(file, ctx) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) return [];
    const out = [];

    /**
     * 1. 覆盖率豁免注释。
     * 它会让该行不进覆盖率报告，等价于对这段代码关闭增量覆盖门禁。
     *
     * 判定必须落在「真正的注释行」上：文档块里的示例（以 `*` 开头）与
     * 字符串字面量里的说明（例如规则自己的诊断文案）都不是豁免申请，
     * 若一并计入，规则会举报它自己，计数随即失去意义。
     */
    const c8Re = /(?:\/\/|\/\*)\s*(?:c8|v8|istanbul)\s+ignore\b/;
    ctx.rawLines.forEach((line, i) => {
      if (!c8Re.test(line)) return;
      if (/^\s*\*/.test(line)) return;
      // 去注释视图里仍残留该标记 => 它在字符串里，不是注释
      if (c8Re.test(ctx.codeLines[i] ?? '')) return;
      out.push({
        file,
        line: i + 1,
        lineIdx: i,
        ruleId: 'test-integrity/c8-ignore',
        message: '禁止用覆盖率豁免注释隐藏未覆盖代码：请补真实测试，或改用带 issue 的显式登记',
        snippet: line.trim().slice(0, 110),
      });
    });

    /**
     * 2. 测试文件内的强制成功退出。
     * 生产代码需要退出码，不受此限；测试文件里只允许退出非 0 的失败码。
     */
    const isTestFile = file.includes('/__tests__/') || /\.test\.(mjs|cjs|js)$/.test(file);
    if (isTestFile) {
      ctx.codeLines.forEach((line, i) => {
        if (!/\bprocess\.exit(Code)?\s*\(/.test(line)) return;
        // 显式失败退出是合法的
        if (/\bprocess\.exit(Code)?\s*\(\s*[1-9]/.test(line)) return;
        if (/process\.exitCode\s*=\s*[1-9]/.test(line)) return;
        out.push({
          file,
          line: i + 1,
          lineIdx: i,
          ruleId: 'test-integrity/test-exit',
          message: '测试文件禁止强制成功退出：顶层或异常钩子里的 exit(0) 会把真实失败吞成全绿',
          snippet: line.trim().slice(0, 110),
        });
      });
    }

    /**
     * 3. 测试代码的时区依赖。
     *
     * 【设计意图 (Why)】绝对时间戳（`1730472540000`）是 UTC 语义，而
     * `getHours() / getMinutes() / toLocaleTimeString()` 取的是**运行机器本地时区**。
     * 把两者凑在一起，等于把「跑测试的机器是哪个时区」当成隐含前提。
     * 实测事故：本地 UTC+8 得到 `昨天 22:49` 通过，GitHub 的 UTC runner
     * 得到 `昨天 14:49` 稳定失败，报错看起来像业务逻辑坏了，实际是测试假设坏了。
     *
     * 【约束与规则 (Rules)】
     *   1. 只扫测试文件：生产代码用本地时区展示是正确行为，不该被拦；
     *   2. 命中即为违规（非警告）：时区依赖必然在某个 runner 上失败，
     *      不存在"这次碰巧没事"的合法情形；
     *   3. 正确写法是 `getUTCHours()/getUTCMinutes()` 或显式传入时区，
     *      并在注释里声明取值口径。
     */
    if (isTestFile) {
      const tzRe = /\.(getHours|getMinutes|getDate|getDay|getMonth|getFullYear)\s*\(\s*\)|\.toLocale(?:Time|Date)?String\s*\(/;
      /**
       * 本模块不 import scanner（规则只消费 ctx 提供的去注释视图），
       * 因此豁免判定在此就地实现，语义与 scanner.hasInlineAllowance 保持一致：
       * 当前行或上一行出现 `gate-tz-allow` 即视为豁免。
       */
      const allowAt = (idx) => {
        const marker = 'gate-tz-allow';
        return (ctx.rawLines[idx] ?? '').includes(marker) || (ctx.rawLines[idx - 1] ?? '').includes(marker);
      };
      ctx.codeLines.forEach((line, i) => {
        if (!tzRe.test(line)) return;
        if (/getUTC/.test(line)) return;
        if (allowAt(i)) return;
        out.push({
          file,
          line: i + 1,
          lineIdx: i,
          ruleId: 'test-integrity/timezone-dependent',
          message: '测试断言不得依赖运行机器本地时区：getHours()/toLocaleString() 在 CI(UTC) 与本地(UTC+8) 结果不同。请改用 getUTCHours()/getUTCMinutes()，或用 // gate-tz-allow: 理由 显式豁免',
          snippet: line.trim().slice(0, 110),
        });
      });
    }

    /**
     * 4. 行内豁免注释。
     *
     * 【设计意图 (Why)】豁免机制本身是必要的（平台分支、外部依赖缺失等），
     * 把「每条豁免」当成违规会破坏既有语义：合法的豁免会被判成错误，
     * 反而逼着人去删掉本该保留的理由。因此本规则只做一件更弱但更正确的事：
     * 在 warnings 通道汇总本文件的豁免条数，让数量每次运行都可见。
     * 真正的「只降不升」由 scripts/gates/allow-budget.mjs 按仓库总量判定，
     * 那里比逐行计数更贴近目标（它约束的是总敞口，而不是某一行）。
     */
    let allowCount = 0;
    for (let i = 0; i < ctx.rawLines.length; i += 1) {
      const line = ctx.rawLines[i];
      if (!/gate-[a-z0-9-]+-allow\s*:/.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;
      if (/gate-[a-z0-9-]+-allow\s*:/.test(ctx.codeLines[i] ?? '')) continue;
      allowCount += 1;
    }
    if (allowCount > 0 && ctx.warnings) {
      ctx.warnings.push({
        file,
        line: 1,
        ruleId: 'test-integrity/allow-comment',
        message: `本文件含 ${allowCount} 条行内豁免；仓库总敞口由 allow-budget.mjs 按只降不升判定`,
      });
    }

    return out;
  },
};

/* ------------------------------------------------------------------ *
 * Gate 2 · 测试执行性能与夹具洁净（防止慢测试回潮）
 * ------------------------------------------------------------------ */

/**
 * 真实本地 I/O（HTTP / WebSocket / 真实浏览器子进程）集成测试白名单。
 * 这些测试受外部协议/端口生命周期驱动，不纳入纯单测 sleep 阻断，但仍受行数上限约束。
 */
export const REAL_IO_SLEEP_TESTS = new Set([
  'packages/core/__tests__/rpc/gateway-e2e.test.mjs',
  'packages/core/__tests__/rpc/live-gateway-real.test.mjs',
  'packages/core/__tests__/rpc/live-gateway.test.mjs',
  'scripts/__tests__/start-browser-live.test.mjs',
]);

/**
 * 存量单元/集成测试中历史遗留真实 `Promise + setTimeout(>=20ms 或变量延迟)` 冻结上限。
 * 【冻结规则】只允许清零或下调，增 1 处即阻断，倒逼逐步迁移到 `t.mock.timers`。
 */
export const KNOWN_REAL_SLEEP_TESTS = {
  'packages/core/__tests__/coalesce/tokenCoalescer.test.mjs': { max: 1 },
  'packages/core/__tests__/rpc/client.test.mjs': { max: 1 },
  'packages/core/__tests__/rpc/lifecycle-heartbeat.test.mjs': { max: 2 },
  'packages/core/__tests__/rpc/ticket-refresh.test.mjs': { max: 2 },
  'packages/desktop/__tests__/unit/appBootstrap.test.mjs': { max: 2 },
  'packages/desktop/__tests__/unit/completion-domain.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/delete-session-focus.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/desktop-cache-bridge.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/desktop-stream-viewport.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/fileViewerService.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/foreground-sync-coordinator.test.mjs': { max: 5 },
  'packages/desktop/__tests__/unit/long-session-scroll-restore.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/mediaResolver.test.mjs': { max: 2 },
  'packages/desktop/__tests__/unit/messageLoadingService.test.mjs': { max: 6 },
  'packages/desktop/__tests__/unit/power-events.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/reconnect-stage-preservation.test.mjs': { max: 4 },
  'packages/desktop/__tests__/unit/session-status-service.test.mjs': { max: 8 },
  'packages/desktop/__tests__/unit/session-subtitles-offline.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/settings-controller.test.mjs': { max: 1 },
  'packages/desktop/__tests__/unit/settingsDataService.test.mjs': { max: 3 },
  'packages/ui/__tests__/mobile-workspace-shell.test.mjs': { max: 4 },
};

/** 存量开启了 mock.timers 但暂未配对 reset() 的冻结清单（只降不升） */
export const KNOWN_MISSING_TIMER_RESET = new Set([
  'packages/desktop/__tests__/unit/session-status-service.test.mjs',
]);

/**
 * 遮蔽字符串字面量内容并保留定界引号、`${...}` 插值代码态、正则字面量与全部换行位置。
 *
 * 【设计意图 (Why)】`ctx.codeLines` 已剥离注释但保留字符串；若不遮蔽字符串，规则会把
 *   断言错误信息或诊断文案里的示例代码误判为真实违规；若不跳过正则字面量（如 `/['"`]/`），
 *   正则内部的引号会破坏后续引号配对并引发整文件错判。
 * 【约束与规则 (Rules)】返回字符串长度与 `\n` 位置必须与输入完全一致。
 */
export function stripStringsKeepLines(code) {
  const n = code.length;
  const buf = new Array(n);
  const stack = [];
  const interpDepths = [];
  let state = 'code'; // code | single | double | template | interpolation
  let escaped = false;

  const enter = (nextState) => {
    stack.push(state);
    state = nextState;
  };
  const leave = () => {
    state = stack.length > 0 ? stack.pop() : 'code';
  };

  for (let i = 0; i < n; i += 1) {
    const c = code[i];
    const next = code[i + 1];

    if (state === 'single' || state === 'double' || state === 'template') {
      if (state === 'template' && !escaped && c === '$' && next === '{') {
        buf[i] = c;
        buf[i + 1] = next;
        i += 1;
        interpDepths.push(0);
        enter('interpolation');
        continue;
      }
      if (escaped) {
        buf[i] = c === '\n' ? '\n' : ' ';
        escaped = false;
        continue;
      }
      if (c === '\\') {
        buf[i] = ' ';
        escaped = true;
        continue;
      }
      if (
        (state === 'single' && c === "'") ||
        (state === 'double' && c === '"') ||
        (state === 'template' && c === '`')
      ) {
        buf[i] = c;
        leave();
        continue;
      }
      buf[i] = c === '\n' ? '\n' : ' ';
      continue;
    }

    if (state === 'interpolation') {
      if (c === '{') {
        interpDepths[interpDepths.length - 1] += 1;
        buf[i] = c;
        continue;
      }
      if (c === '}') {
        if (interpDepths[interpDepths.length - 1] === 0) {
          buf[i] = c;
          interpDepths.pop();
          leave();
        } else {
          interpDepths[interpDepths.length - 1] -= 1;
          buf[i] = c;
        }
        continue;
      }
    }

    // 正则字面量原样保留，避免 `/['"`]/` 内嵌引号引发字符串状态失衡
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(code[j])) j -= 1;
      const prevChar = j >= 0 ? code[j] : '';
      const regexAllowed =
        prevChar === '' ||
        /[(,=:[!&|?{};+\-*%^~<>]/.test(prevChar) ||
        /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)\s*$/.test(
          code.slice(Math.max(0, j - 12), j + 1),
        );
      if (regexAllowed) {
        const start = i;
        let k = i + 1;
        let inClass = false;
        let closed = false;
        while (k < n) {
          const ch = code[k];
          if (ch === '\\') { k += 2; continue; }
          if (ch === '\n') break;
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { closed = true; break; }
          k += 1;
        }
        if (closed) {
          for (let m = start; m <= k; m += 1) buf[m] = code[m];
          let m = k + 1;
          while (m < n && /[a-z]/i.test(code[m])) {
            buf[m] = code[m];
            m += 1;
          }
          i = m - 1;
          continue;
        }
      }
    }

    if (c === "'") {
      enter('single');
      buf[i] = c;
      continue;
    }
    if (c === '"') {
      enter('double');
      buf[i] = c;
      continue;
    }
    if (c === '`') {
      enter('template');
      buf[i] = c;
      continue;
    }

    buf[i] = c;
  }

  return buf.join('');
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let k = 0; k < offset && k < text.length; k += 1) {
    if (text[k] === '\n') line += 1;
  }
  return line;
}

const HELPER_UNIT_RE = /\/__tests__\/unit\/helpers\/[^/]+\.mjs$/;
const E2E_OR_CDP_RE = /\/(?:e2e|cdp)\//;
const TIMERS_PROMISES_RE = /(?:from|import)\s*\(?\s*['"](?:node:)?timers\/promises['"]/g;
const REAL_PROMISE_SLEEP_RE = /\bnew\s+Promise\s*\([\s\S]{0,80}?setTimeout\s*\([^,\n]+,\s*([^)\n]+)\)/g;
const HELPER_DIST_IMPORT_RE = /(?:from|import)\s*\(?\s*['"][^'"]*\/dist\//g;

/**
 * 测试执行性能与夹具洁净门禁。
 *
 * 【设计意图 (Why)】
 *   Stryker 变异测试在最坏情况下对每个变异体都要重跑对应整份测试文件：
 *   1 处 50ms 的真实 `setTimeout` 在 300 个变异体下就是 15 秒空等，累计可拖慢至十余分钟；
 *   同时 `npm test` 采用多进程并发运行，夹具篡改 `globalThis` 或耦合 `dist/` 会污染并发隔离。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `turnExecutionService.test.mjs` 与 `slidingWatchdog.test.mjs` 曾含大量真实 `setTimeout` 与轮询，
 *      导致 `turnExecutionWatchdog` 单域变异测试高达 ~12.2 分钟（改造为 `t.mock.timers` + 按域拆文件后降至 37.9s）。
 *   2. `timers/promises` 的 `setTimeout(delay)` 同样造成真实墙钟阻塞且可绕过 `new Promise` 形态扫描。
 *
 * 【约束与规则 (Rules)】
 *   - 仅作用于单元/形式化测试与 `unit/helpers/*.mjs`，生产源码与 e2e/cdp/真实 I/O 白名单不误伤；
 *   - `t.mock.timers.enable(...)` 必须与 `t.mock.timers.reset()` 成对出现，禁止向生产源码注入虚拟时钟参数；
 *   - 存量清单只降不升，清零后应从冻结表中删除以固化成果。
 */
export const testPerfRules = {
  id: 'test-perf',
  gate: 'Gate 2',
  testAware: true,
  title: '测试执行性能与夹具洁净（禁新增真实 sleep / 禁夹具污染 / 虚拟时钟配对清理）',
  check(file, ctx) {
    const isHelper = HELPER_UNIT_RE.test(file);
    const isUnitOrFormalTest =
      (file.includes('/__tests__/') || /\.test\.(mjs|cjs|js)$/.test(file)) &&
      !E2E_OR_CDP_RE.test(file) &&
      !file.includes('/helpers/');

    if (!isHelper && !isUnitOrFormalTest) return [];

    const code = ctx.codeLines.join('\n');
    const masked = stripStringsKeepLines(code);
    const out = [];

    if (isHelper) {
      TIMERS_PROMISES_RE.lastIndex = 0;
      HELPER_DIST_IMPORT_RE.lastIndex = 0;
      for (const m of code.matchAll(HELPER_DIST_IMPORT_RE)) {
        if (masked.slice(m.index, m.index + 4) !== code.slice(m.index, m.index + 4)) continue;
        const line = lineNumberAt(code, m.index);
        const lineIdx = line - 1;
        out.push({
          file,
          line,
          lineIdx,
          ruleId: 'test-perf/no-helper-dist-import',
          message: 'unit/helpers 夹具禁止直接 import dist/ 编译产物：请改为从调用侧测试注入被测工厂函数',
          snippet: (ctx.rawLines[lineIdx] ?? '').trim().slice(0, 110),
        });
      }

      const maskedLines = masked.split('\n');
      for (let i = 0; i < maskedLines.length; i += 1) {
        if (!/\bglobalThis\b/.test(maskedLines[i])) continue;
        out.push({
          file,
          line: i + 1,
          lineIdx: i,
          ruleId: 'test-perf/no-helper-global-patch',
          message: 'unit/helpers 夹具禁止读写 globalThis 全局态，防止并发单测互相污染',
          snippet: (ctx.rawLines[i] ?? '').trim().slice(0, 110),
        });
      }
      return out;
    }

    if (!REAL_IO_SLEEP_TESTS.has(file)) {
      for (const m of code.matchAll(TIMERS_PROMISES_RE)) {
        if (masked.slice(m.index, m.index + 4) !== code.slice(m.index, m.index + 4)) continue;
        const line = lineNumberAt(code, m.index);
        const lineIdx = line - 1;
        out.push({
          file,
          line,
          lineIdx,
          ruleId: 'test-perf/no-real-sleep',
          message: '单元/集成测试禁止导入 timers/promises 进行真实墙钟等待：请改用 t.mock.timers 与确定性 tick 推进或 Promise 门闩',
          snippet: (ctx.rawLines[lineIdx] ?? '').trim().slice(0, 110),
        });
      }

      const sleepHits = [];
      for (const m of masked.matchAll(REAL_PROMISE_SLEEP_RE)) {
        const arg = m[1].trim();
        const isBigLiteral = /^\d+$/.test(arg) && Number(arg) >= 20;
        const isVarDelay = !/^\d+$/.test(arg) && arg !== '0';
        if (!isBigLiteral && !isVarDelay) continue;
        const line = lineNumberAt(masked, m.index);
        const lineIdx = line - 1;
        sleepHits.push({
          file,
          line,
          lineIdx,
          ruleId: 'test-perf/no-real-sleep',
          message:
            '单元/集成测试禁止新增真实 setTimeout 空等（≥20ms 或变量延迟）：' +
            '请改用 node:test 的 t.mock.timers.enable({ apis: [\'setTimeout\', \'Date\'] }) + 确定性推进或微任务门闩，且严禁向生产源码注入虚拟时钟参数',
          snippet: (ctx.rawLines[lineIdx] ?? '').trim().slice(0, 110),
        });
      }

      const knownSleep = KNOWN_REAL_SLEEP_TESTS[file];
      if (knownSleep) {
        if (sleepHits.length === 0 && ctx.warnings) {
          ctx.warnings.push({
            file,
            line: 1,
            ruleId: 'test-perf/real-sleep-paid-off',
            message: '存量真实 sleep 已清零，请从 KNOWN_REAL_SLEEP_TESTS 移除该登记项以固化成果',
          });
        } else if (sleepHits.length > knownSleep.max) {
          out.push(...sleepHits.slice(knownSleep.max));
        }
      } else {
        out.push(...sleepHits);
      }
    }

    const enableMatch = /\bmock\.timers\.enable\s*\(/.exec(masked);
    if (enableMatch && !/\bmock\.timers\.reset\s*\(/.test(masked) && !KNOWN_MISSING_TIMER_RESET.has(file)) {
      const line = lineNumberAt(masked, enableMatch.index);
      const lineIdx = line - 1;
      out.push({
        file,
        line,
        lineIdx,
        ruleId: 'test-perf/mock-timers-cleanup',
        message: '使用 mock.timers.enable() 必须配对调用 mock.timers.reset()（建议放入 try { ... } finally { t.mock.timers.reset(); } 或 afterEach）',
        snippet: (ctx.rawLines[lineIdx] ?? '').trim().slice(0, 110),
      });
    }

    return out;
  },
};
