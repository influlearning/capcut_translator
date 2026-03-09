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
  targetLangs: ['cn', 'jp'],  // 체크박스: 둘 다 기본 선택
  fontConfigs: {},   // { cn: {...}, jp: {...} }
  styleConfigs: {},  // { cn: {...}, jp: {...} }
  // Step 4: 매칭 (언어별)
  matchResultsByLang: {},  // { cn: [...], jp: [...] }
  // Step 5: 결과 (언어별)
  converting: false,
  downloadReady: false,
  resultBlobs: {},  // { cn: Blob, jp: Blob }
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
// Step 3: 설정 (멀티 언어 체크박스)
// =============================================
function renderStep3() {
  const savedFont = loadFontSettings();
  const savedStyle = loadStyleSettings();

  // 원본 프로젝트에서 기본 스타일 추출
  const firstSub = state.parsedProject?.subtitles?.[0];
  const origFontPath = firstSub?.rawMaterial?.font_path || '';
  const origFontId = firstSub?.rawMaterial?.font_id || '';

  const langOptions = [
    { code: 'cn', label: '中文 (중국어)' },
    { code: 'jp', label: '日本語 (일본어)' },
  ];

  const checkboxes = langOptions.map(l =>
    `<label><input type="checkbox" name="target-lang" value="${l.code}" ${state.targetLangs.includes(l.code) ? 'checked' : ''}> ${l.label}</label>`
  ).join('\n');

  // 선택된 언어별 설정 패널
  const langPanels = state.targetLangs.map(lang => {
    const langFont = savedFont[lang] || {};
    const langStyle = savedStyle[lang] || {};
    const langLabel = lang === 'cn' ? '중국어' : '일본어';

    return `
      <div style="margin-top:20px;padding:16px;background:var(--bg);border-radius:var(--radius);">
        <h3 style="font-size:15px;margin-bottom:12px;">${langLabel} 설정</h3>

        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">폰트</h4>
        <div class="settings-grid">
          <div class="input-group">
            <label>폰트 경로</label>
            <input type="text" id="font-path-${lang}" placeholder="${origFontPath || '/Users/.../font.ttf'}" value="${langFont.fontPath || ''}">
          </div>
          <div class="input-group">
            <label>폰트 ID</label>
            <input type="text" id="font-id-${lang}" placeholder="${origFontId || '6808056385679397389'}" value="${langFont.fontId || ''}">
          </div>
          <div class="input-group">
            <label>폰트 이름</label>
            <input type="text" id="font-title-${lang}" placeholder="예: 고딕체" value="${langFont.fontTitle || ''}">
          </div>
        </div>

        <h4 style="font-size:13px;color:var(--text-muted);margin:12px 0 8px;">스타일</h4>
        <div class="settings-grid">
          <div class="input-group">
            <label>텍스트 색상</label>
            <input type="color" id="text-color-${lang}" value="${langStyle.textColor || '#ffffff'}" style="height:40px;">
          </div>
          <div class="input-group">
            <label>테두리 색상</label>
            <input type="color" id="border-color-${lang}" value="${langStyle.borderColor || '#000000'}" style="height:40px;">
          </div>
          <div class="input-group">
            <label>테두리 두께 (0~0.15)</label>
            <input type="number" id="border-width-${lang}" step="0.01" min="0" max="0.15" value="${langStyle.borderWidth || '0.08'}">
          </div>
          <div class="input-group">
            <label>글씨 크기</label>
            <input type="number" id="font-size-${lang}" step="0.5" min="1" max="30" value="${langStyle.fontSize || '10'}">
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card">
      <h2>3. 번역 설정</h2>

      <div class="input-group">
        <label>타겟 언어 (복수 선택 가능)</label>
        <div class="radio-group">
          ${checkboxes}
        </div>
      </div>

      ${langPanels}

      <p style="font-size:12px;color:var(--text-muted);margin-top:12px;">
        * 폰트 경로/ID는 CapCut에서 해당 폰트를 한 번 사용한 뒤, 프로젝트 파일에서 확인할 수 있습니다.<br>
        * 원본 폰트 경로: <code style="font-size:11px;">${origFontPath || '(프로젝트 업로드 후 표시)'}</code>
      </p>
    </div>
    <div class="nav-buttons">
      <button class="btn btn-secondary" id="prev-btn">← 이전</button>
      <button class="btn btn-primary" id="next-btn" ${state.targetLangs.length === 0 ? 'disabled' : ''}>다음 →</button>
    </div>
  `;
}

function bindStep3() {
  document.querySelectorAll('input[name="target-lang"]').forEach(cb => {
    cb.addEventListener('change', () => {
      state.targetLangs = [...document.querySelectorAll('input[name="target-lang"]:checked')]
        .map(el => el.value);
      render(); // 체크 상태 변경 시 설정 패널 갱신
    });
  });

  document.getElementById('prev-btn').addEventListener('click', () => { state.currentStep = 2; render(); });
  document.getElementById('next-btn').addEventListener('click', () => {
    if (state.targetLangs.length === 0) return alert('언어를 최소 1개 선택해주세요.');

    // 설정 저장
    saveCurrentSettings();

    // 각 언어별 매칭 실행
    state.matchResultsByLang = {};
    for (const lang of state.targetLangs) {
      state.matchResultsByLang[lang] = matchSubtitles(
        state.parsedProject.subtitles,
        state.sheetData.rows,
        state.parsedProject.title,
        lang
      );
    }

    state.currentStep = 4;
    render();
  });
}

function saveCurrentSettings() {
  const fontSettings = loadFontSettings();
  const styleSettings = loadStyleSettings();

  for (const lang of state.targetLangs) {
    fontSettings[lang] = {
      fontPath: document.getElementById(`font-path-${lang}`)?.value || '',
      fontId: document.getElementById(`font-id-${lang}`)?.value || '',
      fontTitle: document.getElementById(`font-title-${lang}`)?.value || '',
      fontResourceId: document.getElementById(`font-id-${lang}`)?.value || '',
    };
    styleSettings[lang] = {
      textColor: document.getElementById(`text-color-${lang}`)?.value || '#ffffff',
      borderColor: document.getElementById(`border-color-${lang}`)?.value || '#000000',
      borderWidth: parseFloat(document.getElementById(`border-width-${lang}`)?.value || '0.08'),
      fontSize: parseFloat(document.getElementById(`font-size-${lang}`)?.value || '10'),
    };
  }

  saveFontSettings(fontSettings);
  saveStyleSettings(styleSettings);
  state.fontConfigs = fontSettings;
  state.styleConfigs = styleSettings;
}

// =============================================
// Step 4: 매칭 미리보기 (언어별 섹션)
// =============================================
function renderStep4() {
  const sections = state.targetLangs.map(lang => {
    const results = state.matchResultsByLang[lang] || [];
    const langLabel = lang === 'cn' ? '중국어' : '일본어';
    const stats = {
      matched: results.filter(r => r.status === 'matched').length,
      mismatch: results.filter(r => r.status === 'mismatch').length,
      missing: results.filter(r => r.status.startsWith('missing')).length,
    };

    const rows = results.map(r => {
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
      <div style="margin-bottom:24px;">
        <h3 style="font-size:16px;margin-bottom:8px;">${langLabel}</h3>
        <div class="summary" style="margin-bottom:12px;">
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
                <th>시트 ${langLabel}</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card">
      <h2>4. 매칭 미리보기</h2>
      ${sections}
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
// Step 5: 변환 + 다운로드 (언어별 ZIP)
// =============================================
function renderStep5() {
  if (state.downloadReady) {
    const downloadBtns = state.targetLangs.map(lang => {
      const langName = lang === 'cn' ? '중국어' : '일본어';
      return `<button class="btn btn-success download-lang-btn" data-lang="${lang}" style="font-size:16px;padding:14px 32px;margin:4px;">${langName} ZIP 다운로드</button>`;
    }).join('');

    return `
      <div class="card" style="text-align:center;">
        <h2>변환 완료!</h2>
        <p style="margin:16px 0;">프로젝트가 성공적으로 변환되었습니다.</p>
        <div style="margin:16px 0;">
          ${downloadBtns}
        </div>
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
      <p style="margin:16px 0;">변환을 시작하면 언어별 수정된 캡컷 프로젝트를 ZIP으로 다운로드할 수 있습니다.</p>
      <p style="font-size:13px;color:var(--text-muted);">대상: ${state.targetLangs.map(l => l === 'cn' ? '중국어' : '일본어').join(', ')}</p>
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

  document.querySelectorAll('.download-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      const langLabel = lang.toUpperCase();
      downloadBlob(state.resultBlobs[lang], `${state.projectData.projectName}_${langLabel}.zip`);
    });
  });

  document.getElementById('log-btn')?.addEventListener('click', () => logger.downloadLog());

  document.getElementById('restart-btn')?.addEventListener('click', () => {
    state.currentStep = 1;
    state.downloadReady = false;
    state.resultBlobs = {};
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

    const totalLangs = state.targetLangs.length;
    let completed = 0;

    for (const lang of state.targetLangs) {
      const langLabel = lang.toUpperCase();
      logger.info(CATEGORIES.CONVERT, `${langLabel} 변환 시작`);

      // 해당 언어의 폰트/스타일 설정
      const langFontConfig = state.fontConfigs[lang] || {};
      const langStyleConfig = state.styleConfigs[lang] || {};

      const fontConfig = langFontConfig.fontPath ? langFontConfig : null;
      const styleConfig = langStyleConfig.textColor ? {
        fillColor: hexToRgb(langStyleConfig.textColor),
        strokeColor: hexToRgb(langStyleConfig.borderColor),
        strokeWidth: langStyleConfig.borderWidth,
        fontSize: langStyleConfig.fontSize,
        textColor: langStyleConfig.textColor,
        borderColor: langStyleConfig.borderColor,
        borderWidth: langStyleConfig.borderWidth,
      } : null;

      // 해당 언어의 매칭 결과에서 교체 목록 생성
      const matchResults = state.matchResultsByLang[lang] || [];
      const replacements = matchResults
        .filter(r => r.materialId && r.sheetTarget && (r.status === 'matched' || r.status === 'mismatch'))
        .map(r => ({
          materialId: r.materialId,
          newTranslation: r.sheetTarget,
          fontConfig,
          styleConfig,
        }));

      logger.info(CATEGORIES.CONVERT, `${langLabel}: ${replacements.length}건 교체`);

      // 변환 실행 (원본에서 깊은 복사 후 적용)
      const modifiedDraftInfo = applyReplacements(state.projectData.draftInfo, replacements);

      // ZIP 패키징
      state.resultBlobs[lang] = await packageProject(
        state.projectData.files,
        modifiedDraftInfo,
        state.projectData.projectName,
        langLabel
      );

      completed++;
      const progressEl = document.getElementById('progress-fill');
      if (progressEl) progressEl.style.width = `${(completed / totalLangs) * 100}%`;
    }

    state.downloadReady = true;
    state.converting = false;
    logger.info(CATEGORIES.CONVERT, `전체 변환 완료: ${state.targetLangs.map(l => l.toUpperCase()).join(', ')}`);
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
