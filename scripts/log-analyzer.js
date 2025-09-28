#!/usr/bin/env node

/**
 * 音声通話アプリのログ分析・視覚化ツール
 * 
 * 使用方法:
 *   node scripts/log-analyzer.js <ログファイル> [オプション]
 * 
 * オプション:
 *   --session-id <id>    特定のセッションIDをフィルタ
 *   --turn-id <id>       特定のターンIDをフィルタ
 *   --output <format>    出力形式 (json, table, chart)
 *   --time-range <range> 時間範囲 (例: "2024-01-01T00:00:00,2024-01-01T23:59:59")
 */

const fs = require('fs');
const path = require('path');

// コマンドライン引数の解析
const args = process.argv.slice(2);
const logFile = args[0];
const options = parseOptions(args.slice(1));

if (!logFile) {
  console.error('使用方法: node scripts/log-analyzer.js <ログファイル> [オプション]');
  process.exit(1);
}

if (!fs.existsSync(logFile)) {
  console.error(`ログファイルが見つかりません: ${logFile}`);
  process.exit(1);
}

/**
 * コマンドラインオプションを解析
 */
function parseOptions(args) {
  const options = {
    sessionId: null,
    turnId: null,
    output: 'table',
    timeRange: null,
  };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    switch (key) {
      case '--session-id':
        options.sessionId = value;
        break;
      case '--turn-id':
        options.turnId = parseInt(value, 10);
        break;
      case '--output':
        options.output = value;
        break;
      case '--time-range':
        options.timeRange = value.split(',').map(t => new Date(t.trim()));
        break;
    }
  }

  return options;
}

/**
 * ログファイルを解析
 */
function analyzeLogs(logFile) {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n');
  
  const analysis = {
    sessions: new Map(),
    metrics: {
      totalLines: lines.length,
      errorLines: 0,
      warningLines: 0,
      debugLines: 0,
      geminiPayloads: 0,
      transcriptShort: 0,
      segmentFallbacks: 0,
      audioExtractionAttempts: 0,
      audioExtractionSuccesses: 0,
      audioExtractionFailures: 0,
    },
    timeline: [],
    issues: [],
  };

  lines.forEach((line, index) => {
    if (!line.trim()) return;

    try {
      const parsed = parseLogLine(line);
      if (!parsed) return;

      // メトリクス更新
      updateMetrics(analysis.metrics, parsed);

      // セッション分析
      if (parsed.sessionId) {
        analyzeSession(analysis.sessions, parsed);
      }

      // タイムライン追加
      if (parsed.timestamp) {
        analysis.timeline.push({
          timestamp: parsed.timestamp,
          type: parsed.type,
          sessionId: parsed.sessionId,
          turnId: parsed.turnId,
          message: parsed.message,
          data: parsed.data,
        });
      }

      // 問題検出
      detectIssues(analysis.issues, parsed);

    } catch (error) {
      console.warn(`行 ${index + 1} の解析に失敗: ${error.message}`);
    }
  });

  return analysis;
}

/**
 * ログ行を解析
 */
function parseLogLine(line) {
  // JSONログの解析
  const jsonMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(.+)$/);
  if (jsonMatch) {
    const [, timestamp, message] = jsonMatch;
    try {
      const data = JSON.parse(message);
      return {
        timestamp: new Date(timestamp),
        type: 'json',
        message: message,
        data: data,
        sessionId: data.sessionId,
        turnId: data.turnId,
      };
    } catch (e) {
      // JSONでない場合は通常のログとして処理
      return {
        timestamp: new Date(timestamp),
        type: 'log',
        message: message,
        level: extractLogLevel(message),
      };
    }
  }

  // 通常のログ行の解析
  const logMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+\[([^\]]+)\]\s+(.+)$/);
  if (logMatch) {
    const [, timestamp, tag, message] = logMatch;
    return {
      timestamp: new Date(timestamp),
      type: 'log',
      tag: tag,
      message: message,
      level: extractLogLevel(tag),
    };
  }

  return null;
}

