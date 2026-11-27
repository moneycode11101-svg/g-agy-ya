import fs from 'node:fs';
import {
  analyzeTranscript,
  formatAppInlineHud,
  loadSettings,
  recordStepTiming,
  resolveTranscriptPath,
} from '../lib/analyzer.mjs';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const raw = readStdin().trim();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      process.stdout.write('{}\n');
      return;
    }
  }

  const settings = loadSettings();
  if (!settings.hudEnabled || settings.hudMode === 'off') {
    process.stdout.write('{}\n');
    return;
  }

  const transcriptPath = resolveTranscriptPath(payload.conversationId, payload.transcriptPath);
  if (!transcriptPath) {
    process.stdout.write('{}\n');
    return;
  }

  let analysis = analyzeTranscript(transcriptPath, {
    conversationId: payload.conversationId,
    settings,
  });

  if (!analysis.ok || analysis.invocations === 0) {
    process.stdout.write('{}\n');
    return;
  }

  const lastStep = analysis.timeline[analysis.timeline.length - 1];
  if (lastStep && lastStep.stepIndex != null) {
    // Record exact completion timestamp for accurate tok/s measurement
    recordStepTiming(analysis.conversationId, lastStep.stepIndex, Date.now());
    analysis = analyzeTranscript(transcriptPath, {
      conversationId: payload.conversationId,
      settings,
    });
  }

  const latestStep = analysis.timeline[analysis.timeline.length - 1];
  if (!settings.showOnEveryInvocation && latestStep && latestStep.toolCalls.length > 0) {
    process.stdout.write('{}\n');
    return;
  }

  const hudLine = formatAppInlineHud(analysis, null, {
    useTurnTools: !settings.showOnEveryInvocation,
  });
  if (!hudLine) {
    process.stdout.write('{}\n');
    return;
  }

  // Note: Antigravity hookcaller.go currently panics on metadata map entries
  // ("type mismatch: cannot convert string to message"), so emit plain systemMessage.
  const output = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: `[Token Band] ${hudLine}`,
        },
      },
    ],
  };

  process.stdout.write(JSON.stringify(output) + '\n');
}

try {
  main();
} catch {
  process.stdout.write('{}\n');
}
