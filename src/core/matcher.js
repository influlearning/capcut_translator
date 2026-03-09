/**
 * 캡컷 자막 ↔ 시트 데이터 매칭 모듈
 *
 * 매칭 전략:
 * 1. 기본: 순서 기반 1:1 매칭
 * 2. 검증: 영어 텍스트 비교 (캡컷 영어줄 vs 시트 영어 컬럼)
 * 3. 불일치 시 mismatch 표시 → UI에서 수동 수정 가능
 */

import { logger, CATEGORIES } from './logger.js';

/**
 * 자막과 시트 데이터 매칭
 * @param {Array} subtitles - parseProject()에서 추출한 자막 배열
 * @param {Array} sheetRows - fetchSheetData()에서 추출한 행 배열
 * @param {object|null} title - 타이틀 텍스트 (있으면)
 * @param {string} targetLang - 'cn' | 'jp'
 * @returns {Array<MatchResult>}
 */
export function matchSubtitles(subtitles, sheetRows, title, targetLang) {
  logger.info(CATEGORIES.MATCH, `매칭 시작: 자막 ${subtitles.length}개, 시트 ${sheetRows.length}행, 타겟: ${targetLang}`);

  const results = [];

  // 시트에서 타이틀 행 분리 (number가 '0'이거나 영어가 비어있는 첫 행)
  let titleRow = null;
  let subtitleRows = sheetRows;

  if (sheetRows.length > 0 && (sheetRows[0].number === '0' || sheetRows[0].english === '')) {
    titleRow = sheetRows[0];
    subtitleRows = sheetRows.slice(1);
    logger.info(CATEGORIES.MATCH, `타이틀 행 분리: "${titleRow.korean.slice(0, 30)}..."`);
  }

  // 타이틀 매칭
  if (title && titleRow) {
    const targetText = targetLang === 'cn' ? titleRow.chinese : titleRow.japanese;
    results.push({
      type: 'title',
      index: -1,
      materialId: title.materialId,
      capcutText: title.fullText,
      capcutEnglish: title.englishLine,
      capcutTranslation: title.translationLine,
      sheetEnglish: titleRow.english,
      sheetKorean: titleRow.korean,
      sheetTarget: targetText,
      status: targetText ? 'matched' : 'missing_translation',
      confidence: 1.0,
      sheetRowIndex: 0,
    });
  } else if (title) {
    results.push({
      type: 'title',
      index: -1,
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

  // 자막 순서 매칭
  for (let i = 0; i < Math.max(subtitles.length, subtitleRows.length); i++) {
    const sub = subtitles[i] || null;
    const row = subtitleRows[i] || null;

    if (sub && row) {
      const targetText = targetLang === 'cn' ? row.chinese : row.japanese;

      // 영어 텍스트로 검증
      const confidence = calculateConfidence(sub.englishLine, row.english);
      const status = getMatchStatus(confidence, targetText);

      results.push({
        type: 'subtitle',
        index: i,
        materialId: sub.materialId,
        capcutText: sub.fullText,
        capcutEnglish: sub.englishLine,
        capcutTranslation: sub.translationLine,
        sheetEnglish: row.english,
        sheetKorean: row.korean,
        sheetTarget: targetText,
        status,
        confidence,
        sheetRowIndex: i + (titleRow ? 1 : 0),
      });
    } else if (sub && !row) {
      results.push({
        type: 'subtitle',
        index: i,
        materialId: sub.materialId,
        capcutText: sub.fullText,
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
        sheetRowIndex: i + (titleRow ? 1 : 0),
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
 * 영어 텍스트 유사도 계산 (0~1)
 * 완전 일치: 1.0, 부분 일치: 0~1, 불일치: 0
 */
function calculateConfidence(capcutEn, sheetEn) {
  if (!capcutEn || !sheetEn) return 0;

  const a = normalize(capcutEn);
  const b = normalize(sheetEn);

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
  if (confidence >= 0.3) return 'mismatch';
  return 'mismatch';
}

/**
 * 매칭 결과를 수동으로 수정 (UI에서 호출)
 * @param {Array} results - 기존 매칭 결과
 * @param {number} resultIndex - 수정할 항목 인덱스
 * @param {number} newSheetRowIndex - 새로 매칭할 시트 행 인덱스
 * @param {Array} sheetRows - 전체 시트 행
 * @param {string} targetLang - 'cn' | 'jp'
 * @returns {Array} 수정된 매칭 결과
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
    confidence: calculateConfidence(result.capcutEnglish, row.english),
    sheetRowIndex: newSheetRowIndex,
  };

  logger.info(CATEGORIES.MATCH, `수동 매칭 변경: [${resultIndex}] → 시트 행 ${newSheetRowIndex}`, {
    english: row.english,
    target: targetText,
  });

  return updated;
}