/**
 * ログレベルを抽出
 */
function extractLogLevel(text) {
  if (text.includes('error') || text.includes('ERROR')) return 'error';
  if (text.includes('warn') || text.includes('WARN')) return 'warning';
  if (text.includes('debug') || text.includes('DEBUG')) return 'debug';
  if (text.includes('info') || text.includes('INFO')) return 'info';
  return 'unknown';
}

/**
 * メトリクスを更新
 */
function updateMetrics(metrics, parsed) {
  if (parsed.type === 'json' && parsed.data) {
    const data = parsed.data;
    
    if (data.type === 'debug.raw_payload_analysis') {
      metrics.geminiPayloads++;
    }
    
    if (data.type === 'debug.transcript_short') {
      metrics.transcriptShort++;
    }
    
    if (data.type === 'debug.segment_fallback_detected') {
      metrics.segmentFallbacks++;
    }
    
    if (data.audioExtractionAttempts) {
      metrics.audioExtractionAttempts += data.audioExtractionAttempts;
    }
    
    if (data.audioExtractionSuccesses) {
      metrics.audioExtractionSuccesses += data.audioExtractionSuccesses;
    }
    
    if (data.audioExtractionFailures) {
      metrics.audioExtractionFailures += data.audioExtractionFailures;
    }
  }

  if (parsed.level === 'error') metrics.errorLines++;
  if (parsed.level === 'warning') metrics.warningLines++;
  if (parsed.level === 'debug') metrics.debugLines++;
}

/**
 * セッション分析
 */
function analyzeSession(sessions, parsed) {
  const sessionId = parsed.sessionId;
  if (!sessionId) return;

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      startTime: parsed.timestamp,
      endTime: parsed.timestamp,
      turns: new Map(),
      issues: [],
      metrics: {
        totalPayloads: 0,
        shortTranscripts: 0,
        segmentFallbacks: 0,
        audioExtractions: 0,
      },
    });
  }

  const session = sessions.get(sessionId);
  session.endTime = parsed.timestamp;

  // ターン分析
  if (parsed.turnId) {
    if (!session.turns.has(parsed.turnId)) {
      session.turns.set(parsed.turnId, {
        turnId: parsed.turnId,
        startTime: parsed.timestamp,
        endTime: parsed.timestamp,
        transcriptLengths: [],
        issues: [],
      });
    }

    const turn = session.turns.get(parsed.turnId);
    turn.endTime = parsed.timestamp;

    // transcript長の追跡
    if (parsed.data?.transcriptLength) {
      turn.transcriptLengths.push({
        timestamp: parsed.timestamp,
        length: parsed.data.transcriptLength,
      });
    }
  }

  // セッションメトリクス更新
  if (parsed.data) {
    if (parsed.data.type === 'debug.transcript_short') {
      session.metrics.shortTranscripts++;
    }
    if (parsed.data.type === 'debug.segment_fallback_detected') {
      session.metrics.segmentFallbacks++;
    }
    if (parsed.data.type === 'debug.raw_payload_analysis') {
      session.metrics.totalPayloads++;
    }
  }
}

/**
 * 問題を検出
 */
function detectIssues(issues, parsed) {
  if (parsed.type === 'json' && parsed.data) {
    const data = parsed.data;

    // 短いtranscriptの問題
    if (data.type === 'debug.transcript_short') {
      issues.push({
        type: 'short_transcript',
        severity: 'warning',
        timestamp: parsed.timestamp,
        sessionId: parsed.sessionId,
        turnId: parsed.turnId,
        details: {
          transcriptLength: data.transcriptLength,
          transcriptPreview: data.transcriptPreview,
        },
      });
    }

    // segment_fallbackの問題
    if (data.type === 'debug.segment_fallback_detected') {
      issues.push({
        type: 'segment_fallback',
        severity: 'error',
        timestamp: parsed.timestamp,
        sessionId: parsed.sessionId,
        turnId: parsed.turnId,
        details: {
          zeroAudioSegments: data.zeroAudioSegments,
          audioChunkCount: data.audioChunkCount,
          audioChunkBytes: data.audioChunkBytes,
        },
      });
    }

    // 音声抽出失敗の問題
    if (data.type === 'debug.raw_payload_analysis' && 
        data.hasServerContent && 
        !data.candidatesCount) {
      issues.push({
        type: 'no_candidates',
        severity: 'warning',
        timestamp: parsed.timestamp,
        sessionId: parsed.sessionId,
        details: {
          hasServerContent: data.hasServerContent,
          candidatesCount: data.candidatesCount,
        },
      });
    }
  }
}

