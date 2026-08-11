import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { isPathWithinWorkspaceRoots } from './workspacePolicy';

const tempRoots: string[] = [];

/** 创建并记录测试临时目录。 */
const makeTempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-workspace-policy-'));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  tempRoots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

describe('isPathWithinWorkspaceRoots', () => {
  test('允许工作区内路径并拒绝相邻目录', () => {
    const parent = makeTempRoot();
    const root = path.join(parent, 'project');
    fs.mkdirSync(root);
    expect(isPathWithinWorkspaceRoots(path.join(root, 'src', 'new.ts'), [root])).toBe(true);
    expect(isPathWithinWorkspaceRoots(path.join(parent, 'project-other', 'file.ts'), [root])).toBe(false);
  });

  test('拒绝通过工作区内符号链接访问外部的未创建文件', () => {
    const parent = makeTempRoot();
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'linked-outside'));
    expect(isPathWithinWorkspaceRoots(
      path.join(root, 'linked-outside', 'new.txt'),
      [root],
    )).toBe(false);
  });
});
