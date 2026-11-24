import {
  BUILTIN_PLUGIN_IDS,
  KERNEL_API_VERSION,
  PANE_WIDGET_ANCHORS,
  type PluginManifest,
} from '../../kernel/shared/types';

export interface PaneChatConfig extends Record<string, unknown> {
  sendKey: 'enter' | 'cmd-enter';
  pendingMessageMode: 'queue' | 'immediate';
  confirmCloseRunning: boolean;
  defaultCwd: string;
  warnOnCacheReset: boolean;
  transcriptView: 'normal' | 'thinking' | 'detailed';
  chatWidth: 'narrow' | 'medium' | 'wide';
}

export const PANE_CHAT_MANIFEST: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_CHAT,
  name: '에이전트 채팅 패인',
  version: '1.0.0',
  apiVersion: `^${KERNEL_API_VERSION}`,
  description: '어댑터 중립 채팅 패인 UI, 마크다운 XSS 방어 렌더링, 대기열·캐시 보호 경고 및 컴포저 위젯 슬롯 제공',
  layer: 'app',
  category: 'pane',
  icon: 'message-square',
  impactClass: 'stateful-pane',
  defaultEnabled: true,
  entry: {
    host: 'builtin:pane-chat/host',
    client: 'builtin:pane-chat/client',
  },
  optionalRequires: [BUILTIN_PLUGIN_IDS.AGENT_AGY],
  provides: ['pane:chat', `widget-anchor:${PANE_WIDGET_ANCHORS.CHAT_ABOVE_COMPOSER}`, `widget-anchor:${PANE_WIDGET_ANCHORS.CHAT_COMPOSER_BADGE}`],
  capabilities: [],
  configSchema: [
    {
      key: 'sendKey',
      label: '메시지 보내기 키',
      description: '채팅 입력창에서 메시지를 전송할 키를 선택합니다.',
      group: '입력 · 탭 안전장치',
      type: 'segmented',
      widget: 'segmented',
      defaultValue: 'enter',
      options: [
        { value: 'enter', label: 'Enter' },
        { value: 'cmd-enter', label: 'Cmd+Enter' },
      ],
      keywords: ['메시지 보내기', '전송', '키', 'enter', 'cmd+enter', '입력'],
    },
    {
      key: 'pendingMessageMode',
      label: '응답 중 후속 메시지',
      description: '에이전트가 응답 중일 때 보낸 메시지를 대기열에 쌓거나 즉시 중단 후 보냅니다.',
      group: '입력 · 탭 안전장치',
      type: 'segmented',
      widget: 'segmented',
      defaultValue: 'queue',
      options: [
        { value: 'queue', label: '대기열에 추가' },
        { value: 'immediate', label: '즉시 보내기' },
      ],
      keywords: ['대기 중인 메시지', '후속', '대기열', '즉시 전송', '큐'],
    },
    {
      key: 'confirmCloseRunning',
      label: '실행 중인 채팅 닫기 전 확인',
      description: '응답을 생성 중인 채팅 탭을 닫을 때 중단 확인 대화상자를 표시합니다.',
      group: '입력 · 탭 안전장치',
      type: 'boolean',
      widget: 'toggle',
      defaultValue: true,
      keywords: ['실행 중인 채팅 닫기', '확인', '안전장치', 'cmd+w'],
    },
    {
      key: 'warnOnCacheReset',
      label: '모델·Effort 변경 시 캐시 초기화 경고',
      description: '진행 중인 대화(컨텍스트 5천+ 토큰)에서 모델이나 Effort를 바꿀 때 캐시 초기화를 미리 알려줍니다.',
      group: '입력 · 탭 안전장치',
      type: 'boolean',
      widget: 'toggle',
      defaultValue: true,
      keywords: ['캐시 초기화', '경고', '모델', 'effort', 'cache'],
    },
    {
      key: 'defaultCwd',
      label: '기본 작업 디렉터리',
      description: '새 채팅 탭을 열 때 기본으로 사용하는 작업 폴더입니다.',
      group: '채팅 표시 · 워크스페이스',
      type: 'path',
      widget: 'directory',
      defaultValue: '',
      placeholder: '비워두면 홈 디렉터리 사용',
      keywords: ['기본 작업 디렉터리', '폴더', '워크스페이스', '경로', 'cwd'],
    },
    {
      key: 'transcriptView',
      label: '트랜스크립트 보기 단계',
      description: '채팅에 표시할 사고 과정 및 도구 호출 세부 수준을 선택합니다.',
      group: '채팅 표시 · 워크스페이스',
      type: 'segmented',
      widget: 'segmented',
      defaultValue: 'thinking',
      options: [
        { value: 'normal', label: '일반' },
        { value: 'thinking', label: '사고 과정' },
        { value: 'detailed', label: '상세' },
      ],
      keywords: ['트랜스크립트', '사고 과정', '도구 펼침', '상세'],
    },
    {
      key: 'chatWidth',
      label: '채팅 컬럼 너비',
      description: '대화 본문과 입력창의 최대 가로 폭을 조절합니다.',
      group: '채팅 표시 · 워크스페이스',
      type: 'segmented',
      widget: 'segmented',
      defaultValue: 'narrow',
      options: [
        { value: 'narrow', label: '좁음' },
        { value: 'medium', label: '보통' },
        { value: 'wide', label: '넓음' },
      ],
      keywords: ['채팅 너비', '컬럼 폭', '좁음', '보통', '넓음', 'width'],
    },
  ],
  contributes: {
    slots: ['pane.type', 'settings.section'],
    paneTypes: [{ type: 'chat', label: '새 채팅 (agy)', icon: 'message-square' }],
    commands: [{ id: 'pane-chat:new-chat', title: '새 채팅 탭', defaultShortcut: 'Mod+N' }],
  },
};
