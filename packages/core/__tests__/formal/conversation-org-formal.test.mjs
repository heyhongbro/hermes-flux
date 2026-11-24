/**
 * 会话组织域形式化安全不变量证明（INV-ORG-01 ~ INV-ORG-07）
 *
 * 使用 fast-check 在数千种随机文件夹、项目路径、并发 CAS 冲突与删除/归档序列下证明：
 *   - Bot 终身主工位（Forever Chat）物理免疫；
 *   - 单一归属优先级与互斥收敛；
 *   - 最长前缀与严格目录边界路径匹配；
 *   - 删除文件夹非破坏性；
 *   - 群聊完成态往返收敛；
 *   - 三路 CAS 合流零悬空指向；
 *   - 僵尸键清理完备与强幂等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  ORG_UNASSIGNED_SENTINEL,
  assignEntityInMeta,
  buildRoomEntityKey,
  buildSessionEntityKey,
  createFolderInMeta,
  deleteFolderInMeta,
  isPathWithinDirectory,
  matchProjectByCwd,
  mergeDoneRoomsMetaForCas,
  mergeFoldersMetaForCas,
  normalizePathForMatch,
  pruneStaleOrgKeys,
  resolveEntityContainer,
  setRoomDoneInMeta,
  toProjectContainerId,
} from '../../dist/index.js';

const slugArb = fc
  .stringMatching(/^[a-z0-9][a-z0-9_-]{0,10}$/)
  .filter((s) => s !== ORG_UNASSIGNED_SENTINEL && !s.startsWith('prj:'));

const folderArb = fc.record({
  id: slugArb.map((s) => `fld_${s}`),
  name: fc.stringMatching(/^[a-zA-Z0-9\u4e00-\u9fa5_-]{1,12}$/),
  order: fc.integer({ min: 0, max: 50 }),
  createdAt: fc.integer({ min: 1, max: 100_000 }),
  updatedAt: fc.integer({ min: 1, max: 100_000 }),
});

const uniqueFoldersArb = fc.uniqueArray(folderArb, {
  selector: (f) => f.id,
  minLength: 0,
  maxLength: 6,
});

const posixSegArb = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);
const posixPathArb = fc
  .array(posixSegArb, { minLength: 1, maxLength: 5 })
  .map((segs) => `/${segs.join('/')}`);

const projectArb = fc.record({
  id: slugArb.map((s) => `p_${s}`),
  primaryPath: posixPathArb,
  additionalFolders: fc.array(posixPathArb, { minLength: 0, maxLength: 2 }),
  archived: fc.boolean(),
});

const uniqueProjectsArb = fc.uniqueArray(projectArb, {
  selector: (p) => p.id,
  minLength: 0,
  maxLength: 6,
});

test('INV-ORG-01 [Bot 终身主工位物理免疫]: hidden/isForeverChat 永远解析为 null 且禁止移入容器', () => {
  fc.assert(
    fc.property(
      uniqueFoldersArb,
      uniqueProjectsArb,
      slugArb,
      posixPathArb,
      fc.boolean(),
      (folders, projects, sid, cwd, viaHidden) => {
        const key = buildSessionEntityKey('default', sid);
        const assignments = {};
        if (folders[0]) assignments[key] = folders[0].id;
        else if (projects[0]) assignments[key] = toProjectContainerId(projects[0].id);

        const resolved = resolveEntityContainer({
          entityKey: key,
          cwd,
          isForeverChat: !viaHidden,
          hidden: viaHidden,
          folders,
          assignments,
          projects,
        });
        assert.equal(resolved, null);

        assert.throws(() =>
          assignEntityInMeta(
            { version: 1, folders, assignments: {} },
            { entityKey: key, containerId: folders[0]?.id ?? ORG_UNASSIGNED_SENTINEL, isForeverChat: true },
          ),
        );
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-ORG-02 [单归属容器优先级与互斥收敛]: 哨兵 __none__ 必清空，显式合法归属恒胜出 cwd', () => {
  fc.assert(
    fc.property(
      uniqueFoldersArb,
      uniqueProjectsArb,
      slugArb,
      posixPathArb,
      (folders, projects, sid, cwd) => {
        const key = buildSessionEntityKey('bot-a', sid);
        const activeProjects = projects.filter((p) => !p.archived);

        // 1. 哨兵解绑：即使 cwd 命中项目，也必须解析为 null
        assert.equal(
          resolveEntityContainer({
            entityKey: key,
            cwd,
            folders,
            assignments: { [key]: ORG_UNASSIGNED_SENTINEL },
            projects,
          }),
          null,
        );

        // 2. 显式自定义文件夹胜出 cwd 匹配项目
        if (folders.length > 0) {
          const targetFolder = folders[0];
          const res = resolveEntityContainer({
            entityKey: key,
            cwd,
            folders,
            assignments: { [key]: targetFolder.id },
            projects,
          });
          assert.deepEqual(res, { kind: 'folder', folderId: targetFolder.id });
        }

        // 3. 无显式归属时回落至 cwd 活跃项目匹配
        const expectedProjectId = matchProjectByCwd(cwd, projects);
        const cwdRes = resolveEntityContainer({
          entityKey: key,
          cwd,
          folders,
          assignments: {},
          projects,
        });
        if (expectedProjectId) {
          assert.deepEqual(cwdRes, { kind: 'project', projectId: expectedProjectId });
          assert.equal(activeProjects.some((p) => p.id === expectedProjectId), true);
        } else {
          assert.equal(cwdRes, null);
        }
      },
    ),
    { numRuns: 300 },
  );
});

test('INV-ORG-03 [最长前缀与严格目录边界路径匹配]: 拒绝兄妹前缀溢出、排除归档并取最长前缀', () => {
  fc.assert(
    fc.property(uniqueProjectsArb, posixPathArb, (projects, cwd) => {
      const normCwd = normalizePathForMatch(cwd);
      const matchedId = matchProjectByCwd(cwd, projects);

      // 算出所有合法活跃候选路径的长度
      const matchingLengths = [];
      for (const proj of projects) {
        if (proj.archived) continue;
        for (const candidate of [proj.primaryPath, ...(proj.additionalFolders ?? [])]) {
          const normDir = normalizePathForMatch(candidate);
          if (normDir && isPathWithinDirectory(normCwd, normDir)) {
            matchingLengths.push({ id: proj.id, len: normDir.length });
          }
        }
      }

      if (matchingLengths.length === 0) {
        assert.equal(matchedId, null);
      } else {
        const maxLen = Math.max(...matchingLengths.map((m) => m.len));
        const winners = new Set(matchingLengths.filter((m) => m.len === maxLen).map((m) => m.id));
        assert.ok(matchedId && winners.has(matchedId), '命中项目必须属于最长前缀匹配集合且未归档');
      }

      // 兄妹目录守卫：/a/b-extra 绝不匹配 /a/b
      assert.equal(isPathWithinDirectory('/work/app-v2', '/work/app'), false);

      // LeftRailProject 形状（仅含 path、不含 primaryPath）必须与 primaryPath 同等参与最长前缀裁决
      const railShaped = projects.map((p) => ({
        id: p.id,
        path: p.primaryPath,
        additionalFolders: p.additionalFolders,
        archived: p.archived,
      }));
      assert.equal(matchProjectByCwd(cwd, railShaped), matchedId);
    }),
    { numRuns: 350 },
  );
});

test('INV-ORG-04 [删除文件夹非破坏性守恒]: 目标文件夹映射清零且不伤及他目录与现有实体', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(folderArb, { selector: (f) => f.id, minLength: 1, maxLength: 6 }),
      fc.array(fc.tuple(slugArb, fc.integer({ min: 0, max: 10 })), { minLength: 1, maxLength: 12 }),
      (folders, rawPairs) => {
        const targetId = folders[0].id;
        const assignments = {};
        for (const [id, pick] of rawPairs) {
          const key = buildSessionEntityKey('default', id);
          if (pick % 3 === 0) assignments[key] = targetId;
          else if (folders[1] && pick % 3 === 1) assignments[key] = folders[1].id;
          else assignments[key] = ORG_UNASSIGNED_SENTINEL;
        }
        const meta = { version: 1, folders, assignments };
        const next = deleteFolderInMeta(meta, targetId);

        assert.equal(next.folders.some((f) => f.id === targetId), false);
        assert.equal(next.folders.length, folders.length - 1);
        assert.equal(Object.values(next.assignments).includes(targetId), false);

        for (const [key, val] of Object.entries(assignments)) {
          if (val !== targetId) {
            assert.equal(next.assignments[key], val, '非目标文件夹的实体归属必须原样保留');
          } else {
            assert.equal(next.assignments[key], undefined, '目标文件夹映射必须被解除');
          }
        }
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-ORG-05 [群聊完成态往返恒等与强幂等]: 标记完成/恢复不污染他群且重复执行幂等', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(slugArb, fc.integer({ min: 1, max: 100_000 })), { maxLength: 10 }),
      slugArb,
      fc.integer({ min: 100, max: 200_000 }),
      (entries, targetRoom, ts) => {
        const done = {};
        for (const [rid, doneTs] of entries) {
          if (rid !== targetRoom) done[`r_${rid}`] = doneTs;
        }
        const initial = { version: 1, done };
        const marked = setRoomDoneInMeta(initial, `r_${targetRoom}`, true, ts);
        assert.equal(marked.done[`r_${targetRoom}`], ts);
        assert.deepEqual(setRoomDoneInMeta(marked, `r_${targetRoom}`, true, ts), marked);

        const restored = setRoomDoneInMeta(marked, `r_${targetRoom}`, false, ts + 1);
        assert.equal(restored.done[`r_${targetRoom}`], undefined);
        assert.deepEqual(restored.done, initial.done, '标记再恢复后其余群聊完成表必须严格复原');
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-ORG-06 [三路 CAS 合并收敛不变量]: 并行互不相交修改不互相覆盖且零悬空自定义文件夹指向', () => {
  fc.assert(
    fc.property(
      slugArb,
      slugArb,
      slugArb,
      fc.integer({ min: 100, max: 900 }),
      (sLocal, sRemote, fSuffix, ts) => {
        fc.pre(sLocal !== sRemote);
        const base = { version: 1, folders: [], assignments: {} };
        const localCreate = createFolderInMeta(base, {
          id: `fld_l_${fSuffix}`,
          name: '本地组',
          now: ts,
        });
        const local = assignEntityInMeta(localCreate.meta, {
          entityKey: buildSessionEntityKey('default', `local_${sLocal}`),
          containerId: localCreate.folder.id,
        });

        const remoteCreate = createFolderInMeta(base, {
          id: `fld_r_${fSuffix}`,
          name: '远端组',
          now: ts + 10,
        });
        const remote = assignEntityInMeta(remoteCreate.meta, {
          entityKey: buildSessionEntityKey('default', `remote_${sRemote}`),
          containerId: remoteCreate.folder.id,
        });

        const merged = mergeFoldersMetaForCas(base, remote, local);
        const mergedIds = new Set(merged.folders.map((f) => f.id));
        assert.equal(mergedIds.has(localCreate.folder.id), true);
        assert.equal(mergedIds.has(remoteCreate.folder.id), true);
        assert.equal(
          merged.assignments[buildSessionEntityKey('default', `local_${sLocal}`)],
          localCreate.folder.id,
        );
        assert.equal(
          merged.assignments[buildSessionEntityKey('default', `remote_${sRemote}`)],
          remoteCreate.folder.id,
        );

        for (const target of Object.values(merged.assignments)) {
          if (target !== ORG_UNASSIGNED_SENTINEL && !target.startsWith('prj:')) {
            assert.equal(mergedIds.has(target), true, '合并后禁止残留悬空文件夹引用');
          }
        }

        const mergedDone = mergeDoneRoomsMetaForCas(
          { version: 1, done: {} },
          { version: 1, done: { [`r_${sRemote}`]: ts + 1 } },
          { version: 1, done: { [`r_${sLocal}`]: ts + 2 } },
        );
        assert.equal(mergedDone.done[`r_${sRemote}`], ts + 1);
        assert.equal(mergedDone.done[`r_${sLocal}`], ts + 2);
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-ORG-07 [僵尸键清理完备性与强幂等]: 仅剔除无效实体/容器键并满足二次清理幂等', () => {
  fc.assert(
    fc.property(
      uniqueFoldersArb,
      fc.array(slugArb, { maxLength: 6 }),
      fc.array(slugArb, { maxLength: 6 }),
      (folders, aliveSessions, deadSessions) => {
        const validSessionKeys = new Set(aliveSessions.map((id) => buildSessionEntityKey('default', `a_${id}`)));
        const validRoomIds = new Set(['room-live']);
        const validProjectIds = new Set(['p-live']);

        const assignments = {};
        for (const key of validSessionKeys) {
          assignments[key] = folders[0] ? folders[0].id : 'prj:p-live';
        }
        for (const dead of deadSessions) {
          assignments[buildSessionEntityKey('default', `d_${dead}`)] = folders[0] ? folders[0].id : 'prj:p-live';
        }
        if (folders[0]) {
          assignments[buildRoomEntityKey('room-live')] = folders[0].id;
          assignments[buildRoomEntityKey('room-dead')] = folders[0].id;
        }
        assignments[buildSessionEntityKey('default', 'orphan_target')] = 'fld_nonexistent';
        assignments[buildSessionEntityKey('default', 'orphan_prj')] = 'prj:p-gone';

        const once = pruneStaleOrgKeys(
          { version: 1, folders, assignments },
          { version: 1, done: { 'room-live': 10, 'room-dead': 20 } },
          { validSessionKeys, validRoomIds, validProjectIds },
        );
        const twice = pruneStaleOrgKeys(
          once.foldersMeta,
          once.doneRoomsMeta,
          { validSessionKeys, validRoomIds, validProjectIds },
        );

        assert.equal(twice.changed, false, '二次清理不得产生任何变更');
        assert.deepEqual(twice.foldersMeta, once.foldersMeta);
        assert.deepEqual(twice.doneRoomsMeta, once.doneRoomsMeta);

        for (const [key, val] of Object.entries(once.foldersMeta.assignments)) {
          if (key.startsWith('session:')) assert.equal(validSessionKeys.has(key), true);
          if (key.startsWith('room:')) assert.equal(validRoomIds.has(key.slice('room:'.length)), true);
          if (val.startsWith('prj:')) assert.equal(validProjectIds.has(val.slice('prj:'.length)), true);
          else if (val !== ORG_UNASSIGNED_SENTINEL) assert.equal(folders.some((f) => f.id === val), true);
        }
        assert.equal(once.doneRoomsMeta.done['room-dead'], undefined);
      },
    ),
    { numRuns: 250 },
  );
});
