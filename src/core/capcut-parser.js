/**
 * CapCut draft_info.json 파싱/수정 모듈
 *
 * 자막 구조:
 * - 각 자막은 2줄: 영어(노란색) + 번역(흰색)
 * - content.text = "English line\n번역 라인"
 * - content.styles[0] = 영어 부분 (노란색)
 * - content.styles[1] = 번역 부분 (흰색)
 * - 타이틀은 별도 텍스트 요소 (번역만 있거나 구조가 다를 수 있음)
 */

import { logger, CATEGORIES } from './logger.js';

/**
 * draft_info.json을 파싱하여 자막 정보 추출
 * @param {object} draftInfo - 파싱된 draft_info.json 객체
 * @returns {{ subtitles: Array, title: object|null, metadata: object }}
 */
export function parseProject(draftInfo) {
  logger.info(CATEGORIES.PARSE, '프로젝트 파싱 시작', {
    version: draftInfo.new_version,
    duration: draftInfo.duration,
    trackCount: draftInfo.tracks?.length,
  });

  const texts = draftInfo.materials?.texts || [];
  const tracks = draftInfo.tracks || [];

  // 텍스트 트랙 찾기
  const textTrack = tracks.find(t => t.type === 'text');
  if (!textTrack) {
    logger.warn(CATEGORIES.PARSE, '텍스트 트랙을 찾을 수 없습니다');
    return { subtitles: [], title: null, metadata: {} };
  }

  // 세그먼트를 시간순 정렬
  const segments = [...textTrack.segments].sort(
    (a, b) => a.target_timerange.start - b.target_timerange.start
  );

  logger.info(CATEGORIES.PARSE, `텍스트 ${texts.length}개, 세그먼트 ${segments.length}개 발견`);

  // 각 세그먼트에 대응하는 텍스트 매핑
  const subtitles = [];
  let title = null;

  for (const seg of segments) {
    const text = texts.find(t => t.id === seg.material_id);
    if (!text) {
      logger.warn(CATEGORIES.PARSE, `세그먼트 material_id에 대응하는 텍스트 없음: ${seg.material_id}`);
      continue;
    }

    const parsed = parseTextContent(text);
    parsed.segmentId = seg.id;
    parsed.materialId = seg.material_id;
    parsed.timeRange = seg.target_timerange;

    // 타이틀 vs 자막 판별
    // 타이틀 특징: 영어 부분이 없거나, 시간이 전체 영상 길이에 가까움
    if (!parsed.englishLine && parsed.translationLine) {
      // 영어 없이 번역만 있으면 타이틀일 가능성 높음
      title = parsed;
      logger.info(CATEGORIES.PARSE, `타이틀 감지: "${parsed.fullText.slice(0, 50)}..."`, {
        timeRange: seg.target_timerange,
      });
    } else {
      subtitles.push(parsed);
    }
  }

  // 타이틀이 못 찾아졌으면 첫 번째 세그먼트를 타이틀로 추정하는 로직은 건너뜀
  // (실제 프로젝트에서 확인 후 조정)

  logger.info(CATEGORIES.PARSE, `파싱 완료: 타이틀 ${title ? 1 : 0}개, 자막 ${subtitles.length}개`);

  return {
    subtitles,
    title,
    metadata: {
      version: draftInfo.new_version,
      duration: draftInfo.duration,
      fps: draftInfo.fps,
    },
  };
}

/**
 * 텍스트 material에서 영어/번역 부분 분리
 * @param {object} textMaterial - materials.texts[] 항목
 */
