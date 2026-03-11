/**
 * 캡컷 자막 ↔ 시트 데이터 매칭 모듈
 *
 * 매칭 전략:
 * 1. 기본: 순서 기반 1:1 매칭
 * 2. 검증: 소스 텍스트 비교 (영어 or 한국어 컬럼)
 * 3. 불일치 시 mismatch 표시 → UI에서 수동 수정 가능
 *
 * 프로젝트 유형별 매칭 기준:
 * - english_only / paired: 캡컷 영어 ↔ 시트 영어 컬럼
 * - korean_only: 캡컷 한국어 ↔ 시트 한국어 컬럼
 */

import { logger, CATEGORIES } from './logger.js';

/**
 * 자막과 시트 데이터 매칭
 * @param {Array} subtitles - parseProject()에서 추출한 자막 배열
 * @param {Array} sheetRows - fetchSheetData()에서 추출한 행 배열
 * @param {Array} titles - 타이틀 배열 (복수 가능)
 * @param {string} targetLang - 'cn' | 'jp'
 * @param {boolean} isKoreanOnly - 한국어 전용 프로젝트 여부
 * @returns {Array<MatchResult>}
 */
export function matchSubtitles(subtitles, sheetRows, titles, targetLang, isKoreanOnly = false) {
  logger.info(CATEGORIES.MATCH, `매칭 시작: 자막 ${subtitles.length}개, 타이틀 ${titles.length}개, 시트 ${sheetRows.length}행, 타겟: ${targetLang}, 한국어전용: ${isKoreanOnly}`);

  const results = [];

  // ── 시트에서 타이틀 행 분리 ──
  // 시트 앞부분에서 number='0' 또는 빈 행을 타이틀 행으로 수집
  const titleRows = [];
  let subtitleStartIndex = 0;

  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (row.number === '0' || row.number === '') {
      titleRows.push(row);
      subtitleStartIndex = i + 1;
    } else {
      break; // 연속된 타이틀 행만 수집
    }
  }
  const subtitleRows = sheetRows.slice(subtitleStartIndex);

  if (titleRows.length > 0) {
    logger.info(CATEGORIES.MATCH, `타이틀 행 ${titleRows.length}개 분리`);
  }

  // ── 타이틀 매칭 (복수 지원) ──
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const titleRow = titleRows[i] || null;

    if (titleRow) {
      const targetText = targetLang === 'cn' ? titleRow.chinese : titleRow.japanese;
      results.push({
        type: 'title',
        index: i,
        materialId: title.materialId,
        capcutText: title.fullText,
        capcutEnglish: title.englishLine,
        capcutTranslation: title.translationLine,
        sheetEnglish: titleRow.english,
        sheetKorean: titleRow.korean,
        sheetTarget: targetText,
        status: targetText ? 'matched' : 'missing_translation',
        confidence: 1.0,
        sheetRowIndex: i,
      });
    } else {
      results.push({
        type: 'title',
        index: i,
        materialId: title.materialId,
        capcutText: title.fullText,
        capcutEnglish: title.englishLine,
        capcutTranslation: title.translationLine,
        sheetEnglish: '',
        sheetKorean: '',
        sheetTarget: '',
        status: 'missing_sheet',
        confidence: 0,
        sheetRowIndex: -1,
      });
    }
  }

  // ── 자막 순서 매칭 ──
  for (let i = 0; i < Math.max(subtitles.length, subtitleRows.length); i++) {
    const sub = subtitles[i] || null;
    const row = subtitleRows[i] || null;

    if (sub && row) {
      const targetText = targetLang === 'cn' ? row.chinese : row.japanese;

      // 소스 텍스트 비교: 한국어 전용이면 한국어 컬럼, 아니면 영어 컬럼
      const capcutSource = isKoreanOnly ? sub.translationLine : sub.englishLine;
      const sheetSource = isKoreanOnly ? row.korean : row.english;
      const confidence = calculateConfidence(capcutSource, sheetSource);
      const status = getMatchStatus(confidence, targetText);

      results.push({
        type: 'subtitle',
        index: i,
        materialId: sub.materialId,
        capcutText: isKoreanOnly ? sub.translationLine : (sub.englishLine || sub.translationLine),
        capcutEnglish: sub.englishLine,
        capcutTranslation: sub.translationLine,
        sheetEnglish: row.english,
        sheetKorean: row.korean,
        sheetTarget: targetText,
        status,
        confidence,
        sheetRowIndex: i + titleRows.length,
      });
    } else if (sub && !row) {
      results.push({
        type: 'subtitle',
        index: i,
        materialId: sub.materialId,
        capcutText: isKoreanOnly ? sub.translationLine : (sub.englishLine || sub.translationLine),
        capcutEnglish: sub.englishLine,
        capcutTranslation: sub.translationLine,
        sheetEnglish: '',
        sheetKorean: '',
        sheetTarget: '',
        status: 'missing_sheet',
        confidence: 0,
        sheetRowIndex: -1,
      });
    } else if (!sub && row) {
      const targetText = targetLang === 'cn' ? row.chinese : row.japanese;
      results.push({
        type: 'subtitle',
        index: i,
        materialId: null,
        capcutText: '',
        capcutEnglish: '',
        capcutTranslation: '',
        sheetEnglish: row.english,
        sheetKorean: row.korean,
        sheetTarget: targetText,
        status: 'missing_capcut',
        confidence: 0,
        sheetRowIndex: i + titleRows.length,
      });
    }
  }

  // 매칭 결과 요약 로그
  const summary = {
    total: results.length,
    matched: results.filter(r => r.status === 'matched').length,
    mismatch: results.filter(r => r.status === 'mismatch').length,
    missingSheet: results.filter(r => r.status === 'missing_sheet').length,
    missingCapcut: results.filter(r => r.status === 'missing_capcut').length,
    missingTranslation: results.filter(r => r.status === 'missing_translation').length,
  };

  logger.info(CATEGORIES.MATCH, '매칭 결과', summary);
  return results;
}

