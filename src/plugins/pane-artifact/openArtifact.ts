import { useLayoutStore, useSlotRegistry } from '../../kernel/client';

const PREVIEWABLE_TEXT_EXT_RE =
  /\.(md|mdx|markdown|txt|json|jsonc|jsonl|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|rb|php|html?|css|scss|less|xml|svg|ya?ml|toml|ini|cfg|conf|env|sh|zsh|bash|fish|sql|graphql|gql|log|csv|tsv|diff|patch|dockerfile|gitignore|gitattributes|editorconfig|prettierrc|eslintrc)$/i;

const PREVIEWABLE_BASENAMES = new Set([
  'makefile',
  'dockerfile',
  'readme',
  'license',
  'changelog',
  'gemfile',
  'podfile',
  'procfile',
  'vagrantfile',
  'jenkinsfile',
]);

export function isArtifactPreviewablePath(filePath: string): boolean {
  const clean = filePath.trim().split(/[?#]/)[0];
  if (!clean) return false;
  if (PREVIEWABLE_TEXT_EXT_RE.test(clean)) return true;
  const base = (clean.split('/').pop() || clean).toLowerCase();
  return PREVIEWABLE_BASENAMES.has(base);
}

export function parseLineRange(raw?: string | null): { lineStart?: number; lineEnd?: number } {
  if (!raw) return {};
  const m = raw.trim().match(/^#?L?(\d+)(?:-L?(\d+))?$/i);
  if (!m) return {};
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!Number.isFinite(start) || start < 1) return {};
  return {
    lineStart: start,
    lineEnd: Number.isFinite(end) && end >= start ? end : start,
  };
}

/**
 * Opens a local Markdown/code/text file inside the right-side in-app Artifact Viewer pane.
 *
 * Smart placement behavior:
 * 1. If the exact same file is already open in any artifact tab, focus that tab (updating line focus if given).
 * 2. If another split group already hosts an artifact pane, add a new tab in that right-hand artifact group.
 * 3. Otherwise split right (`'h'`, `'after'`) from `sourceGroupId` (the chat pane) so it opens as a side panel.
 *
 * Returns `false` if the `pane-artifact` plugin is disabled so callers can fall back to OS `openPath`.
 */
export function openLocalArtifactInPane(opts: {
  filePath: string;
  sourceGroupId?: string;
  lineStart?: number;
  lineEnd?: number;
  reuseSameGroup?: boolean;
}): boolean {
  const { filePath, sourceGroupId, lineStart, lineEnd, reuseSameGroup } = opts;
  if (!filePath) return false;
  if (!useSlotRegistry.getState().paneTypes['artifact']) {
    return false;
  }

  const layout = useLayoutStore.getState();
  const normalizedTarget = filePath.trim();

  // 1) Focus existing tab if this exact file is already open
  for (const [grpId, grp] of Object.entries(layout.groups)) {
    const existing = grp.tabs.find(
      (t) => t.paneType === 'artifact' && typeof t.state?.filePath === 'string' && t.state.filePath === normalizedTarget
    );
    if (existing) {
      if (lineStart != null) {
        layout.updateTabState(grpId, existing.id, {
          lineStart,
          lineEnd: lineEnd ?? lineStart,
          focusToken: Date.now(),
        });
      }
      layout.setActiveTab(grpId, existing.id);
      layout.setFocusedGroup(grpId);
      return true;
    }
  }

  const initPayload: Record<string, unknown> = {
    filePath: normalizedTarget,
    ...(lineStart != null ? { lineStart, lineEnd: lineEnd ?? lineStart, focusToken: Date.now() } : {}),
  };

  // 2) If triggered from inside an artifact pane itself, open in the same artifact group
  if (reuseSameGroup && sourceGroupId && layout.groups[sourceGroupId]) {
    layout.addTabToGroup(sourceGroupId, 'artifact', initPayload);
    return true;
  }

  // 3) Reuse an existing right/auxiliary group that already holds an artifact tab
  for (const [grpId, grp] of Object.entries(layout.groups)) {
    if (grpId === sourceGroupId) continue;
    if (grp.tabs.some((t) => t.paneType === 'artifact')) {
      layout.addTabToGroup(grpId, 'artifact', initPayload);
      return true;
    }
  }

  // 4) Split horizontally to the right of the source chat group
  if (sourceGroupId && layout.groups[sourceGroupId]) {
    layout.splitGroup(sourceGroupId, 'h', 'artifact', initPayload, 'after');
    return true;
  }

  layout.openTab('artifact', initPayload, { split: 'h', side: 'after' });
  return true;
}