function parseTextContent(textMaterial) {
  const contentStr = textMaterial.content || '{}';
  let content;
  try {
    content = JSON.parse(contentStr);
  } catch (e) {
    logger.error(CATEGORIES.PARSE, `content JSON 파싱 실패: ${e.message}`, {
      id: textMaterial.id,
      content: contentStr.slice(0, 200),
    });
    content = { text: '', styles: [] };
  }

  const fullText = content.text || '';
  const styles = content.styles || [];

  // 영어/번역 분리: \n + 2스타일이면 bilingual, 아니면 단일 언어 블록
  const newlineIndex = fullText.indexOf('\n');
  let englishLine = '';
  let translationLine = '';

  if (newlineIndex >= 0 && styles.length >= 2) {
    // 2줄 bilingual 구조: 영어 + 번역 (한국어/중국어/일본어 프로젝트)
    englishLine = fullText.slice(0, newlineIndex);
    translationLine = fullText.slice(newlineIndex + 1);
  } else if (isPrimarilyEnglish(fullText)) {
    // 영어 전용 자막 (리치텍스트 스타일 여러 개일 수 있음)
    englishLine = fullText;
  } else {
    // 비영어 단일 블록 — 타이틀이거나 번역 전용
    translationLine = fullText;
  }

  // words 파싱
  let words = { start_time: [], end_time: [], text: [] };
  if (textMaterial.words) {
    try {
      words = typeof textMaterial.words === 'string'
        ? JSON.parse(textMaterial.words)
        : textMaterial.words;
    } catch {
      // words 파싱 실패 시 빈 값 유지
    }
  }

  return {
    id: textMaterial.id,
    fullText,
    englishLine: englishLine.trim(),
    translationLine: translationLine.trim(),
    content,       // 파싱된 content 객체
    styles,        // content.styles 배열
    words,
    rawMaterial: textMaterial, // 원본 material (모든 필드 보존)
  };
}

/**
 * 자막의 번역 부분을 새 텍스트로 교체
 * @param {object} draftInfo - 원본 draft_info.json (깊은 복사해서 수정)
 * @param {Array} replacements - [{ materialId, newTranslation, fontConfig, styleConfig }]
 * @returns {object} 수정된 draft_info.json
 */
export function applyReplacements(draftInfo, replacements) {
  // 원본 보존을 위해 깊은 복사
  const modified = JSON.parse(JSON.stringify(draftInfo));
  const texts = modified.materials.texts;

  let successCount = 0;
  let errorCount = 0;

  for (const rep of replacements) {
    const textIdx = texts.findIndex(t => t.id === rep.materialId);
    if (textIdx === -1) {
      logger.error(CATEGORIES.CONVERT, `material을 찾을 수 없음: ${rep.materialId}`);
      errorCount++;
      continue;
    }

    try {
      const text = texts[textIdx];
      replaceTextMaterial(text, rep);
      successCount++;
      logger.info(CATEGORIES.CONVERT, `자막 교체 완료: "${rep.newTranslation.slice(0, 30)}..."`, {
        materialId: rep.materialId,
      });
    } catch (e) {
      logger.error(CATEGORIES.CONVERT, `자막 교체 실패: ${e.message}`, {
        materialId: rep.materialId,
      });
      errorCount++;
    }
  }

  // subtitle_taskinfo 업데이트 (선택적)
  updateSubtitleTaskinfo(modified, replacements);

  logger.info(CATEGORIES.CONVERT, `변환 완료: 성공 ${successCount}, 실패 ${errorCount}`);
  return modified;
}

/**
 * 개별 텍스트 material 교체
 */
