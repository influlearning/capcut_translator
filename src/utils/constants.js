/**
 * 상수 정의
 */

// Google Sheets API 키
export const SHEETS_API_KEY = 'AIzaSyB9SIToPEsxojqH6PJoO5PhSrQQeFUzFro';

// 지원 언어
export const LANGUAGES = {
  CN: { code: 'cn', label: '中文 (중국어)', headerPatterns: ['중국어', 'Chinese', 'CN', '中文'] },
  JP: { code: 'jp', label: '日本語 (일본어)', headerPatterns: ['일본어', 'Japanese', 'JP', '日本語'] },
  KR: { code: 'kr', label: '한국어', headerPatterns: ['한국어', 'Korean', 'KR', '韩语'] },
  EN: { code: 'en', label: 'English', headerPatterns: ['영어', 'English', 'EN', '英语'] },
};

// localStorage 키
export const STORAGE_KEYS = {
  SHEET_URL: 'capcut_translator_sheet_url',
  FONT_SETTINGS: 'capcut_translator_font_settings',
  STYLE_SETTINGS: 'capcut_translator_style_settings',
};

// 기본 스타일 (한국어 원본에서 가져올 수 없을 때 사용)
export const DEFAULT_STYLE = {
  textColor: [1, 1, 1],      // 흰색
  borderColor: [0, 0, 0],    // 검정
  borderWidth: 0.08,
  fontSize: 10,
};
