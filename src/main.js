/**
 * CapCut 자막 번역기 — 앱 진입점
 */

import './style.css';
import { logger, CATEGORIES } from './core/logger.js';
import { parseProject, applyReplacements, summarizeSubtitles } from './core/capcut-parser.js';
import { parseSheetUrl, fetchTabList, fetchSheetData, findTabByGid } from './core/sheet-client.js';
import { matchSubtitles, rematchRow } from './core/matcher.js';
import { extractProject, packageProject, downloadBlob } from './utils/zip-handler.js';
import { loadSheetUrl, saveSheetUrl, loadFontSettings, saveFontSettings, loadStyleSettings, saveStyleSettings } from './utils/storage.js';

// 전역 상태
const state = {
  currentStep: 1,
  // Step 1: 프로젝트
  projectData: null,   // { draftInfo, files, projectName }
  parsedProject: null,  // { subtitles, title, metadata }
  // Step 2: 시트
  sheetId: '',
  sheetGid: '',
  tabs: [],
  selectedTab: '',
  sheetData: null,      // { headers, rows, columnMap }
  // Step 3: 설정
  targetLang: 'cn',
  fontConfig: {},
  styleConfig: {},
  // Step 4: 매칭
  matchResults: [],
  // Step 5: 결과
  converting: false,
  downloadReady: false,
  resultBlob: null,
};

// DOM 마운트
document.querySelector('#app').innerHTML = `
  <div class="header">
    <h1>CapCut 자막 번역기</h1>
    <p>캡컷 프로젝트의 자막을 구글 시트 번역 데이터로 교체합니다</p>
  </div>

  <div class="steps" id="step-indicators"></div>

  <div id="step-content"></div>

  <div class="log-panel collapsed" id="log-panel">
    <div class="log-toggle" id="log-toggle">
      <span>로그</span>
      <div>
        <button class="btn btn-secondary" style="padding:4px 8px;font-size:11px;" id="log-download">다운로드</button>
      </div>
    </div>
    <div class="log-content" id="log-content"></div>
  </div>
`;

// 로그 패널 연결
const logPanel = document.getElementById('log-panel');
const logContent = document.getElementById('log-content');
const logToggle = document.getElementById('log-toggle');

logToggle.addEventListener('click', (e) => {
  if (e.target.id === 'log-download') return;
  logPanel.classList.toggle('collapsed');
  logPanel.classList.toggle('expanded');
});

document.getElementById('log-download').addEventListener('click', () => {
  logger.downloadLog();
});

logger.onLog((entry) => {
  const div = document.createElement('div');
  div.className = `log-entry ${entry.level}`;
  div.textContent = `[${entry.timestamp.slice(11, 19)}] [${entry.category}] ${entry.message}`;
  logContent.appendChild(div);
  logContent.scrollTop = logContent.scrollHeight;
});

logger.info(CATEGORIES.UI, '앱 초기화 완료');

// 스텝 렌더링
function render() {
  renderStepIndicators();
  renderStepContent();
}

function renderStepIndicators() {
  const labels = ['업로드', '시트', '설정', '미리보기', '다운로드'];
  const el = document.getElementById('step-indicators');
  el.innerHTML = labels.map((label, i) => {
    const num = i + 1;
    const cls = num < state.currentStep ? 'done' : num === state.currentStep ? 'active' : '';
    const connector = i < labels.length - 1
      ? `<div class="step-connector ${num < state.currentStep ? 'done' : ''}"></div>`
      : '';
    return `<div class="step-dot ${cls}">${num}</div>${connector}`;
  }).join('');
}

function renderStepContent() {
  const el = document.getElementById('step-content');
  switch (state.currentStep) {
    case 1: el.innerHTML = renderStep1(); bindStep1(); break;
    case 2: el.innerHTML = renderStep2(); bindStep2(); break;
    case 3: el.innerHTML = renderStep3(); bindStep3(); break;
    case 4: el.innerHTML = renderStep4(); bindStep4(); break;
    case 5: el.innerHTML = renderStep5(); bindStep5(); break;
  }
}

