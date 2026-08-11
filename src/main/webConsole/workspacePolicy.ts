import fs from 'fs';
import path from 'path';

/** 解析目标路径；目标尚不存在时，先解析最近存在父目录中的符号链接。 */
export const resolveWorkspaceCandidatePath = (candidate: string): string => {
  const unresolvedParts: string[] = [];
  let cursor = path.resolve(candidate);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    unresolvedParts.unshift(path.basename(cursor));
    cursor = parent;
  }
  const resolvedBase = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
  return path.resolve(resolvedBase, ...unresolvedParts);
};

/** 判断路径是否位于任一已授权工作区根目录内。 */
export const isPathWithinWorkspaceRoots = (candidate: string, roots: string[]): boolean => {
  const resolvedCandidate = resolveWorkspaceCandidatePath(candidate);
  return roots.some(root => {
    const resolvedRoot = resolveWorkspaceCandidatePath(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
};
