import React, { useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import type { ConfigFieldSchema, SettingsSearchEntry } from '../shared/types';

export interface SchemaSettingsFormProps {
  schema: readonly ConfigFieldSchema[];
  values: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  onPickDirectory?: () => Promise<string | null>;
  compact?: boolean;
}

/**
 * Extracts normalized search entries from declarative `ConfigFieldSchema[]`
 * so SettingsModal global search (⌘F) indexes every active plugin automatically
 * and removes entries immediately when a plugin is toggled OFF (critic #12-3).
 */
export function extractSchemaSearchEntries(
  pluginId: string,
  sectionId: string,
  schema: readonly ConfigFieldSchema[]
): SettingsSearchEntry[] {
  return schema.map((f) => ({
    id: `${pluginId}:${f.key}`,
    sectionId,
    pluginId,
    title: f.label,
    description: f.description,
    keywords: [f.label, f.description || '', f.key, f.group || '', ...(f.keywords || [])]
      .join(' ')
      .toLowerCase(),
  }));
}

const ToggleSwitch: React.FC<{ checked: boolean; onChange: (next: boolean) => void }> = ({ checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors cursor-pointer"
    style={{ background: checked ? 'var(--accent)' : 'color-mix(in srgb, var(--fg) 18%, transparent)' }}
  >
    <span
      className="inline-block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform"
      style={{ transform: checked ? 'translateX(19px)' : 'translateX(3px)' }}
    />
  </button>
);

const StringListEditor: React.FC<{
  items: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}> = ({ items, placeholder, onChange }) => {
  const [draft, setDraft] = useState('');
  const addItem = () => {
    const trimmed = draft.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onChange([...items, trimmed]);
    setDraft('');
  };
  return (
    <div className="space-y-1.5 w-full max-w-[260px]">
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addItem();
            }
          }}
          placeholder={placeholder || '항목 추가...'}
          className="flex-1 min-w-0 px-2.5 py-1 rounded-lg border text-[12px] outline-none"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        />
        <button
          type="button"
          onClick={addItem}
          className="p-1.5 rounded-lg border cursor-pointer hover:bg-[var(--surface)]"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
          title="추가"
        >
          <Plus size={12} />
        </button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono border"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            >
              <span className="truncate max-w-[180px]">{item}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((x) => x !== item))}
                className="cursor-pointer opacity-60 hover:opacity-100"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Reusable declarative settings form matching agy-desk's Apple/Antigravity card styling.
 * Used in both Plugin Studio's right-hand inspector and dynamic SettingsModal sections.
 */
