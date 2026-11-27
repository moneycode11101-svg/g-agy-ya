import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeTranscript,
  computeLocalUsageRollup,
  formatAppInlineHud,
  listRecentConversations,
  loadSettings,
  resolveTranscriptPath,
  saveSettings,
} from '../lib/analyzer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://token-band/app.html';
const DEFAULT_HTML_PATH = path.join(__dirname, '..', 'ui', 'dist', 'app.html');

function buildDashboardPayload(conversationId) {
  const settings = loadSettings();
  const conversations = listRecentConversations(20);
  const targetId = conversationId || conversations[0]?.conversationId;
  const transcriptPath = resolveTranscriptPath(targetId);
  const analysis = analyzeTranscript(transcriptPath, {
    conversationId: targetId,
    settings,
  });
  const rollup = computeLocalUsageRollup(false);

  return {
    analysis,
    rollup,
    conversations,
    settings,
  };
}

function summarizeForModel(payload) {
  const { analysis, rollup } = payload;
  if (!analysis?.ok) {
    return analysis?.error || '분석할 대화 트랜스크립트가 없습니다.';
  }
  const hud = formatAppInlineHud(analysis, rollup);
  const topTools = (analysis.byTool || [])
    .slice(0, 5)
    .map((t) => `- ${t.name}: +${t.totalDelta.toLocaleString()} tok (${t.count}회, 평균 +${t.avgDelta.toLocaleString()})`)
    .join('\n');

  const speedLine =
    analysis.latest?.tokPerSec != null || analysis.cumulative?.avgTokPerSec != null
      ? `생성 속도: 최근 ${analysis.latest?.tokPerSec != null ? `${analysis.latest.tokPerSec} tok/s` : '-'} · 세션 평균 ${analysis.cumulative?.avgTokPerSec != null ? `${analysis.cumulative.avgTokPerSec} tok/s` : '-'} · 최고 ${analysis.cumulative?.peakTokPerSec != null ? `${analysis.cumulative.peakTokPerSec} tok/s` : '-'}`
      : null;

  return [
    hud,
    '',
    `대화 ID: ${analysis.conversationId}`,
    `모델: ${analysis.model} (${analysis.invocations}회 호출)`,
    ...(speedLine ? [speedLine] : []),
    topTools ? `상위 도구별 +토큰:\n${topTools}` : '도구 호출 없음',
  ].join('\n');
}

const server = new McpServer(
  {
    name: 'token-band',
    version: '1.0.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

server.registerResource(
  'token-band-app',
  APP_URI,
  {
    title: 'Token Band Dashboard',
    description: 'Interactive Token Band UI showing context, cache read/write, per-tool +token deltas, and quota.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => {
    const htmlPath = process.env.TOKEN_BAND_APP_HTML || DEFAULT_HTML_PATH;
    const html = fs.readFileSync(htmlPath, 'utf8');
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: 'text/html;profile=mcp-app',
          text: html,
        },
      ],
    };
  }
);

server.registerTool(
  'open_token_band',
  {
    title: 'Token Band',
    description:
      'Token Band 대시보드를 엽니다. 누적 컨텍스트, 캐시 읽기/쓰기, 도구별 +토큰 증분, 쿼타/일간 사용량을 실시간으로 확인합니다.',
    inputSchema: {
      conversationId: z
        .string()
        .optional()
        .describe('분석할 대화 ID (생략 시 가장 최근 활성 대화 자동 선택)'),
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Token Band' },
          { type: 'global', title: 'Token Band' },
        ],
      },
    },
  },
  async (args) => {
    const payload = buildDashboardPayload(args?.conversationId);
    return {
      content: [
        {
          type: 'text',
          text: summarizeForModel(payload),
        },
      ],
      structuredContent: payload,
    };
  }
);

server.registerTool(
  'tb_get_state',
  {
    title: 'Get Token Band State',
    description: 'Internal app-only tool to refresh live token band state.',
    inputSchema: {
      conversationId: z.string().optional(),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async (args) => {
    const payload = buildDashboardPayload(args?.conversationId);
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: payload,
    };
  }
);

server.registerTool(
  'tb_save_settings',
  {
    title: 'Save Token Band Settings',
    description: 'Internal app-only tool to save HUD and budget settings.',
    inputSchema: {
      hudEnabled: z.boolean().optional(),
      showOnEveryInvocation: z.boolean().optional(),
      dailyTokenBudget: z.number().int().positive().optional(),
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  async (args) => {
    const patch = {};
    if (typeof args?.hudEnabled === 'boolean') patch.hudEnabled = args.hudEnabled;
    if (typeof args?.showOnEveryInvocation === 'boolean') {
      patch.showOnEveryInvocation = args.showOnEveryInvocation;
    }
    if (typeof args?.dailyTokenBudget === 'number' && args.dailyTokenBudget > 0) {
      patch.dailyTokenBudget = args.dailyTokenBudget;
    }
    const updated = saveSettings(patch);
    return {
      content: [{ type: 'text', text: 'saved' }],
      structuredContent: { settings: updated },
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
