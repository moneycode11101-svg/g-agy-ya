import React from 'react';
import { Power, Trash2 } from 'lucide-react';
import type { PaneTabRecord } from '../shared/types';
import { getDeskKernelBridge } from './sharedRuntime';
import { useSlotRegistry } from './slotRegistry';

/**
 * Lossless Tombstone placeholder rendered whenever a tab's `paneType` belongs to a
 * currently disabled or uninstalled plugin (critic #12-5).
 * Preserves 100% of `tab.state` untouched until the user re-enables the plugin or closes the tab.
 */
export const DormantPanePlaceholder: React.FC<{
  groupId: string;
  tab: PaneTabRecord;
  onCloseTab: () => void;
}> = ({ tab, onCloseTab }) => {
  const handleEnable = async () => {
    await getDeskKernelBridge()?.introspection.sendCommand({
      type: 'plugin:toggle',
      pluginId: tab.ownerPluginId,
      enabled: true,
    });
  };

  const previewKeys = Object.entries(tab.state || {})
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .slice(0, 3);

  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center p-6"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <div
        className="w-full max-w-[380px] rounded-2xl border p-5 space-y-3.5 text-center"
        style={{ background: 'var(--card)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)' }}
      >
        <div
          className="mx-auto w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--surface)', color: 'var(--muted)' }}
        >
          <Power size={18} />
        </div>
        <div className="space-y-1">
          <div className="text-[14px] font-semibold">플러그인이 비활성화됨</div>
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            이 탭(<span className="font-mono">{tab.paneType}</span>)을 제공하는{' '}
            <span className="font-mono font-medium" style={{ color: 'var(--fg-soft)' }}>
              {tab.ownerPluginId}
            </span>{' '}
            플러그인이 꺼져 있습니다. 탭 데이터는 안전하게 보존되어 있습니다.
          </div>
        </div>

        {previewKeys.length > 0 && (
          <div
            className="rounded-xl border px-3 py-2 text-left text-[11px] font-mono space-y-1"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            {previewKeys.map(([k, v]) => (
              <div key={k} className="truncate">
                <span style={{ color: 'var(--fg-soft)' }}>{k}:</span> {String(v)}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => void handleEnable()}
            className="px-3.5 py-1.5 rounded-xl text-[12.5px] font-medium cursor-pointer transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            플러그인 다시 켜기
          </button>
          <button
            type="button"
            onClick={onCloseTab}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border text-[12.5px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            <Trash2 size={12} />
            <span>탭 닫기</span>
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Minimal Zero-Feature Core fallback pane shown only when 0 launcher/pane plugins are active (critic #12-9).
 */
export const CoreEmptyPane: React.FC<{
  onSelectPaneType: (paneType: string) => void;
}> = ({ onSelectPaneType }) => {
  const paneTypes = useSlotRegistry((s) => s.paneTypes);
  const available = Object.values(paneTypes).filter((p) => p.type !== 'launcher');

  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center p-6"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <div className="w-full max-w-[420px] space-y-4 text-center">
        <div className="space-y-1">
          <div className="text-[15px] font-semibold">Zero-Feature Core Workspace</div>
          <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
            {available.length > 0
              ? '활성화된 패인 플러그인 중 하나를 선택해 열 수 있습니다.'
              : '활성화된 패인 플러그인이 없습니다. Safe Mode 또는 설정 파일에서 플러그인을 활성화하세요.'}
          </div>
        </div>
        {available.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {available.map((def) => {
              const Icon = def.icon;
              return (
                <button
                  key={def.type}
                  type="button"
                  onClick={() => onSelectPaneType(def.type)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border text-[12.5px] font-medium cursor-pointer hover:bg-[var(--surface)]"
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                >
                  <Icon size={14} />
                  <span>{def.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