/**
 * 텍스트 유사도 계산 (0~1)
 * 영어/한국어 모두 사용 가능
 */
function calculateConfidence(capcutText, sheetText) {
  if (!capcutText || !sheetText) return 0;

  const a = normalize(capcutText);
  const b = normalize(sheetText);

  if (a === b) return 1.0;

  // 한쪽이 다른 쪽을 포함하면 높은 신뢰도
  if (a.includes(b) || b.includes(a)) return 0.8;

  // 단어 수준 비교
  const wordsA = a.split(/\s+/);
  const wordsB = b.split(/\s+/);
  const common = wordsA.filter(w => wordsB.includes(w));
  const overlap = common.length / Math.max(wordsA.length, wordsB.length);

  return Math.round(overlap * 100) / 100;
}

/**
 * 텍스트 정규화 (비교용)
 */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 매칭 상태 결정
 */
function getMatchStatus(confidence, targetText) {
  if (!targetText) return 'missing_translation';
  if (confidence >= 0.7) return 'matched';
  return 'mismatch';
}

/**
 * 매칭 결과를 수동으로 수정 (UI에서 호출)
 */
export function rematchRow(results, resultIndex, newSheetRowIndex, sheetRows, targetLang) {
  const result = results[resultIndex];
  const row = sheetRows[newSheetRowIndex];

  if (!result || !row) return results;

  const updated = [...results];
  const targetText = targetLang === 'cn' ? row.chinese : row.japanese;

  updated[resultIndex] = {
    ...result,
    sheetEnglish: row.english,
    sheetKorean: row.korean,
    sheetTarget: targetText,
    status: targetText ? 'matched' : 'missing_translation',
    confidence: calculateConfidence(result.capcutEnglish || result.capcutTranslation, row.english || row.korean),
    sheetRowIndex: newSheetRowIndex,
  };

  logger.info(CATEGORIES.MATCH, `수동 매칭 변경: [${resultIndex}] → 시트 행 ${newSheetRowIndex}`, {
    target: targetText,
  });

  return updated;
}
