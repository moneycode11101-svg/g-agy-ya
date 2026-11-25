import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  FileText,
  Loader2,
  MinusCircle,
  Paperclip,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { ChatBlock, ChatMessage, ChatStepItem, ToolCallItem } from '../../shared/types';
import { fmtAgo } from '../../utils/formatKo';
import { renderSanitizedMarkdown } from './sanitizeMarkdown';

function formatElapsedKo(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}분 ${rem}초` : `${min}분`;
}

function getToolPresentation(tool: ToolCallItem): {
  Icon: React.FC<{ size?: number; className?: string; style?: React.CSSProperties }>;
  verb: string;
  runningVerb: string;
} {
  const n = (tool.name || '').toLowerCase();
  const k = (tool.kind || '').toLowerCase();
  if (k === 'execute' || n.includes('command') || n.includes('shell') || n.includes('terminal')) {
    return { Icon: Terminal, verb: '실행', runningVerb: '실행 중' };
  }
  if (k === 'read' || n.includes('read') || n.includes('view') || n.includes('list')) {
    return { Icon: FileText, verb: '읽기', runningVerb: '읽는 중' };
  }
  if (k === 'edit' || n.includes('edit') || n.includes('write') || n.includes('replace')) {
    return { Icon: Pencil, verb: '편집', runningVerb: '편집 중' };
  }
  if (k === 'search' || n.includes('search') || n.includes('grep') || n.includes('find')) {
    return { Icon: Search, verb: '검색', runningVerb: '검색 중' };
  }
  return { Icon: Wrench, verb: '도구', runningVerb: '실행 중' };
}

function normalizeMessageBlocks(message: ChatMessage): ChatBlock[] {
  if (message.blocks && message.blocks.length > 0) {
    return message.blocks;
  }
  const out: ChatBlock[] = [];
  if (message.thinking) {
    out.push({
      id: `legacy-th-${message.id}`,
      type: 'thinking',
      text: message.thinking,
      startedAt: message.createdAt,
      endedAt: message.endedAt ?? message.createdAt,
    });
  }
  if (message.tools && message.tools.length > 0) {
    for (const tool of message.tools) {
      out.push({ id: `legacy-tb-${tool.id}`, type: 'tool', tool });
    }
  }
  if (message.text) {
    out.push({ id: `legacy-tx-${message.id}`, type: 'text', text: message.text });
  }
  return out;
}

const ThinkingBlockView: React.FC<{
  block: Extract<ChatBlock, { type: 'thinking' }>;
  isTurnStreaming: boolean;
  defaultOpen?: boolean;
}> = ({ block, isTurnStreaming, defaultOpen = false }) => {
  const isActive = isTurnStreaming && !block.endedAt;
  const [open, setOpen] = useState(defaultOpen);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [isActive]);

  const durMs = isActive
    ? Math.max(0, now - block.startedAt)
    : block.endedAt && block.endedAt > block.startedAt
      ? block.endedAt - block.startedAt
      : 0;

  const label = isActive
    ? durMs >= 1000
      ? `생각 중… ${formatElapsedKo(durMs)}`
      : '생각 중…'
    : durMs >= 1000
      ? `사고 과정 · ${formatElapsedKo(durMs)}`
      : '사고 과정';

  return (
    <div className="text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 py-0.5 rounded-md cursor-pointer transition-opacity opacity-80 hover:opacity-100 select-none"
        style={{ color: 'var(--muted)' }}
      >
        {isActive ? (
          <Loader2 size={12} className="animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
        ) : (
          <Sparkles size={12} className="shrink-0 opacity-75" />
        )}
        <span className={isActive ? 'font-medium' : undefined}>{label}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && block.text && (
        <div
          className="mt-1.5 pl-3 py-1 border-l-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed max-h-56 overflow-y-auto scroll-thin"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        >
          {block.text.trim()}
        </div>
      )}
    </div>
  );
};

const ToolBlockRow: React.FC<{ tool: ToolCallItem; defaultOpen?: boolean }> = ({
  tool,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  const { Icon, verb, runningVerb } = getToolPresentation(tool);
  const running = tool.status === 'running';
  const hasError = tool.status === 'error';
  const hasOutput = Boolean(tool.outputPreview && tool.outputPreview.trim());
  const summary = tool.argsSummary || tool.title || tool.name;

  return (
    <div className="text-[12.5px]">
      <button
        type="button"
        onClick={() => {
          if (hasOutput) setOpen((v) => !v);
        }}
        className={`w-full text-left flex items-center gap-2 py-0.5 rounded-md transition-colors ${
          hasOutput ? 'cursor-pointer hover:bg-[var(--surface)] px-1.5 -mx-1.5' : 'cursor-default'
        }`}
        style={{ color: hasError ? 'var(--danger)' : 'var(--fg-soft)' }}
      >
        <span className="shrink-0 flex items-center" style={{ color: 'var(--muted)' }}>
          {running ? (
            <Loader2 size={12} className="animate-spin" style={{ color: 'var(--accent)' }} />
          ) : hasError ? (
            <AlertTriangle size={12} style={{ color: 'var(--danger)' }} />
          ) : (
            <Icon size={12} />
          )}
        </span>
        <span className="text-[11.5px] font-medium shrink-0" style={{ color: 'var(--muted)' }}>
          {running ? runningVerb : verb}
        </span>
        <span className="truncate font-mono text-[11.5px] min-w-0 flex-1">{summary}</span>
        {tool.name && summary !== tool.name && (
          <span
            className="text-[10px] font-mono px-1.5 py-[1px] rounded shrink-0 hidden sm:inline"
            style={{ background: 'var(--surface)', color: 'var(--muted)' }}
          >
            {tool.name}
          </span>
        )}
        {hasOutput && (
          <span className="shrink-0" style={{ color: 'var(--muted)' }}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {open && hasOutput && (
        <pre
          className="mt-1 ml-4 p-2.5 rounded-xl border text-[11px] font-mono overflow-x-auto max-h-40 whitespace-pre-wrap break-words scroll-thin"
          style={{
            background: 'var(--sidebar)',
            borderColor: 'var(--border)',
            color: hasError ? 'var(--danger)' : 'var(--muted)',
          }}
        >
          {tool.outputPreview}
        </pre>
      )}
    </div>
  );
};

const StepsChecklistView: React.FC<{ items: ChatStepItem[] }> = ({ items }) => {
  const doneCount = items.filter((i) => i.status === 'done').length;
  return (
    <div
      className="rounded-xl border px-3 py-2.5 space-y-1.5"
      style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center justify-between text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
        <span>진행 단계</span>
        <span className="tabular-nums">
          {doneCount} / {items.length} 완료
        </span>
      </div>
      <div className="space-y-1">
        {items.map((item, idx) => (
          <div key={`${item.title}-${idx}`} className="flex items-center gap-2 text-[12px]">
            {item.status === 'done' ? (
              <CheckCircle2 size={13} className="shrink-0" style={{ color: '#22c55e' }} />
            ) : item.status === 'in_progress' ? (
              <Loader2 size={13} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
            ) : item.status === 'failed' ? (
              <XCircle size={13} className="shrink-0" style={{ color: 'var(--danger)' }} />
            ) : item.status === 'skipped' ? (
              <MinusCircle size={13} className="shrink-0" style={{ color: 'var(--muted)' }} />
            ) : (
              <Circle size={13} className="shrink-0 opacity-45" style={{ color: 'var(--muted)' }} />
            )}
            <span
              className={item.status === 'done' ? 'line-through opacity-65' : undefined}
              style={{ color: item.status === 'in_progress' ? 'var(--fg)' : 'var(--fg-soft)' }}
            >
              {item.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export interface AssistantTurnViewProps {
  message: ChatMessage;
  transcriptView: 'normal' | 'thinking' | 'detailed';
}

export const AssistantTurnView: React.FC<AssistantTurnViewProps> = ({
  message,
  transcriptView,
}) => {
  const blocks = useMemo(() => normalizeMessageBlocks(message), [message]);
  const [workExpanded, setWorkExpanded] = useState(transcriptView !== 'normal');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setWorkExpanded(transcriptView !== 'normal');
  }, [transcriptView]);

  useEffect(() => {
    if (!message.streaming) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [message.streaming]);

  // Separate trailing final answer text from preceding work steps (just like vanilla Antigravity)
  const { workBlocks, finalTextBlock } = useMemo(() => {
    let lastTextIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type === 'text' && b.text.trim()) {
        lastTextIdx = i;
        break;
      }
    }
    const hasWorkAfterLastText =
      lastTextIdx >= 0 && blocks.slice(lastTextIdx + 1).some((b) => b.type === 'tool' || b.type === 'thinking');

    if (lastTextIdx >= 0 && !hasWorkAfterLastText) {
      return {
        workBlocks: blocks.slice(0, lastTextIdx),
        finalTextBlock: blocks[lastTextIdx] as Extract<ChatBlock, { type: 'text' }>,
      };
    }
    return {
      workBlocks: blocks,
      finalTextBlock: null,
    };
  }, [blocks]);

  const finalHtml = useMemo(
    () => (finalTextBlock ? renderSanitizedMarkdown(finalTextBlock.text) : ''),
    [finalTextBlock]
  );

  const toolCount = useMemo(
    () => workBlocks.filter((b) => b.type === 'tool').length,
    [workBlocks]
  );
  const hasThinking = useMemo(
    () => workBlocks.some((b) => b.type === 'thinking'),
    [workBlocks]
  );
  const elapsedMs = message.streaming
    ? Math.max(0, now - message.createdAt)
    : message.endedAt && message.endedAt > message.createdAt
      ? message.endedAt - message.createdAt
      : 0;

  if (!message.streaming && workBlocks.length === 0 && !finalTextBlock) {
    return null;
  }

  const workSummaryLabel = (() => {
    const durPart = elapsedMs >= 1000 ? ` · ${formatElapsedKo(elapsedMs)}` : '';
    if (toolCount > 0) {
      return `작업 과정${durPart} · 도구 ${toolCount}개`;
    }
    if (hasThinking) {
      return `사고 과정${durPart}`;
    }
    return `진행 과정${durPart}`;
  })();

  const handleCopy = () => {
    const copyText = finalTextBlock?.text || message.text;
    if (!copyText) return;
    void navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const renderBlockItem = (block: ChatBlock, idx: number, isStreaming: boolean) => {
    if (block.type === 'thinking') {
      return (
        <ThinkingBlockView
          key={block.id || idx}
          block={block}
          isTurnStreaming={isStreaming}
          defaultOpen={transcriptView === 'thinking' || transcriptView === 'detailed'}
        />
      );
    }
    if (block.type === 'tool') {
      return (
        <ToolBlockRow
          key={block.id || idx}
          tool={block.tool}
          defaultOpen={transcriptView === 'detailed'}
        />
      );
    }
    if (block.type === 'steps') {
      return <StepsChecklistView key={block.id || idx} items={block.items} />;
    }
    if (block.type === 'plan') {
      return (
        <div
          key={block.id || idx}
          className="rounded-xl border px-3.5 py-2.5 space-y-1.5"
          style={{
            background: 'color-mix(in srgb, var(--accent) 5%, var(--card))',
            borderColor: 'color-mix(in srgb, var(--accent) 30%, var(--border))',
          }}
        >
          <div className="text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
            제안된 구현 계획
          </div>
          <div
            className="md-prose text-[12.5px] leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderSanitizedMarkdown(block.text) }}
          />
        </div>
      );
    }
    // Intermediate progress text between tool steps (styled quieter than final response, just like vanilla Antigravity)
    return (
      <div
        key={block.id || idx}
        className="md-prose text-[13px] leading-relaxed opacity-85"
        style={{ color: 'var(--fg-soft)' }}
        dangerouslySetInnerHTML={{ __html: renderSanitizedMarkdown(block.text) }}
      />
    );
  };

  return (
    <div className="space-y-2 group/assistant-turn">
      {/* 1. 스트리밍 중: 실시간 작업 타임라인 + 포커스 표시 */}
      {message.streaming ? (
        <div className="space-y-2">
          {workBlocks.length > 0 && (
            <div className="space-y-1.5 pl-0.5">
              {workBlocks.map((b, i) => renderBlockItem(b, i, true))}
            </div>
          )}

          {(!finalTextBlock || message.focus) && (
            <div
              className="inline-flex items-center gap-2 text-[12.5px] select-none"
              style={{ color: 'var(--muted)' }}
            >
              <Loader2 size={13} className="animate-spin shrink-0" style={{ color: 'var(--accent)' }} />
              <span>{message.focus || (workBlocks.length > 0 ? '작업 진행 중…' : '생각 중…')}</span>
              {elapsedMs >= 1000 && (
                <span className="tabular-nums opacity-75">{formatElapsedKo(elapsedMs)}</span>
              )}
            </div>
          )}
        </div>
      ) : (
        /* 2. 완료된 턴: 순정 Antigravity처럼 작업 과정을 깔끔하게 접고 펼침 */
        workBlocks.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setWorkExpanded((v) => !v)}
              className="inline-flex items-center gap-1.5 py-1 px-2 -ml-2 rounded-lg text-[12.5px] cursor-pointer transition-colors hover:bg-[var(--surface)] select-none"
              style={{ color: 'var(--muted)' }}
            >
              {workExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>{workSummaryLabel}</span>
            </button>
            {workExpanded && (
              <div
                className="mt-1.5 pl-3 border-l-2 space-y-2"
                style={{ borderColor: 'var(--border)' }}
              >
                {workBlocks.map((b, i) => renderBlockItem(b, i, false))}
              </div>
            )}
          </div>
        )
      )}

      {/* 3. 최종 응답 마크다운 */}
      {finalTextBlock && (
        <div
          className="md-prose break-words"
          dangerouslySetInnerHTML={{ __html: finalHtml }}
        />
      )}

      {/* 4. 완료된 응답 하단 액션 바 (복사 · 타임스탬프 · 소요 시간) */}
      {!message.streaming && (finalTextBlock || message.text) && (
        <div
          className="pt-0.5 flex items-center gap-2.5 text-[11px] select-none"
          style={{ color: 'var(--muted)' }}
        >
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 -ml-1.5 rounded-md hover:bg-[var(--surface)] cursor-pointer transition-opacity opacity-70 hover:opacity-100"
            title="응답 복사"
          >
            {copied ? <Check size={11} style={{ color: '#22c55e' }} /> : <Copy size={11} />}
            <span>{copied ? '복사됨' : '복사'}</span>
          </button>
          {message.createdAt > 0 && <span>{fmtAgo(message.createdAt)}</span>}
          {elapsedMs >= 1000 && (
            <span className="tabular-nums opacity-75">· {formatElapsedKo(elapsedMs)}</span>
          )}
        </div>
      )}
    </div>
  );
};

export const QueuedUserBubble: React.FC<{
  prompt: string;
  images?: string[];
  onCancel: () => void;
}> = ({ prompt, images, onCancel }) => (
  <div className="flex justify-end items-center gap-1.5 group/queued-msg">
    <button
      type="button"
      onClick={onCancel}
      className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer text-[11px] opacity-55 hover:opacity-100 transition-opacity shrink-0"
      style={{ color: 'var(--muted)' }}
      title="대기 중인 메시지 취소"
      aria-label="대기 중인 메시지 취소"
    >
      ✕
    </button>
    <div
      className="relative max-w-[80%] rounded-[18px] border px-4 py-2.5 leading-relaxed whitespace-pre-wrap break-words overflow-hidden"
      style={{
        fontSize: 'var(--chat-font-size, 14px)',
        background: 'var(--card)',
        borderColor: 'var(--border)',
        color: 'var(--fg)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 animate-pulse"
        style={{ background: 'color-mix(in srgb, var(--fg) 5%, transparent)' }}
      />
      <div className="relative">
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {images.map((img) => (
              <span
                key={img}
                className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md border"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                <Paperclip size={10} />
                <span>{img.split('/').pop()}</span>
              </span>
            ))}
          </div>
        )}
        <div>{prompt}</div>
        <div className="mt-1 flex items-center gap-1 text-[10.5px]" style={{ color: 'var(--muted)' }}>
          <Loader2 size={9} className="animate-spin" />
          <span>대기 중</span>
        </div>
      </div>
    </div>
  </div>
);

export const UserMessageBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(message.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="flex justify-end items-center gap-1.5 group/user-msg">
      <button
        type="button"
        onClick={handleCopy}
        className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer opacity-0 group-hover/user-msg:opacity-80 hover:!opacity-100 transition-opacity shrink-0"
        style={{ color: 'var(--muted)' }}
        title="메시지 복사"
      >
        {copied ? <Check size={12} style={{ color: '#22c55e' }} /> : <Copy size={12} />}
      </button>
      <div
        className="max-w-[80%] rounded-[18px] border px-4 py-2.5 leading-relaxed whitespace-pre-wrap break-words"
        style={{
          fontSize: 'var(--chat-font-size, 14px)',
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          color: 'var(--fg)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {message.images.map((img) => (
              <span
                key={img}
                className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md border"
                style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                <Paperclip size={10} />
                <span>{img.split('/').pop()}</span>
              </span>
            ))}
          </div>
        )}
        {message.text}
      </div>
    </div>
  );
};
