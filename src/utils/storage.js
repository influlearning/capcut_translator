/**
 * localStorage 래퍼
 * 폰트/스타일/시트 URL 등 사용자 설정 저장/불러오기
 */

import { STORAGE_KEYS } from './constants.js';

/** 값 저장 */
export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorage 저장 실패:', e);
  }
}

/** 값 불러오기 */
export function load(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
  }
}

/** 시트 URL 저장/불러오기 */
export function saveSheetUrl(url) {
  save(STORAGE_KEYS.SHEET_URL, url);
}

export function loadSheetUrl() {
  return load(STORAGE_KEYS.SHEET_URL, '');
}

/**
 * 언어별 폰트 설정 저장/불러오기
 * 형태: { cn: { fontPath, fontId, fontName, fontTitle }, jp: { ... } }
 */
export function saveFontSettings(settings) {
  save(STORAGE_KEYS.FONT_SETTINGS, settings);
}

export function loadFontSettings() {
  return load(STORAGE_KEYS.FONT_SETTINGS, {});
}

/**
 * 언어별 스타일 설정 저장/불러오기
 * 형태: { cn: { textColor, borderColor, borderWidth, fontSize }, jp: { ... } }
 */
export function saveStyleSettings(settings) {
  save(STORAGE_KEYS.STYLE_SETTINGS, settings);
}

export function loadStyleSettings() {
  return load(STORAGE_KEYS.STYLE_SETTINGS, {});
}
