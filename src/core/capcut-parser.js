/**
 * CapCut draft_info.json 파싱/수정 모듈
 *
 * 자막 구조 (실제 CapCut 프로젝트 기반):
 * - KR 프로젝트: 3개 텍스트 트랙 (영어 자막 / 한국어 번역 / 타이틀)
 *   → 영어와 한국어가 별도 트랙, 같은 시간대에 매칭
 * - EN 프로젝트: 1개 텍스트 트랙 (영어 자막만)
 * - 영어 텍스트 내 \n은 줄바꿈(리치텍스트), 이중언어 구분자가 아님
 */

import { logger, CATEGORIES } from './logger.js';

// ─────────────────────────────────────────────
// parseProject
// ─────────────────────────────────────────────

/**
 * draft_info.json을 파싱하여 자막 정보 추출
 *
 * 1. 모든 텍스트 트랙(type='text') 수집
 * 2. 각 트랙을 분류: 영어 / 번역 / 타이틀
 * 3. 트랙 1개면 EN-only, 여러 개면 시간 매칭으로 영어-번역 페어링
 *
 * @param {object} draftInfo - 파싱된 draft_info.json 객체
 * @returns {{ subtitles: Array, title: object|null, isEnglishOnly: boolean, metadata: object }}
 */
export function parseProject(draftInfo) {
  logger.info(CATEGORIES.PARSE, '프로젝트 파싱 시작', {
    version: draftInfo.new_version,
    duration: draftInfo.duration,
    trackCount: draftInfo.tracks?.length,
  });

  const texts = draftInfo.materials?.texts || [];
  const tracks = draftInfo.tracks || [];
  const videoDuration = draftInfo.duration || 0;

  // 텍스트 트랙만 필터
  const textTracks = tracks.filter(t => t.type === 'text');
  if (textTracks.length === 0) {
    logger.warn(CATEGORIES.PARSE, '텍스트 트랙을 찾을 수 없습니다');
    return { subtitles: [], title: null, isEnglishOnly: true, metadata: {} };
  }

  logger.info(CATEGORIES.PARSE, `텍스트 트랙 ${textTracks.length}개, 텍스트 material ${texts.length}개 발견`);

  // ── 트랙 분류 ──
  const classified = classifyTracks(textTracks, texts, videoDuration);

  // ── 프로젝트 유형 판별 ──
  const hasEnglish = !!classified.englishTrack;
  const hasTranslation = !!classified.translationTrack;
  let subtitles;
  let projectType;

  if (hasEnglish && hasTranslation) {
    // 영어 + 번역 둘 다 있음 → 번역 트랙을 교체 대상으로
    projectType = 'paired';
    subtitles = buildPairedSubtitles(classified.englishTrack, classified.translationTrack, texts);
  } else if (hasEnglish && !hasTranslation) {
    // 영어만 있음 → 번역을 추가(append)
    projectType = 'english_only';
    subtitles = buildEnglishOnlySubtitles(classified.englishTrack, texts);
  } else if (!hasEnglish && hasTranslation) {
    // 한국어(비영어)만 있음 → 전체 교체
    projectType = 'korean_only';
    subtitles = buildKoreanOnlySubtitles(classified.translationTrack, texts);
  } else {
    projectType = 'unknown';
    subtitles = [];
    logger.warn(CATEGORIES.PARSE, '자막 트랙을 분류할 수 없습니다');
  }

  // ── 타이틀 빌드 (복수 지원) ──
  const titles = classified.titleTracks.map(t => buildTitle(t, texts)).filter(Boolean);

  logger.info(CATEGORIES.PARSE, `파싱 완료: 자막 ${subtitles.length}개, 타이틀 ${titles.length}개, 유형: ${projectType}`);

  return {
    subtitles,
    titles,
    title: titles[0] || null, // 하위 호환
    projectType,
    isEnglishOnly: projectType === 'english_only',
    isKoreanOnly: projectType === 'korean_only',
    metadata: {
      version: draftInfo.new_version,
      duration: draftInfo.duration,
      fps: draftInfo.fps,
    },
  };
}