function replaceTextMaterial(textMaterial, replacement) {
  const { newTranslation, fontConfig, styleConfig } = replacement;

  // content 파싱
  let content;
  try {
    content = JSON.parse(textMaterial.content);
  } catch {
    throw new Error('content JSON 파싱 실패');
  }

  const oldText = content.text || '';
  const styles = content.styles || [];
  const newlineIndex = oldText.indexOf('\n');

  let newText;
  let englishEnd; // 영어 부분 끝 인덱스

  if (newlineIndex >= 0 && styles.length >= 2) {
    // 확실한 bilingual 2줄 구조: 영어\n번역 → 영어\n새번역
    const englishPart = oldText.slice(0, newlineIndex);
    newText = englishPart + '\n' + newTranslation;
    englishEnd = englishPart.length;

    // 영어(styles[0]) + 번역(styles[1]) range 재계산
    styles[0].range = [0, englishEnd];
    styles[1].range = [englishEnd + 1, newText.length];
    if (fontConfig) applyFontToStyle(styles[1], fontConfig);
    if (styleConfig) applyStyleConfig(styles[1], styleConfig);
    content.styles = styles.slice(0, 2);

  } else if (isPrimarilyEnglish(oldText)) {
    // 영어 전용 — 영어 유지 + \n\n + 번역 추가
    newText = oldText + '\n\n' + newTranslation;
    englishEnd = oldText.length;

    // 기존 영어 스타일은 모두 유지 (range 변경 없음 — 영어 텍스트 동일)
    // 번역용 새 스타일 생성 (마지막 스타일 기반 복사)
    const baseStyle = styles[styles.length - 1] || {};
    const translationStyle = JSON.parse(JSON.stringify(baseStyle));
    translationStyle.range = [englishEnd + 2, newText.length]; // \n\n 이후
    if (fontConfig) applyFontToStyle(translationStyle, fontConfig);
    if (styleConfig) applyStyleConfig(translationStyle, styleConfig);
    content.styles = [...styles, translationStyle];

  } else {
    // 비영어 (타이틀 등) — 전체 교체
    newText = newTranslation;
    englishEnd = 0;
    if (styles.length >= 1) {
      styles[0].range = [0, newText.length];
      if (fontConfig) applyFontToStyle(styles[0], fontConfig);
      if (styleConfig) applyStyleConfig(styles[0], styleConfig);
    }
  }

  // content 업데이트
  content.text = newText;
  textMaterial.content = JSON.stringify(content);

  // top-level 폰트 필드 업데이트 (번역 부분 폰트 기준)
  if (fontConfig) {
    if (fontConfig.fontPath) textMaterial.font_path = fontConfig.fontPath;
    if (fontConfig.fontId) textMaterial.font_id = fontConfig.fontId;
    if (fontConfig.fontResourceId) textMaterial.font_resource_id = fontConfig.fontResourceId;
    if (fontConfig.fontName) textMaterial.font_name = fontConfig.fontName;
    if (fontConfig.fontTitle) textMaterial.font_title = fontConfig.fontTitle;

    // fonts 배열 업데이트
    if (textMaterial.fonts && textMaterial.fonts.length > 0) {
      const font = textMaterial.fonts[textMaterial.fonts.length - 1]; // 마지막 폰트 = 번역용
      if (fontConfig.fontPath) font.path = fontConfig.fontPath;
      if (fontConfig.fontId) {
        font.resource_id = fontConfig.fontId;
        font.effect_id = fontConfig.fontId;
      }
      if (fontConfig.fontTitle) font.title = fontConfig.fontTitle;
    }
  }

  // top-level 스타일 필드 업데이트
  if (styleConfig) {
    if (styleConfig.textColor) textMaterial.text_color = styleConfig.textColor;
    if (styleConfig.borderColor) textMaterial.border_color = styleConfig.borderColor;
    if (styleConfig.borderWidth !== undefined) textMaterial.border_width = styleConfig.borderWidth;
  }

  // words 타이밍 업데이트
  updateWordTimings(textMaterial, newTranslation, englishEnd);
}

/**
 * content.styles[]에 폰트 적용
 */
function applyFontToStyle(style, fontConfig) {
  if (!style.font) style.font = {};
  if (fontConfig.fontPath) style.font.path = fontConfig.fontPath;
  if (fontConfig.fontId) style.font.id = fontConfig.fontId;
}

/**
 * content.styles[]에 색상/크기 등 적용
 */
function applyStyleConfig(style, styleConfig) {
  if (styleConfig.fillColor && style.fill?.content?.solid) {
    style.fill.content.solid.color = styleConfig.fillColor;
  }
  if (styleConfig.strokeColor && style.strokes?.[0]?.content?.solid) {
    style.strokes[0].content.solid.color = styleConfig.strokeColor;
  }
  if (styleConfig.strokeWidth && style.strokes?.[0]) {
    style.strokes[0].width = styleConfig.strokeWidth;
  }
  if (styleConfig.fontSize) {
    style.size = styleConfig.fontSize;
  }
}

/**
 * 단어별 타이밍 재계산 (번역 부분만)
 * 원본 타이밍의 전체 시간 범위를 새 단어/글자로 비례 분배
 */