/**
 * 分析結果を出力
 */
function outputResults(analysis, options) {
  // フィルタリング
  let filteredAnalysis = analysis;
  if (options.sessionId || options.turnId || options.timeRange) {
    filteredAnalysis = filterAnalysis(analysis, options);
  }

  switch (options.output) {
    case 'json':
      console.log(JSON.stringify(filteredAnalysis, null, 2));
      break;
    case 'table':
      outputTable(filteredAnalysis);
      break;
    case 'chart':
      outputChart(filteredAnalysis);
      break;
    default:
      outputTable(filteredAnalysis);
  }
}

/**
 * 分析結果をフィルタリング
 */
function filterAnalysis(analysis, options) {
  const filtered = {
    ...analysis,
    sessions: new Map(),
    timeline: [],
    issues: [],
  };

  // セッションフィルタ
  for (const [sessionId, session] of analysis.sessions) {
    if (options.sessionId && sessionId !== options.sessionId) continue;
    
    const filteredSession = { ...session };
    
    // ターンフィルタ
    if (options.turnId) {
      filteredSession.turns = new Map();
      if (session.turns.has(options.turnId)) {
        filteredSession.turns.set(options.turnId, session.turns.get(options.turnId));
      }
    }
    
    filtered.sessions.set(sessionId, filteredSession);
  }

  // タイムラインとイシューのフィルタ
  filtered.timeline = analysis.timeline.filter(item => {
    if (options.sessionId && item.sessionId !== options.sessionId) return false;
    if (options.turnId && item.turnId !== options.turnId) return false;
    if (options.timeRange && 
        (item.timestamp < options.timeRange[0] || item.timestamp > options.timeRange[1])) {
      return false;
    }
    return true;
  });

  filtered.issues = analysis.issues.filter(issue => {
    if (options.sessionId && issue.sessionId !== options.sessionId) return false;
    if (options.turnId && issue.turnId !== options.turnId) return false;
    if (options.timeRange && 
        (issue.timestamp < options.timeRange[0] || issue.timestamp > options.timeRange[1])) {
      return false;
    }
    return true;
  });

  return filtered;
}

/**
 * テーブル形式で出力
 */