// ─────────────────────────────────────────────
// 트랙 분류
// ─────────────────────────────────────────────

/**
 * 텍스트 트랙을 영어/번역/타이틀로 분류
 *
 * 판별 기준:
 * - 세그먼트 1개 + 전체 영상 길이의 80% 이상 + 비영어 → 타이틀
 * - 샘플 텍스트가 영어 위주 → 영어 트랙
 * - 나머지 다중 세그먼트 비영어 → 번역 트랙
 */
function classifyTracks(textTracks, texts, videoDuration) {
  const titleTracks = [];
  let englishTrack = null;
  let translationTrack = null;

  for (const track of textTracks) {
    const segments = track.segments || [];
    if (segments.length === 0) continue;

    // 타이틀 판별: 세그먼트 1개 + 영상 길이 70% 이상
    if (segments.length === 1 && videoDuration > 0) {
      const seg = segments[0];
      const segDuration = seg.target_timerange?.duration || 0;
      const ratio = segDuration / videoDuration;

      if (ratio >= 0.7) {
        const material = texts.find(t => t.id === seg.material_id);
        const sampleText = extractTextFromMaterial(material);
        titleTracks.push(track);
        logger.info(CATEGORIES.PARSE, `타이틀 트랙 감지 (비율: ${(ratio * 100).toFixed(0)}%)`, {
          text: sampleText.slice(0, 60),
        });
        continue;
      }
    }

    // 영어/번역 판별: 처음 몇 개 세그먼트 샘플링
    const sampleTexts = sampleTrackTexts(track, texts, 3);
    const isEnglish = sampleTexts.length > 0 && sampleTexts.every(t => isPrimarilyEnglish(t));

    if (isEnglish) {
      englishTrack = track;
      logger.info(CATEGORIES.PARSE, `영어 트랙 감지 (세그먼트 ${segments.length}개)`);
    } else {
      translationTrack = track;
      logger.info(CATEGORIES.PARSE, `번역 트랙 감지 (세그먼트 ${segments.length}개)`);
    }
  }

  // 타이틀 아닌 트랙이 1개뿐이고 영어로 판별 안 된 경우 → 내용으로 재확인
  if (!englishTrack && translationTrack && !titleTracks.length) {
    // 비영어 트랙 1개만 있으면 그게 유일한 자막 트랙 (한국어 전용 등)
    logger.info(CATEGORIES.PARSE, '영어 트랙 없음 → 비영어 전용 프로젝트');
  }

  return { englishTrack, translationTrack, titleTracks };
}

/**
 * 트랙에서 처음 N개 세그먼트의 텍스트 샘플 추출
 */
function sampleTrackTexts(track, texts, count) {
  const segments = (track.segments || []).slice(0, count);
  const result = [];
  for (const seg of segments) {
    const material = texts.find(t => t.id === seg.material_id);
    const text = extractTextFromMaterial(material);
    if (text) result.push(text);
  }
  return result;
}

/**
 * material에서 텍스트 추출 (content JSON 파싱)
 */