function updateWordTimings(textMaterial, newTranslation, englishEnd) {
  let words;
  try {
    words = typeof textMaterial.words === 'string'
      ? JSON.parse(textMaterial.words)
      : textMaterial.words;
  } catch {
    return; // words가 없으면 건너뜀
  }

  if (!words || !words.text || words.text.length === 0) return;

  // 원본의 전체 시간 범위
  const allStarts = words.start_time.filter((_, i) => words.text[i]?.trim());
  const allEnds = words.end_time.filter((_, i) => words.text[i]?.trim());
  if (allStarts.length === 0) return;

  const totalStart = Math.min(...allStarts);
  const totalEnd = Math.max(...allEnds);
  const totalDuration = totalEnd - totalStart;

  if (totalDuration <= 0) return;

  // 새 텍스트의 전체 내용 (영어 + 번역)
  const fullText = englishEnd > 0
    ? textMaterial.content ? JSON.parse(textMaterial.content).text : newTranslation
    : newTranslation;

  // 글자 단위로 분리 (CJK: 글자 단위, 영어/한국어: 단어 단위)
  const newWords = splitIntoWords(fullText);

  // 비례 분배
  const wordCount = newWords.filter(w => w.trim()).length;
  if (wordCount === 0) return;

  const durationPerWord = totalDuration / wordCount;
  const newStartTimes = [];
  const newEndTimes = [];
  const newTexts = [];
  let currentTime = totalStart;

  for (const word of newWords) {
    if (word === ' ' || word === '\n') {
      // 공백/줄바꿈은 시간 0짜리 엔트리
      newStartTimes.push(Math.round(currentTime));
      newEndTimes.push(Math.round(currentTime));
      newTexts.push(word);
    } else {
      newStartTimes.push(Math.round(currentTime));
      currentTime += durationPerWord;
      newEndTimes.push(Math.round(currentTime));
      newTexts.push(word);
    }
  }

  // words 업데이트
  const updatedWords = {
    start_time: newStartTimes,
    end_time: newEndTimes,
    text: newTexts,
  };
  textMaterial.words = typeof textMaterial.words === 'string'
    ? JSON.stringify(updatedWords)
    : updatedWords;
}

/**
 * 텍스트를 단어 단위로 분리
 * 영어/한국어: 공백 기준, CJK(중국어/일본어): 글자 단위
 */
function splitIntoWords(text) {
  const result = [];
  let buffer = '';
  let lastType = null; // 'cjk', 'space', 'other'

  for (const char of text) {
    const type = getCharType(char);

    if (type === 'space' || type === 'newline') {
      if (buffer) {
        result.push(buffer);
        buffer = '';
      }
      result.push(char);
      lastType = type;
    } else if (type === 'cjk') {
      if (buffer && lastType !== 'cjk') {
        result.push(buffer);
        buffer = '';
      }
      // CJK는 한 글자씩
      if (buffer && lastType === 'cjk') {
        result.push(buffer);
      }
      buffer = char;
      lastType = 'cjk';
    } else {
      // 영어/한국어 등
      if (lastType === 'cjk' && buffer) {
        result.push(buffer);
        buffer = '';
      }
      buffer += char;
      lastType = 'other';
    }
  }

  if (buffer) result.push(buffer);
  return result;
}

/**
 * 텍스트가 주로 영어(라틴 문자)인지 판별
 * 영문자+숫자+기본 구두점 비율이 50% 이상이면 영어로 판정
 */
function isPrimarilyEnglish(text) {
  if (!text) return false;
  const nonSpace = text.replace(/\s/g, '');
  if (nonSpace.length === 0) return false;
  const asciiChars = nonSpace.replace(/[^a-zA-Z0-9.,!?;:'"()\-]/g, '').length;
  return asciiChars / nonSpace.length > 0.5;
}

/**
 * 문자 타입 판별
 */
function getCharType(char) {
  if (char === ' ') return 'space';
  if (char === '\n') return 'newline';

  const code = char.codePointAt(0);

  // CJK Unified Ideographs (한자)
  if (code >= 0x4E00 && code <= 0x9FFF) return 'cjk';
  // CJK Extension A
  if (code >= 0x3400 && code <= 0x4DBF) return 'cjk';
  // 히라가나
  if (code >= 0x3040 && code <= 0x309F) return 'cjk';
  // 카타카나
  if (code >= 0x30A0 && code <= 0x30FF) return 'cjk';
  // CJK 부호/구두점
  if (code >= 0x3000 && code <= 0x303F) return 'cjk';
  // 전각 문자
  if (code >= 0xFF00 && code <= 0xFFEF) return 'cjk';

  return 'other';
}

/**
 * subtitle_taskinfo 텍스트 업데이트
 */
function updateSubtitleTaskinfo(draftInfo, replacements) {
  const taskinfo = draftInfo.config?.subtitle_taskinfo;
  if (!taskinfo || taskinfo.length === 0) return;

  // taskinfo는 참조용이므로 간단히 로그만 남김
  logger.info(CATEGORIES.CONVERT, 'subtitle_taskinfo는 원본 유지 (참조용)');
}

/**
 * 프로젝트에서 추출한 자막의 요약 정보
 */
export function summarizeSubtitles(subtitles) {
  return subtitles.map((s, i) => ({
    index: i,
    english: s.englishLine,
    translation: s.translationLine,
    timeStart: s.timeRange?.start || 0,
    timeDuration: s.timeRange?.duration || 0,
  }));
}