// =============================================
// Step 1: 프로젝트 업로드
// =============================================
function renderStep1() {
  const info = state.parsedProject
    ? `<div class="summary">
        <div class="summary-row"><span>프로젝트명</span><span>${state.projectData.projectName}</span></div>
        <div class="summary-row"><span>자막 수</span><span>${state.parsedProject.subtitles.length}개</span></div>
        <div class="summary-row"><span>타이틀</span><span>${state.parsedProject.title ? '있음' : '없음'}</span></div>
        <div class="summary-row"><span>총 길이</span><span>${(state.parsedProject.metadata.duration / 1000000).toFixed(1)}초</span></div>
       </div>`
    : '';

  return `
    <div class="card">
      <h2>1. 캡컷 프로젝트 업로드</h2>
      <div class="dropzone" id="dropzone">
        <p><strong>ZIP 파일을 드래그하거나 클릭하세요</strong></p>
        <p>캡컷 프로젝트 폴더를 ZIP으로 압축해서 업로드</p>
        <input type="file" id="file-input" accept=".zip" style="display:none">
      </div>
      <div style="text-align:center;margin:12px 0;color:var(--text-muted);">또는</div>
      <div style="text-align:center;">
        <button class="btn btn-secondary" id="folder-btn">폴더 선택</button>
        <input type="file" id="folder-input" webkitdirectory style="display:none">
      </div>
      ${info}
    </div>
    <div class="nav-buttons">
      <div></div>
      <button class="btn btn-primary" id="next-btn" ${state.parsedProject ? '' : 'disabled'}>다음 →</button>
    </div>
  `;
}

function bindStep1() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) await handleProjectUpload(file);
  });
  fileInput.addEventListener('change', async () => {
    if (fileInput.files[0]) await handleProjectUpload(fileInput.files[0]);
  });

  document.getElementById('folder-btn').addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', async () => {
    if (folderInput.files.length > 0) await handleProjectUpload(folderInput.files);
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    if (state.parsedProject) { state.currentStep = 2; render(); }
  });
}

async function handleProjectUpload(input) {
  try {
    state.projectData = await extractProject(input);
    state.parsedProject = parseProject(state.projectData.draftInfo);

    // 자막 요약 로그
    const summary = summarizeSubtitles(state.parsedProject.subtitles);
    logger.info(CATEGORIES.PARSE, '자막 목록', summary.map(s =>
      `[${s.index}] EN: "${s.english.slice(0, 40)}" | TR: "${s.translation.slice(0, 40)}"`
    ));

    render();
  } catch (e) {
    logger.error(CATEGORIES.UI, `프로젝트 업로드 실패: ${e.message}`);
    alert(`업로드 실패: ${e.message}`);
  }
}