function extractTextFromMaterial(material) {
  if (!material) return '';
  try {
    const content = JSON.parse(material.content || '{}');
    return content.text || '';
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
// 자막 빌드
// ─────────────────────────────────────────────

/**
 * EN-only: 영어 트랙만으로 자막 배열 생성
 * → translationLine 비워둠, materialId = englishMaterialId
 */
function buildEnglishOnlySubtitles(englishTrack, texts) {
  if (!englishTrack) return [];

  const segments = sortSegmentsByTime(englishTrack.segments || []);
  const subtitles = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const material = texts.find(t => t.id === seg.material_id);
    if (!material) {
      logger.warn(CATEGORIES.PARSE, `영어 세그먼트의 material 없음: ${seg.material_id}`);
      continue;
    }

    const parsed = parseMaterialContent(material);

    subtitles.push({
      index: subtitles.length,
      englishLine: flattenNewlines(parsed.text),
      translationLine: '',
      englishMaterialId: material.id,
      translationMaterialId: null,
      materialId: material.id, // EN-only → 영어 material을 수정 대상으로
      segmentId: seg.id,
      timeRange: seg.target_timerange,
      rawMaterial: material,
      rawEnglishMaterial: material,
      content: parsed.content,
      styles: parsed.styles,
      words: parsed.words,
    });
  }

  return subtitles;
}

/**
 * 한국어 전용: 번역 트랙만으로 자막 배열 생성
 * → materialId = 한국어 material (전체 교체 대상)
 */
function buildKoreanOnlySubtitles(koreanTrack, texts) {
  if (!koreanTrack) return [];

  const segments = sortSegmentsByTime(koreanTrack.segments || []);
  const subtitles = [];

  for (const seg of segments) {
    const material = texts.find(t => t.id === seg.material_id);
    if (!material) {
      logger.warn(CATEGORIES.PARSE, `한국어 세그먼트의 material 없음: ${seg.material_id}`);
      continue;
    }

    const parsed = parseMaterialContent(material);

    subtitles.push({
      index: subtitles.length,
      englishLine: '',
      translationLine: parsed.text,
      englishMaterialId: null,
      translationMaterialId: material.id,
      materialId: material.id,
      segmentId: seg.id,
      timeRange: seg.target_timerange,
      rawMaterial: material,
      rawEnglishMaterial: null,
      content: parsed.content,
      styles: parsed.styles,
      words: parsed.words,
    });
  }

  return subtitles;
}

/**
 * 다국어: 영어+번역 트랙을 시간으로 매칭하여 페어링
 * → materialId = translationMaterialId (번역 material을 수정 대상)
 */
function buildPairedSubtitles(englishTrack, translationTrack, texts) {
  if (!englishTrack || !translationTrack) return [];

  const enSegments = sortSegmentsByTime(englishTrack.segments || []);
  const trSegments = sortSegmentsByTime(translationTrack.segments || []);

  const subtitles = [];

  for (const enSeg of enSegments) {
    const enMaterial = texts.find(t => t.id === enSeg.material_id);
    if (!enMaterial) continue;

    // 시간 매칭: 시작 시간이 100ms(100000μs) 이내인 번역 세그먼트 찾기
    const TIME_TOLERANCE = 100000; // 100ms in microseconds
    const enStart = enSeg.target_timerange?.start || 0;
    const matchedTrSeg = trSegments.find(trSeg => {
      const trStart = trSeg.target_timerange?.start || 0;
      return Math.abs(enStart - trStart) <= TIME_TOLERANCE;
    });

    const trMaterial = matchedTrSeg
      ? texts.find(t => t.id === matchedTrSeg.material_id)
      : null;

    const enParsed = parseMaterialContent(enMaterial);
    const trParsed = trMaterial ? parseMaterialContent(trMaterial) : null;

    // 번역 material이 수정 대상
    const targetMaterial = trMaterial || enMaterial;
    const targetParsed = trParsed || enParsed;

    subtitles.push({
      index: subtitles.length,
      englishLine: flattenNewlines(enParsed.text),
      translationLine: trParsed ? trParsed.text : '',
      englishMaterialId: enMaterial.id,
      translationMaterialId: trMaterial ? trMaterial.id : null,
      materialId: targetMaterial.id,
      segmentId: matchedTrSeg ? matchedTrSeg.id : enSeg.id,
      timeRange: enSeg.target_timerange,
      rawMaterial: targetMaterial,
      rawEnglishMaterial: enMaterial,
      content: targetParsed.content,
      styles: targetParsed.styles,
      words: targetParsed.words,
    });

    if (!matchedTrSeg) {
      logger.warn(CATEGORIES.PARSE, `영어 세그먼트에 매칭되는 번역 없음 (start: ${enStart})`, {
        englishText: enParsed.text.slice(0, 40),
      });
    }
  }

  return subtitles;
}

/**
 * 타이틀 트랙에서 타이틀 객체 빌드
 */
function buildTitle(titleTrack, texts) {
  const seg = (titleTrack.segments || [])[0];
  if (!seg) return null;

  const material = texts.find(t => t.id === seg.material_id);
  if (!material) return null;

  const parsed = parseMaterialContent(material);

  return {
    materialId: material.id,
    fullText: parsed.text,
    englishLine: '',          // 타이틀은 비영어이므로 빈 문자열
    translationLine: parsed.text,
    rawMaterial: material,
    content: parsed.content,
    styles: parsed.styles,
    words: parsed.words,
    segmentId: seg.id,
    timeRange: seg.target_timerange,
  };
}

// ─────────────────────────────────────────────
// material 파싱 헬퍼
// ─────────────────────────────────────────────

/**
 * material의 content JSON 파싱 + words 파싱
 * @returns {{ text, content, styles, words }}
 */
function parseMaterialContent(material) {
  let content;
  try {
    content = JSON.parse(material.content || '{}');
  } catch (e) {
    logger.error(CATEGORIES.PARSE, `content JSON 파싱 실패: ${e.message}`, {
      id: material.id,
    });
    content = { text: '', styles: [] };
  }

  let words = { start_time: [], end_time: [], text: [] };
  if (material.words) {
    try {
      words = typeof material.words === 'string'
        ? JSON.parse(material.words)
        : material.words;
    } catch {
      // words 파싱 실패 시 빈 값 유지
    }
  }

  return {
    text: content.text || '',
    content,
    styles: content.styles || [],
    words,
  };
}

/**
 * 세그먼트를 시간순 정렬
 */
function sortSegmentsByTime(segments) {
  return [...segments].sort(
    (a, b) => (a.target_timerange?.start || 0) - (b.target_timerange?.start || 0)
  );
}

/**
 * 텍스트 내 \n을 공백으로 변환 (영어 줄바꿈 평탄화)
 */
function flattenNewlines(text) {
  return (text || '').replace(/\n/g, ' ').trim();
}

// ─────────────────────────────────────────────
// applyReplacements
// ─────────────────────────────────────────────

/**
 * 자막의 번역 부분을 새 텍스트로 교체
 *
 * 각 replacement에 isEnglishOnly 플래그가 있음:
 * - false (KR 프로젝트): content.text 전체를 newTranslation으로 교체
 * - true (EN 프로젝트): 기존 영어 유지 + \n\n + newTranslation 추가
 *
 * @param {object} draftInfo - 원본 draft_info.json (깊은 복사해서 수정)
 * @param {Array} replacements - [{ materialId, newTranslation, isEnglishOnly, fontConfig, styleConfig }]
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
        isEnglishOnly: rep.isEnglishOnly,
      });
    } catch (e) {
      logger.error(CATEGORIES.CONVERT, `자막 교체 실패: ${e.message}`, {
        materialId: rep.materialId,
      });
      errorCount++;
    }
  }

  // subtitle_taskinfo 업데이트
  updateSubtitleTaskinfo(modified, replacements);

  logger.info(CATEGORIES.CONVERT, `변환 완료: 성공 ${successCount}, 실패 ${errorCount}`);
  return modified;
}

// ─────────────────────────────────────────────
// replaceTextMaterial
// ─────────────────────────────────────────────

/**
 * 개별 텍스트 material 교체
 *
 * KR 프로젝트 (isEnglishOnly=false):
 *   - content.text를 newTranslation으로 전체 교체
 *   - 스타일 1개로 통일 [0, newTranslation.length]
 *
 * EN 프로젝트 (isEnglishOnly=true):
 *   - 기존 영어 텍스트 + \n\n + newTranslation
 *   - 기존 영어 스타일 유지, 번역용 새 스타일 추가
 *
 * 타이틀 (isTitle=true):
 *   - " / " 포함 시 2줄로 분리 (line1\nline2, 2 스타일)
 *   - 아니면 단일 스타일
 */
function replaceTextMaterial(textMaterial, replacement) {
  const { newTranslation, isEnglishOnly, isTitle, fontConfig, styleConfig } = replacement;

  // content 파싱
  let content;
  try {
    content = JSON.parse(textMaterial.content);
  } catch {
    throw new Error('content JSON 파싱 실패');
  }

  const oldText = content.text || '';
  const styles = content.styles || [];

  let newText;
  let englishEnd = 0;

  if (isTitle) {
    // ── 타이틀 교체 ──
    if (newTranslation.includes(' / ')) {
      // " / "로 분리 → 2줄 + 2스타일
      const [line1, line2] = newTranslation.split(' / ', 2);
      newText = line1 + '\n' + line2;

      // 스타일 2개: line1용, line2용
      const style1 = styles[0] ? JSON.parse(JSON.stringify(styles[0])) : {};
      const style2 = styles[1] ? JSON.parse(JSON.stringify(styles[1])) : JSON.parse(JSON.stringify(style1));
      style1.range = [0, line1.length];
      style2.range = [line1.length + 1, newText.length];

      if (fontConfig) {
        applyFontToStyle(style1, fontConfig);
        applyFontToStyle(style2, fontConfig);
      }
      if (styleConfig) {
        applyStyleConfig(style1, styleConfig);
        applyStyleConfig(style2, styleConfig);
      }
      content.styles = [style1, style2];
    } else {
      // 단일 텍스트 → 1스타일
      newText = newTranslation;
      const style = styles[0] ? JSON.parse(JSON.stringify(styles[0])) : {};
      style.range = [0, newText.length];
      if (fontConfig) applyFontToStyle(style, fontConfig);
      if (styleConfig) applyStyleConfig(style, styleConfig);
      content.styles = [style];
    }

  } else if (isEnglishOnly) {
    // ── EN 프로젝트: 영어 유지 + 번역 추가 ──
    newText = oldText + '\n\n' + newTranslation;
    englishEnd = oldText.length;

    // 기존 영어 스타일 모두 유지 (range 변경 없음)
    // 번역용 새 스타일 추가 (마지막 스타일 기반 복사)
    const baseStyle = styles.length > 0
      ? JSON.parse(JSON.stringify(styles[styles.length - 1]))
      : {};
    baseStyle.range = [englishEnd + 2, newText.length]; // \n\n 이후
    if (fontConfig) applyFontToStyle(baseStyle, fontConfig);
    if (styleConfig) applyStyleConfig(baseStyle, styleConfig);
    content.styles = [...styles, baseStyle];

  } else {
    // ── KR 프로젝트: 전체 교체 ──
    newText = newTranslation;

    // 단일 스타일로 통일
    const style = styles[0] ? JSON.parse(JSON.stringify(styles[0])) : {};
    style.range = [0, newText.length];
    if (fontConfig) applyFontToStyle(style, fontConfig);
    if (styleConfig) applyStyleConfig(style, styleConfig);
    content.styles = [style];
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

// ─────────────────────────────────────────────
// 스타일/폰트 헬퍼 (기존 유지)
// ─────────────────────────────────────────────

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
  if (styleConfig.strokeWidth !== undefined && style.strokes?.[0]) {
    style.strokes[0].width = styleConfig.strokeWidth;
  }
  if (styleConfig.fontSize) {
    style.size = styleConfig.fontSize;
  }
}

// ─────────────────────────────────────────────
// words 타이밍 (기존 유지)
// ─────────────────────────────────────────────

/**
 * 단어별 타이밍 재계산
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

  // 새 텍스트의 전체 내용 (영어 + 번역 포함 시 content에서 가져옴)
  const fullText = englishEnd > 0
    ? (() => { try { return JSON.parse(textMaterial.content).text; } catch { return newTranslation; } })()
    : newTranslation;

  // 단어 단위로 분리
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

// ─────────────────────────────────────────────
// 유틸리티
// ─────────────────────────────────────────────

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