function outputTable(analysis) {
  console.log('\n📊 ログ分析結果');
  console.log('='.repeat(50));

  // メトリクス
  console.log('\n📈 メトリクス:');
  console.log(`  総ログ行数: ${analysis.metrics.totalLines}`);
  console.log(`  エラー: ${analysis.metrics.errorLines}`);
  console.log(`  警告: ${analysis.metrics.warningLines}`);
  console.log(`  デバッグ: ${analysis.metrics.debugLines}`);
  console.log(`  Geminiペイロード: ${analysis.metrics.geminiPayloads}`);
  console.log(`  短いtranscript: ${analysis.metrics.transcriptShort}`);
  console.log(`  segment_fallback: ${analysis.metrics.segmentFallbacks}`);
  
  const audioSuccessRate = analysis.metrics.audioExtractionAttempts > 0 
    ? (analysis.metrics.audioExtractionSuccesses / analysis.metrics.audioExtractionAttempts * 100).toFixed(1)
    : '0';
  console.log(`  音声抽出成功率: ${audioSuccessRate}%`);

  // セッション一覧
  console.log('\n🔍 セッション分析:');
  for (const [sessionId, session] of analysis.sessions) {
    const duration = Math.round((session.endTime - session.startTime) / 1000);
    console.log(`  セッション ${sessionId}:`);
    console.log(`    期間: ${duration}秒`);
    console.log(`    ターン数: ${session.turns.size}`);
    console.log(`    ペイロード数: ${session.metrics.totalPayloads}`);
    console.log(`    短いtranscript: ${session.metrics.shortTranscripts}`);
    console.log(`    segment_fallback: ${session.metrics.segmentFallbacks}`);
  }

  // 問題一覧
  if (analysis.issues.length > 0) {
    console.log('\n⚠️  検出された問題:');
    analysis.issues.forEach((issue, index) => {
      console.log(`  ${index + 1}. [${issue.severity.toUpperCase()}] ${issue.type}`);
      console.log(`     時間: ${issue.timestamp.toISOString()}`);
      console.log(`     セッション: ${issue.sessionId}`);
      if (issue.turnId) console.log(`     ターン: ${issue.turnId}`);
      console.log(`     詳細: ${JSON.stringify(issue.details)}`);
    });
  } else {
    console.log('\n✅ 重大な問題は検出されませんでした');
  }
}

/**
 * チャート形式で出力（簡易版）
 */
function outputChart(analysis) {
  console.log('\n📊 時系列チャート（簡易版）');
  console.log('='.repeat(50));

  // タイムラインを時系列でソート
  const sortedTimeline = analysis.timeline.sort((a, b) => a.timestamp - b.timestamp);
  
  // 5分間隔で集計
  const intervals = new Map();
  const intervalMs = 5 * 60 * 1000; // 5分

  sortedTimeline.forEach(item => {
    const intervalStart = Math.floor(item.timestamp.getTime() / intervalMs) * intervalMs;
    const key = new Date(intervalStart).toISOString();
    
    if (!intervals.has(key)) {
      intervals.set(key, {
        timestamp: new Date(intervalStart),
        payloads: 0,
        errors: 0,
        warnings: 0,
        shortTranscripts: 0,
        segmentFallbacks: 0,
      });
    }

    const interval = intervals.get(key);
    
    if (item.type === 'json' && item.data?.type === 'debug.raw_payload_analysis') {
      interval.payloads++;
    }
    if (item.level === 'error') interval.errors++;
    if (item.level === 'warning') interval.warnings++;
    if (item.data?.type === 'debug.transcript_short') interval.shortTranscripts++;
    if (item.data?.type === 'debug.segment_fallback_detected') interval.segmentFallbacks++;
  });

  // チャート出力
  const sortedIntervals = Array.from(intervals.values()).sort((a, b) => a.timestamp - b.timestamp);
  
  console.log('時間                  | ペイロード | エラー | 警告 | 短transcript | fallback');
  console.log('-'.repeat(80));
  
  sortedIntervals.forEach(interval => {
    const time = interval.timestamp.toISOString().slice(11, 19);
    console.log(
      `${time.padEnd(20)} | ${interval.payloads.toString().padStart(9)} | ${interval.errors.toString().padStart(6)} | ${interval.warnings.toString().padStart(4)} | ${interval.shortTranscripts.toString().padStart(12)} | ${interval.segmentFallbacks.toString().padStart(8)}`
    );
  });
}

// メイン実行
try {
  console.log(`🔍 ログファイルを解析中: ${logFile}`);
  const analysis = analyzeLogs(logFile);
  
  if (options.sessionId) {
    console.log(`📋 セッションIDフィルタ: ${options.sessionId}`);
  }
  if (options.turnId) {
    console.log(`📋 ターンIDフィルタ: ${options.turnId}`);
  }
  
  outputResults(analysis, options);
  
  console.log('\n✅ 分析完了');
} catch (error) {
  console.error(`❌ エラー: ${error.message}`);
  process.exit(1);
}
