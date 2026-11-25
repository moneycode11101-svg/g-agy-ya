import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { QuestionPrompt } from '../../shared/types';

export interface QuestionPromptCardProps {
  prompt: QuestionPrompt;
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}

export const QuestionPromptCard: React.FC<QuestionPromptCardProps> = ({
  prompt,
  onSubmit,
  onCancel,
}) => {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});

  const toggleOption = (qId: string, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qId] || [];
      if (multi) {
        return {
          ...prev,
          [qId]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label],
        };
      }
      return { ...prev, [qId]: [label] };
    });
  };

  const handleConfirm = () => {
    const out: Record<string, string | string[]> = {};
    for (const q of prompt.questions) {
      const picks = selected[q.id] || [];
      const free = (customText[q.id] || '').trim();
      if (q.multiSelect) {
        const merged = free ? [...picks, free] : picks;
        out[q.id] = merged;
      } else {
        out[q.id] = free || picks[0] || '';
      }
    }
    onSubmit(out);
  };

  return (
    <div
      className="rounded-2xl border px-4 py-3 text-xs space-y-3"
      style={{
        background: 'var(--card)',
        borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--fg)' }}>
        <HelpCircle size={15} style={{ color: 'var(--accent)' }} />
        <span>에이전트 질문 응답</span>
      </div>

      <div className="space-y-3">
        {prompt.questions.map((q) => {
          const picks = selected[q.id] || [];
          return (
            <div key={q.id} className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                {q.header && (
                  <span
                    className="px-1.5 py-0.5 rounded-md text-[10.5px] font-medium"
                    style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                  >
                    {q.header}
                  </span>
                )}
                <span className="font-medium text-[12.5px]" style={{ color: 'var(--fg)' }}>
                  {q.question}
                </span>
              </div>

              {q.options && q.options.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((opt) => {
                    const active = picks.includes(opt.label);
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => toggleOption(q.id, opt.label, Boolean(q.multiSelect))}
                        className="text-left px-2.5 py-1.5 rounded-xl border text-[11.5px] cursor-pointer transition-colors"
                        style={{
                          background: active
                            ? 'color-mix(in srgb, var(--accent) 14%, var(--card))'
                            : 'var(--surface)',
                          borderColor: active ? 'var(--accent)' : 'var(--border)',
                          color: 'var(--fg)',
                        }}
                      >
                        <div className="font-medium">{opt.label}</div>
                        {opt.description && opt.description !== opt.label && (
                          <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
                            {opt.description}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              <input
                type={q.isSecret ? 'password' : 'text'}
                value={customText[q.id] || ''}
                onChange={(e) => setCustomText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                placeholder={
                  q.options && q.options.length > 0 ? '직접 입력 (선택 사항)…' : '답변을 입력하세요…'
                }
                className="w-full px-3 py-1.5 rounded-lg border text-xs outline-none"
                style={{ background: 'var(--bg)', borderColor: 'var(--border-strong)', color: 'var(--fg)' }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={handleConfirm}
          className="px-3 py-1.5 rounded-lg text-[11.5px] font-medium cursor-pointer"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          응답 전송
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1.5 rounded-lg text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
          style={{ color: 'var(--muted)' }}
        >
          취소
        </button>
      </div>
    </div>
  );
};
