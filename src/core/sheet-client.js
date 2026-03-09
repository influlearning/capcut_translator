/**
 * Google Sheets API 클라이언트
 * 공개 시트에서 번역 데이터 로드
 */

import { SHEETS_API_KEY, LANGUAGES } from '../utils/constants.js';
import { logger, CATEGORIES } from './logger.js';

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * 시트 URL에서 spreadsheetId와 gid 파싱
 * @param {string} url - 구글 시트 URL
 * @returns {{ spreadsheetId: string, gid: string|null }}
 */
export function parseSheetUrl(url) {
  // /spreadsheets/d/{ID}/edit?gid={GID}
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const gidMatch = url.match(/[?&#]gid=(\d+)/);

  const result = {
    spreadsheetId: idMatch ? idMatch[1] : null,
    gid: gidMatch ? gidMatch[1] : null,
  };

  logger.info(CATEGORIES.SHEET, 'URL 파싱', result);
  return result;
}

/**
 * 시트의 탭 목록 가져오기
 * @param {string} spreadsheetId
 * @returns {Promise<Array<{ title: string, sheetId: number, index: number }>>}
 */
export async function fetchTabList(spreadsheetId) {
  const url = `${API_BASE}/${spreadsheetId}?fields=sheets.properties&key=${SHEETS_API_KEY}`;

  logger.info(CATEGORIES.SHEET, '탭 목록 요청');

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const tabs = data.sheets.map(s => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      index: s.properties.index,
    }));

    logger.info(CATEGORIES.SHEET, `탭 ${tabs.length}개 로드 완료`);
    return tabs;
  } catch (e) {
    logger.error(CATEGORIES.SHEET, `탭 목록 로드 실패: ${e.message}`);
    throw e;
  }
}

/**
 * 특정 탭의 데이터 가져오기
 * @param {string} spreadsheetId
 * @param {string} tabTitle
 * @returns {Promise<{ headers: string[], rows: object[], columnMap: object }>}
 */
export async function fetchSheetData(spreadsheetId, tabTitle) {
  // 탭 이름에 특수문자가 있을 수 있으므로 인코딩
  const encodedTab = encodeURIComponent(tabTitle);
  const url = `${API_BASE}/${spreadsheetId}/values/${encodedTab}?key=${SHEETS_API_KEY}`;

  logger.info(CATEGORIES.SHEET, `시트 데이터 요청: "${tabTitle}"`);

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const rawRows = data.values || [];

    if (rawRows.length === 0) {
      logger.warn(CATEGORIES.SHEET, '시트가 비어있습니다');
      return { headers: [], rows: [], columnMap: {} };
    }

    // 헤더 파싱 (1행)
    const headers = rawRows[0];
    const columnMap = detectColumns(headers);

    logger.info(CATEGORIES.SHEET, '컬럼 매핑', columnMap);

    // 데이터 행 파싱 (2행~)
    const rows = rawRows.slice(1).map((row, i) => ({
      index: i,
      number: row[0] || '',  // 첫 번째 컬럼 (번호)
      english: columnMap.en !== -1 ? (row[columnMap.en] || '') : '',
      korean: columnMap.kr !== -1 ? (row[columnMap.kr] || '') : '',
      chinese: columnMap.cn !== -1 ? (row[columnMap.cn] || '') : '',
      japanese: columnMap.jp !== -1 ? (row[columnMap.jp] || '') : '',
      raw: row,
    }));

    logger.info(CATEGORIES.SHEET, `${rows.length}행 로드 완료 (타이틀 포함)`);
    return { headers, rows, columnMap };
  } catch (e) {
    logger.error(CATEGORIES.SHEET, `시트 데이터 로드 실패: ${e.message}`);
    throw e;
  }
}

/**
 * 헤더에서 언어별 컬럼 인덱스 감지
 * @param {string[]} headers
 * @returns {{ en: number, kr: number, cn: number, jp: number }}
 */
function detectColumns(headers) {
  const map = { en: -1, kr: -1, cn: -1, jp: -1 };

  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').trim().toLowerCase();

    for (const [langKey, langDef] of Object.entries(LANGUAGES)) {
      const mapKey = langDef.code;
      if (map[mapKey] !== -1) continue; // 이미 찾음

      const found = langDef.headerPatterns.some(
        pattern => h.includes(pattern.toLowerCase())
      );
      if (found) {
        map[mapKey] = i;
        break;
      }
    }
  }

  return map;
}

/**
 * gid로 탭 이름 찾기
 * @param {Array} tabs - fetchTabList() 결과
 * @param {string} gid
 * @returns {string|null} 탭 이름
 */
export function findTabByGid(tabs, gid) {
  const numGid = parseInt(gid, 10);
  const tab = tabs.find(t => t.sheetId === numGid);
  return tab ? tab.title : null;
}