export const SchemaSettingsForm: React.FC<SchemaSettingsFormProps> = ({
  schema,
  values,
  onChange,
  onPickDirectory,
  compact = false,
}) => {
  if (!schema || schema.length === 0) {
    return (
      <div className="text-[12px] py-3 text-center" style={{ color: 'var(--muted)' }}>
        이 플러그인은 추가 설정 항목이 없습니다.
      </div>
    );
  }

  // Group fields while preserving declaration order
  const groups = new Map<string, ConfigFieldSchema[]>();
  for (const field of schema) {
    const g = field.group || '기본 설정';
    const list = groups.get(g) || [];
    list.push(field);
    groups.set(g, list);
  }

  const renderControl = (field: ConfigFieldSchema) => {
    const current = values[field.key] !== undefined ? values[field.key] : field.defaultValue;
    const widget = field.widget || (field.type === 'segmented' ? 'segmented' : undefined);

    if (field.type === 'boolean' || widget === 'toggle') {
      return (
        <ToggleSwitch
          checked={Boolean(current)}
          onChange={(next) => onChange({ [field.key]: next })}
        />
      );
    }

    if (field.type === 'segmented' || widget === 'segmented' || (field.type === 'enum' && (field.options?.length || 0) <= 3 && !widget)) {
      const opts = field.options || [];
      return (
        <div
          className="inline-flex items-center rounded-full p-0.5 border text-[11.5px]"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          {opts.map((opt) => {
            const active = String(current) === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ [field.key]: opt.value })}
                className="px-2.5 py-0.5 rounded-full cursor-pointer transition-all"
                style={{
                  background: active ? 'var(--card)' : 'transparent',
                  color: active ? 'var(--fg)' : 'var(--muted)',
                  fontWeight: active ? 600 : 400,
                  boxShadow: active ? 'var(--shadow-sm)' : undefined,
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      );
    }

    if (field.type === 'enum' || widget === 'select') {
      const opts = field.options || [];
      return (
        <select
          value={String(current ?? '')}
          onChange={(e) => onChange({ [field.key]: e.target.value })}
          className="px-2.5 py-1 rounded-xl border text-[12px] font-medium cursor-pointer outline-none"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        >
          {opts.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    if (field.type === 'number') {
      const numVal = typeof current === 'number' ? current : Number(field.defaultValue || 0);
      const hasRange = typeof field.min === 'number' && typeof field.max === 'number';
      if (hasRange || widget === 'slider') {
        return (
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={field.min ?? 0}
              max={field.max ?? 100}
              step={field.step ?? 1}
              value={numVal}
              onChange={(e) => onChange({ [field.key]: Number(e.target.value) })}
              className="w-24 accent-[var(--accent)] cursor-pointer"
            />
            <span className="num text-[12px] font-mono w-10 text-right" style={{ color: 'var(--fg-soft)' }}>
              {numVal}
            </span>
          </div>
        );
      }
      return (
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={numVal}
          onChange={(e) => onChange({ [field.key]: Number(e.target.value) })}
          className="w-20 px-2.5 py-1 rounded-lg border text-[12px] text-right outline-none num"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        />
      );
    }

    if (field.type === 'color' || widget === 'color') {
      const hex = String(current || '#3b82f6');
      return (
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#3b82f6'}
            onChange={(e) => onChange({ [field.key]: e.target.value })}
            className="w-6 h-6 rounded border cursor-pointer bg-transparent"
            style={{ borderColor: 'var(--border)' }}
          />
          <input
            type="text"
            value={hex}
            onChange={(e) => onChange({ [field.key]: e.target.value })}
            className="w-20 px-2 py-1 rounded-lg border text-[11.5px] font-mono outline-none"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          />
        </div>
      );
    }

    if (field.type === 'path' || widget === 'directory') {
      const val = String(current || '');
      return (
        <div className="flex items-center gap-1.5 max-w-[230px]">
          <input
            type="text"
            value={val}
            onChange={(e) => onChange({ [field.key]: e.target.value })}
            placeholder={field.placeholder || '/path/to/dir'}
            className="flex-1 min-w-0 px-2.5 py-1 rounded-lg border text-[11.5px] font-mono outline-none"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          />
          {onPickDirectory && (
            <button
              type="button"
              onClick={async () => {
                const picked = await onPickDirectory();
                if (picked) onChange({ [field.key]: picked });
              }}
              className="p-1.5 rounded-lg border cursor-pointer hover:bg-[var(--surface)]"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
              title="폴더 선택"
            >
              <FolderOpen size={12} />
            </button>
          )}
        </div>
      );
    }

    if (field.type === 'string-list' || widget === 'tags') {
      const list = Array.isArray(current) ? current.map(String) : [];
      return (
        <StringListEditor
          items={list}
          placeholder={field.placeholder}
          onChange={(next) => onChange({ [field.key]: next })}
        />
      );
    }

    return (
      <input
        type="text"
        value={String(current ?? '')}
        placeholder={field.placeholder}
        onChange={(e) => onChange({ [field.key]: e.target.value })}
        className="w-44 px-2.5 py-1 rounded-lg border text-[12px] outline-none"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
      />
    );
  };

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      {Array.from(groups.entries()).map(([groupName, fields]) => (
        <div key={groupName} className="space-y-1.5">
          {groups.size > 1 && (
            <div className="text-[11.5px] font-semibold px-0.5" style={{ color: 'var(--muted)' }}>
              {groupName}
            </div>
          )}
          <div
            className="rounded-xl border divide-y overflow-hidden"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            {fields.map((field) => (
              <div
                key={field.key}
                className={`${compact ? 'px-3 py-2.5' : 'px-4 py-3'} flex items-center justify-between gap-3`}
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
                    {field.label}
                  </div>
                  {field.description && (
                    <div className="text-[11.5px] mt-0.5 leading-snug break-keep" style={{ color: 'var(--muted)' }}>
                      {field.description}
                    </div>
                  )}
                </div>
                <div className="shrink-0">{renderControl(field)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
