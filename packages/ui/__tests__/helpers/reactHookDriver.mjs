/**
 * 轻量 React 19 内存 Hook 驱动器与虚拟节点树查询工具 (Node Headless Helper)
 *
 * 用于脱离浏览器 DOM 在 `node --test` 中直接驱动组件内的 `useState` / `useEffect` /
 * `useRef` / `useMemo` / `useCallback` / `useContext` / `useId` / `onClick` / `onChange` 等交互分支。
 */
import React from 'react';

export function createHookDriver(refOverrides = {}, { shallowComponents = [] } = {}) {
  const slots = new Map();
  let pendingEffects = [];
  const shallowSet = new Set(shallowComponents);

  function resolve(node, key = 'root') {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item, idx) => resolve(item, `${key}[${idx}]`));
    }
    if (typeof node !== 'object') return node;

    const elType = node.type;
    if (typeof elType === 'symbol') {
      return { ...node, props: { ...node.props, children: resolve(node.props?.children, `${key}.frag`) } };
    }
    if (shallowSet.has(elType)) {
      return node;
    }
    const innerType =
      elType && typeof elType === 'object' && elType.$$typeof === Symbol.for('react.memo')
        ? elType.type
        : elType;
    const compFn =
      innerType && typeof innerType === 'object' && innerType.$$typeof === Symbol.for('react.forward_ref')
        ? (p) => innerType.render(p, p.ref ?? node.ref ?? null)
        : typeof innerType === 'function'
          ? innerType
          : null;

    if (compFn) {
      const scopedKey = node.key != null ? `${key}#k=${String(node.key)}` : key;
      let slot = slots.get(scopedKey);
      if (!slot) {
        slot = { states: [], refs: [], memos: [], effects: [] };
        slots.set(scopedKey, slot);
      }
      let sIdx = 0;
      let rIdx = 0;
      let mIdx = 0;
      let eIdx = 0;
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;
      const scheduleEffect = (fn, deps) => {
        const idx = eIdx++;
        if (idx >= slot.effects.length) {
          slot.effects.push({ deps, cleanup: undefined, hasRun: false });
        }
        const entry = slot.effects[idx];
        const changed =
          !entry.hasRun ||
          deps === undefined ||
          entry.deps === undefined ||
          deps.length !== entry.deps.length ||
          deps.some((d, i) => !Object.is(d, entry.deps[i]));
        if (changed) {
          pendingEffects.push(() => {
            if (typeof entry.cleanup === 'function') {
              entry.cleanup();
              entry.cleanup = undefined;
            }
            entry.deps = deps;
            entry.hasRun = true;
            const cleanup = fn();
            if (typeof cleanup === 'function') entry.cleanup = cleanup;
          });
        }
      };
      internals.H = {
        useState(init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) slot.states.push(typeof init === 'function' ? init() : init);
          return [slot.states[idx], (next) => { slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next; }];
        },
        useRef(init) {
          const idx = rIdx++;
          if (idx >= slot.refs.length) slot.refs.push({ current: init });
          return slot.refs[idx];
        },
        useMemo(factory, deps) {
          const idx = mIdx++;
          if (idx >= slot.memos.length) {
            slot.memos.push({ value: factory(), deps });
          } else {
            const prev = slot.memos[idx];
            if (!deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]))) {
              slot.memos[idx] = { value: factory(), deps };
            }
          }
          return slot.memos[idx].value;
        },
        useCallback(cb) { return cb; },
        useImperativeHandle(ref, create) {
          if (typeof ref === 'function') ref(create());
          else if (ref) ref.current = create();
        },
        useTransition() { return [false, (fn) => fn()]; },
        useDeferredValue(val) { return val; },
        use(usable) { return usable?._currentValue; },
        useDebugValue() {},
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
        useInsertionEffect: scheduleEffect,
        useContext(ctx) { return ctx?._currentValue; },
        useId() { return `id-${scopedKey}`; },
        useSyncExternalStore(_sub, getSnap) { return getSnap(); },
      };
      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${scopedKey}>${compFn.name || 'Fn'}`);
    }

    const refObj = node.props?.ref ?? node.ref;
    if (refObj && typeof refObj === 'object' && !refObj.current) {
      refObj.current = { contains: () => false, ...refOverrides };
    }

    if (node.props && 'children' in node.props) {
      return { ...node, props: { ...node.props, children: resolve(node.props.children, key) } };
    }
    return node;
  }

  return {
    mount(renderFn) {
      let tree = null;
      const rerender = () => {
        pendingEffects = [];
        tree = resolve(renderFn(), 'root');
        const current = pendingEffects;
        pendingEffects = [];
        for (const fn of current) fn();
        return tree;
      };
      rerender();
      return {
        get tree() { return tree; },
        rerender,
        unmount() {
          for (const slot of slots.values()) {
            for (const entry of slot.effects) {
              if (typeof entry.cleanup === 'function') entry.cleanup();
            }
          }
        },
      };
    },
  };
}

export function findAll(node, pred, acc = []) {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, pred, acc);
    return acc;
  }
  if (pred(node)) acc.push(node);
  if (node.props?.children) findAll(node.props.children, pred, acc);
  return acc;
}

export function findByTestId(node, testId) {
  return findAll(node, (n) => n?.props?.['data-testid'] === testId)[0] ?? null;
}

export async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}
