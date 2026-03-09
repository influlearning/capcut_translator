/**
 * 로그 수집/다운로드 모듈
 * 비개발자가 로그를 보내주면 디버깅할 수 있도록 상세 기록
 */

const LEVELS = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' };
const CATEGORIES = {
  PARSE: 'PARSE',     // 캡컷 프로젝트 파싱
  SHEET: 'SHEET',     // 구글 시트 연동
  MATCH: 'MATCH',     // 자막 매칭
  CONVERT: 'CONVERT', // 변환 처리
  UI: 'UI',           // UI 이벤트
  FILE: 'FILE',       // 파일 입출력
};

class Logger {
  constructor() {
    this.entries = [];
    this.listeners = []; // UI 업데이트용 콜백
  }

  /**
   * 로그 추가
   * @param {'INFO'|'WARN'|'ERROR'} level
   * @param {string} category - PARSE, SHEET, MATCH, CONVERT, UI, FILE
   * @param {string} message
   * @param {*} [data] - 디버깅용 데이터 (자막 텍스트, 매칭 결과 등)
   */
  log(level, category, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
    };
    this.entries.push(entry);

    // 콘솔 출력
    const prefix = `[${entry.timestamp}] [${level}] [${category}]`;
    if (level === LEVELS.ERROR) {
      console.error(prefix, message, data || '');
    } else if (level === LEVELS.WARN) {
      console.warn(prefix, message, data || '');
    } else {
      console.log(prefix, message, data || '');
    }

    // UI 리스너 알림
    this.listeners.forEach(fn => fn(entry));
  }

  info(category, message, data) {
    this.log(LEVELS.INFO, category, message, data);
  }

  warn(category, message, data) {
    this.log(LEVELS.WARN, category, message, data);
  }

  error(category, message, data) {
    this.log(LEVELS.ERROR, category, message, data);
  }

  /** UI 업데이트 리스너 등록 */
  onLog(callback) {
    this.listeners.push(callback);
  }

  /** 로그를 텍스트로 포맷 */
  formatEntries() {
    return this.entries.map(e => {
      let line = `[${e.timestamp}] [${e.level}] [${e.category}] ${e.message}`;
      if (e.data !== null) {
        try {
          line += '\n  DATA: ' + JSON.stringify(e.data, null, 2).split('\n').join('\n  ');
        } catch {
          line += '\n  DATA: [직렬화 불가]';
        }
      }
      return line;
    }).join('\n');
  }

  /** 로그 파일 다운로드 */
  downloadLog() {
    const text = this.formatEntries();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `capcut-translator-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 로그 초기화 */
  clear() {
    this.entries = [];
  }
}

// 싱글턴
export const logger = new Logger();
export { LEVELS, CATEGORIES };