// =============================================
// Step 2: 시트 연동
// =============================================
function renderStep2() {
  const savedUrl = loadSheetUrl();
  const tabOptions = state.tabs.map(t =>
    `<option value="${t.title}" ${t.title === state.selectedTab ? 'selected' : ''}>${t.title}</option>`
  ).join('');

  const preview = state.sheetData
    ? `<div class="summary" style="margin-top:16px">
        <div class="summary-row"><span>행 수</span><span>${state.sheetData.rows.length}개</span></div>
        <div class="summary-row"><span>영어 컬럼</span><span>${state.sheetData.columnMap.en >= 0 ? '감지됨' : '없음'}</span></div>
        <div class="summary-row"><span>한국어 컬럼</span><span>${state.sheetData.columnMap.kr >= 0 ? '감지됨' : '없음'}</span></div>
        <div class="summary-row"><span>중국어 컬럼</span><span>${state.sheetData.columnMap.cn >= 0 ? '감지됨' : '없음'}</span></div>
        <div class="summary-row"><span>일본어 컬럼</span><span>${state.sheetData.columnMap.jp >= 0 ? '감지됨' : '없음'}</span></div>
       </div>`
    : '';

  return `
    <div class="card">
      <h2>2. 구글 시트 연동</h2>
      <div class="input-group">
        <label>시트 URL</label>
        <input type="text" id="sheet-url" placeholder="https://docs.google.com/spreadsheets/d/..." value="${state.sheetId ? `https://docs.google.com/spreadsheets/d/${state.sheetId}/edit` : savedUrl}">
      </div>
      <button class="btn btn-primary" id="load-tabs-btn">탭 목록 불러오기</button>

      ${state.tabs.length > 0 ? `
        <div class="input-group" style="margin-top:16px">
          <label>시트 탭 선택</label>
          <select id="tab-select">
            <option value="">탭을 선택하세요</option>
            ${tabOptions}
          </select>
        </div>
        <button class="btn btn-primary" id="load-data-btn" ${state.selectedTab ? '' : 'disabled'}>데이터 불러오기</button>
      ` : ''}

      ${preview}
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="prev-btn">← 이전</button>
      <button class="btn btn-primary" id="next-btn" ${state.sheetData ? '' : 'disabled'}>다음 →</button>
    </div>
  `;
}

function bindStep2() {
  document.getElementById('load-tabs-btn').addEventListener('click', async () => {
    const url = document.getElementById('sheet-url').value.trim();
    if (!url) return alert('시트 URL을 입력해주세요.');

    const { spreadsheetId, gid } = parseSheetUrl(url);
    if (!spreadsheetId) return alert('올바른 구글 시트 URL이 아닙니다.');

    state.sheetId = spreadsheetId;
    state.sheetGid = gid;
    saveSheetUrl(url);

    try {
      state.tabs = await fetchTabList(spreadsheetId);
      // gid로 자동 선택
      if (gid) {
        const tabName = findTabByGid(state.tabs, gid);
        if (tabName) state.selectedTab = tabName;
      }
      render();
    } catch (e) {
      alert(`탭 목록 로드 실패: ${e.message}`);
    }
  });

  const tabSelect = document.getElementById('tab-select');
  if (tabSelect) {
    tabSelect.addEventListener('change', () => {
      state.selectedTab = tabSelect.value;
      render();
    });
  }

  const loadDataBtn = document.getElementById('load-data-btn');
  if (loadDataBtn) {
    loadDataBtn.addEventListener('click', async () => {
      try {
        state.sheetData = await fetchSheetData(state.sheetId, state.selectedTab);
        render();
      } catch (e) {
        alert(`데이터 로드 실패: ${e.message}`);
      }
    });
  }

  document.getElementById('prev-btn').addEventListener('click', () => { state.currentStep = 1; render(); });
  const nextBtn = document.getElementById('next-btn');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (state.sheetData) { state.currentStep = 3; render(); }
  });
}

// =============================================
// Step 3: 설정
// =============================================
function renderStep3() {
  const savedFont = loadFontSettings();
  const savedStyle = loadStyleSettings();
  const langFont = savedFont[state.targetLang] || {};
  const langStyle = savedStyle[state.targetLang] || {};

  // 원본 프로젝트에서 기본 스타일 추출
  const firstSub = state.parsedProject?.subtitles?.[0];
  const origFontPath = firstSub?.rawMaterial?.font_path || '';
  const origFontId = firstSub?.rawMaterial?.font_id || '';

  return `
    <div class="card">
      <h2>3. 번역 설정</h2>

      <div class="input-group">
        <label>타겟 언어</label>
        <div class="radio-group">
          <label><input type="radio" name="lang" value="cn" ${state.targetLang === 'cn' ? 'checked' : ''}> 中文 (중국어)</label>
          <label><input type="radio" name="lang" value="jp" ${state.targetLang === 'jp' ? 'checked' : ''}> 日本語 (일본어)</label>
        </div>
      </div>

      <h3 style="font-size:15px;margin:20px 0 12px;">폰트 설정</h3>
      <div class="settings-grid">
        <div class="input-group">
          <label>폰트 경로 (CapCut이 인식하는 경로)</label>
          <input type="text" id="font-path" placeholder="${origFontPath || '/Users/.../font.ttf'}" value="${langFont.fontPath || ''}">
        </div>
        <div class="input-group">
          <label>폰트 ID (CapCut effect_id)</label>
          <input type="text" id="font-id" placeholder="${origFontId || '6808056385679397389'}" value="${langFont.fontId || ''}">
        </div>
        <div class="input-group">
          <label>폰트 이름</label>
          <input type="text" id="font-title" placeholder="예: 고딕체" value="${langFont.fontTitle || ''}">
        </div>
      </div>

      <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">
        * 폰트 경로/ID는 CapCut에서 해당 폰트를 한 번 사용한 뒤, 프로젝트 파일에서 확인할 수 있습니다.<br>
        * 원본 폰트 경로: <code style="font-size:11px;">${origFontPath || '(프로젝트 업로드 후 표시)'}</code>
      </p>

      <h3 style="font-size:15px;margin:20px 0 12px;">스타일 설정 (선택)</h3>
      <div class="settings-grid">
        <div class="input-group">
          <label>텍스트 색상</label>
          <input type="color" id="text-color" value="${langStyle.textColor || '#ffffff'}" style="height:40px;">
        </div>
        <div class="input-group">
          <label>테두리 색상</label>
          <input type="color" id="border-color" value="${langStyle.borderColor || '#000000'}" style="height:40px;">
        </div>
        <div class="input-group">
          <label>테두리 두께 (0~0.15)</label>
          <input type="number" id="border-width" step="0.01" min="0" max="0.15" value="${langStyle.borderWidth || '0.08'}">
        </div>
        <div class="input-group">
          <label>글씨 크기</label>
          <input type="number" id="font-size" step="0.5" min="1" max="30" value="${langStyle.fontSize || '10'}">
        </div>
      </div>
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="prev-btn">← 이전</button>
      <button class="btn btn-primary" id="next-btn">다음 →</button>
    </div>
  `;
}

function bindStep3() {
  document.querySelectorAll('input[name="lang"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.targetLang = radio.value;
      render(); // 언어별 저장된 설정 반영
    });
  });

  document.getElementById('prev-btn').addEventListener('click', () => { state.currentStep = 2; render(); });
  document.getElementById('next-btn').addEventListener('click', () => {
    // 설정 저장
    saveCurrentSettings();

    // 매칭 실행
    state.matchResults = matchSubtitles(
      state.parsedProject.subtitles,
      state.sheetData.rows,
      state.parsedProject.title,
      state.targetLang
    );

    state.currentStep = 4;
    render();
  });
}

function saveCurrentSettings() {
  const fontSettings = loadFontSettings();
  fontSettings[state.targetLang] = {
    fontPath: document.getElementById('font-path').value,
    fontId: document.getElementById('font-id').value,
    fontTitle: document.getElementById('font-title').value,
    fontResourceId: document.getElementById('font-id').value,
  };
  saveFontSettings(fontSettings);
  state.fontConfig = fontSettings[state.targetLang];

  const styleSettings = loadStyleSettings();
  styleSettings[state.targetLang] = {
    textColor: document.getElementById('text-color').value,
    borderColor: document.getElementById('border-color').value,
    borderWidth: parseFloat(document.getElementById('border-width').value),
    fontSize: parseFloat(document.getElementById('font-size').value),
  };
  saveStyleSettings(styleSettings);
  state.styleConfig = styleSettings[state.targetLang];
}

// =============================================
// Step 4: 매칭 미리보기
// =============================================
function renderStep4() {
  const results = state.matchResults;
  const stats = {
    matched: results.filter(r => r.status === 'matched').length,
    mismatch: results.filter(r => r.status === 'mismatch').length,
    missing: results.filter(r => r.status.startsWith('missing')).length,
  };

  const rows = results.map((r, i) => {
    const badgeCls = r.status === 'matched' ? 'badge-matched'
      : r.status === 'mismatch' ? 'badge-mismatch'
      : 'badge-missing';
    const statusLabel = r.status === 'matched' ? '일치'
      : r.status === 'mismatch' ? '불일치'
      : r.status === 'missing_sheet' ? '시트 없음'
      : r.status === 'missing_capcut' ? '캡컷 없음'
      : '번역 없음';

    return `
      <tr>
        <td>${r.type === 'title' ? 'T' : r.index + 1}</td>
        <td title="${escHtml(r.capcutEnglish)}">${escHtml(truncate(r.capcutEnglish, 35))}</td>
        <td title="${escHtml(r.capcutTranslation)}">${escHtml(truncate(r.capcutTranslation, 25))}</td>
        <td title="${escHtml(r.sheetTarget)}">${escHtml(truncate(r.sheetTarget, 30))}</td>
        <td><span class="badge ${badgeCls}">${statusLabel}</span></td>
      </tr>
    `;
  }).join('');

  return `
    <div class="card">
      <h2>4. 매칭 미리보기</h2>
      <div class="summary" style="margin-bottom:16px;">
        <div class="summary-row"><span>일치</span><span style="color:var(--success)">${stats.matched}건</span></div>
        <div class="summary-row"><span>불일치</span><span style="color:var(--warning)">${stats.mismatch}건</span></div>
        <div class="summary-row"><span>누락</span><span style="color:var(--error)">${stats.missing}건</span></div>
      </div>
      <div style="overflow-x:auto;">
        <table class="match-table">
          <thead>
            <tr>
              <th>#</th>
              <th>캡컷 영어</th>
              <th>캡컷 번역</th>
              <th>시트 ${state.targetLang === 'cn' ? '중국어' : '일본어'}</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="prev-btn">← 이전</button>
      <button class="btn btn-primary" id="next-btn">변환 진행 →</button>
    </div>
  `;
}

function bindStep4() {
  document.getElementById('prev-btn').addEventListener('click', () => { state.currentStep = 3; render(); });
  document.getElementById('next-btn').addEventListener('click', () => { state.currentStep = 5; render(); });
}

// =============================================
// Step 5: 변환 + 다운로드
// =============================================
function renderStep5() {
  if (state.downloadReady) {
    return `
      <div class="card" style="text-align:center;">
        <h2>변환 완료!</h2>
        <p style="margin:16px 0;">프로젝트가 성공적으로 변환되었습니다.</p>
        <button class="btn btn-success" id="download-btn" style="font-size:16px;padding:14px 32px;">ZIP 다운로드</button>
        <div style="margin-top:12px;">
          <button class="btn btn-secondary" id="log-btn">로그 다운로드</button>
        </div>
      </div>
      <div class="nav-buttons">
        <button class="btn btn-secondary" id="prev-btn">← 이전</button>
        <button class="btn btn-secondary" id="restart-btn">처음으로</button>
      </div>
    `;
  }

  return `
    <div class="card" style="text-align:center;">
      <h2>5. 변환</h2>
      <p style="margin:16px 0;">변환을 시작하면 수정된 캡컷 프로젝트를 ZIP으로 다운로드할 수 있습니다.</p>
      <button class="btn btn-primary" id="convert-btn" style="font-size:16px;padding:14px 32px;" ${state.converting ? 'disabled' : ''}>
        ${state.converting ? '변환 중...' : '변환 시작'}
      </button>
      <div class="progress-bar" id="progress" style="display:${state.converting ? 'block' : 'none'}">
        <div class="progress-fill" id="progress-fill" style="width:0%"></div>
      </div>
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="prev-btn">← 이전</button>
      <div></div>
    </div>
  `;
}

function bindStep5() {
  document.getElementById('prev-btn')?.addEventListener('click', () => { state.currentStep = 4; render(); });

  document.getElementById('convert-btn')?.addEventListener('click', startConversion);

  document.getElementById('download-btn')?.addEventListener('click', () => {
    const langLabel = state.targetLang.toUpperCase();
    downloadBlob(state.resultBlob, `${state.projectData.projectName}_${langLabel}.zip`);
  });

  document.getElementById('log-btn')?.addEventListener('click', () => logger.downloadLog());

  document.getElementById('restart-btn')?.addEventListener('click', () => {
    state.currentStep = 1;
    state.downloadReady = false;
    state.resultBlob = null;
    render();
  });
}

async function startConversion() {
  state.converting = true;
  render();

  try {
    // hex 색상을 [r,g,b] 배열 (0~1)로 변환
    const hexToRgb = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      return [r, g, b];
    };

    // 폰트/스타일 설정 준비
    const fontConfig = state.fontConfig.fontPath ? state.fontConfig : null;
    const styleConfig = state.styleConfig.textColor ? {
      fillColor: hexToRgb(state.styleConfig.textColor),
      strokeColor: hexToRgb(state.styleConfig.borderColor),
      strokeWidth: state.styleConfig.borderWidth,
      fontSize: state.styleConfig.fontSize,
      textColor: state.styleConfig.textColor,
      borderColor: state.styleConfig.borderColor,
      borderWidth: state.styleConfig.borderWidth,
    } : null;

    // 교체 목록 생성 (matched 상태인 것만)
    const replacements = state.matchResults
      .filter(r => r.materialId && r.sheetTarget && (r.status === 'matched' || r.status === 'mismatch'))
      .map(r => ({
        materialId: r.materialId,
        newTranslation: r.sheetTarget,
        fontConfig,
        styleConfig,
      }));

    logger.info(CATEGORIES.CONVERT, `변환 시작: ${replacements.length}건`);

    // 변환 실행
    const modifiedDraftInfo = applyReplacements(state.projectData.draftInfo, replacements);

    // ZIP 패키징
    const langLabel = state.targetLang.toUpperCase();
    state.resultBlob = await packageProject(
      state.projectData.files,
      modifiedDraftInfo,
      state.projectData.projectName,
      langLabel
    );

    state.downloadReady = true;
    state.converting = false;
    logger.info(CATEGORIES.CONVERT, '변환 및 패키징 완료');
    render();
  } catch (e) {
    state.converting = false;
    logger.error(CATEGORIES.CONVERT, `변환 실패: ${e.message}`, { stack: e.stack });
    alert(`변환 실패: ${e.message}\n\n로그를 다운로드해서 확인해주세요.`);
    render();
  }
}

// 유틸
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

// 초기 렌더링
render();
