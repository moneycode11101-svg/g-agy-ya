import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {
  BUILTIN_PLUGIN_IDS,
  type BuiltinPluginPackage,
  type ConfigFieldSchema,
  type HostPluginModule,
  type PluginManifest,
} from '../../../src/kernel/shared/types';

export interface GitDiffFile {
  status: string;
  path: string;
}

export interface GitDiffSnapshot {
  ok: boolean;
  cwd: string;
  branch: string;
  files: GitDiffFile[];
  diffText: string;
  error?: string;
}

export const paneGitDiffConfigSchema: readonly ConfigFieldSchema[] = [
  {
    key: 'gitDiffBase',
    label: 'Git Diff 비교 기준',
    description: '워킹 트리 변경분만 볼지 HEAD 대비 전체 변경을 볼지 선택합니다.',
    group: 'Git Diff',
    type: 'segmented',
    defaultValue: 'working',
    options: [
      { value: 'working', label: '워킹 트리' },
      { value: 'head', label: 'HEAD 전체' },
    ],
    keywords: ['git', 'diff', 'head', '워킹 트리', '비교'],
  },
];

export const paneGitDiffManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_GIT_DIFF,
  name: 'Git Diff 뷰어',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: '로컬 Git 저장소의 변경 파일 목록과 Unified Diff를 표시하는 독립 패인',
  layer: 'app',
  category: 'pane',
  icon: 'GitCompareArrows',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/pane-git-diff/index.ts',
    client: './src/plugins/pane-git-diff/index.tsx',
  },
  capabilities: ['process:spawn', 'fs:read'],
  configSchema: paneGitDiffConfigSchema,
  contributes: {
    slots: ['pane.type', 'sidebar.section', 'settings.section'],
    paneTypes: [{ type: 'diff', label: 'Git Diff', icon: 'GitCompareArrows' }],
    commands: [{ id: 'pane-git-diff:new-tab', title: 'Git Diff 탭 열기', defaultShortcut: 'Mod+Shift+G' }],
  },
};

function runGitDiffSnapshot(cwd: string, diffBase: 'working' | 'head', filePath?: string): Promise<GitDiffSnapshot> {
  return new Promise((resolve) => {
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }, (branchErr, branchOut) => {
      if (branchErr) {
        resolve({
          ok: false,
          cwd: dir,
          branch: '',
          files: [],
          diffText: '',
          error: 'Git 저장소가 아닌 폴더입니다.',
        });
        return;
      }
      const branch = branchOut.trim();
      execFile('git', ['status', '--short'], { cwd: dir }, (_stErr, statusOut) => {
        const files: GitDiffFile[] = (statusOut || '')
          .split('\n')
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .map((line) => ({
            status: line.slice(0, 2).trim() || 'M',
            path: line.slice(3).trim(),
          }));

        const diffArgs = diffBase === 'head' ? ['diff', 'HEAD', '--no-color'] : ['diff', '--no-color'];
        if (filePath) diffArgs.push('--', filePath);
        execFile('git', diffArgs, { cwd: dir, maxBuffer: 2 * 1024 * 1024 }, (_dErr, diffOut) => {
          resolve({
            ok: true,
            cwd: dir,
            branch,
            files,
            diffText: diffOut || '',
          });
        });
      });
    });
  });
}

export const paneGitDiffHost: HostPluginModule = {
  activate(ctx) {
    ctx.rpc.handle<{ cwd: string; filePath?: string }, GitDiffSnapshot>(
      'pane-git-diff:snapshot',
      async ({ cwd, filePath }) => {
        const diffBase = ctx.config.getKey('gitDiffBase') === 'head' ? 'head' : 'working';
        return runGitDiffSnapshot(cwd, diffBase, filePath);
      }
    );
  },
};

export const paneGitDiffHostPackage: BuiltinPluginPackage = {
  manifest: paneGitDiffManifest,
  host: paneGitDiffHost,
};
