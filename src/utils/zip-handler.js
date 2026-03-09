/**
 * JSZip 래퍼 — ZIP 압축/해제 처리
 */

import JSZip from 'jszip';
import { logger, CATEGORIES } from '../core/logger.js';

/**
 * ZIP 파일 또는 폴더에서 draft_info.json 추출
 * @param {File|FileList} input - ZIP 파일 또는 폴더의 파일 목록
 * @returns {Promise<{ draftInfo: object, files: Map<string, Blob>, projectName: string }>}
 */
export async function extractProject(input) {
  if (input instanceof File && input.name.endsWith('.zip')) {
    return extractFromZip(input);
  } else if (input instanceof FileList || Array.isArray(input)) {
    return extractFromFiles(input);
  }
  throw new Error('지원하지 않는 입력 형식입니다. ZIP 파일 또는 폴더를 선택해주세요.');
}

/**
 * ZIP 파일에서 추출
 */
async function extractFromZip(zipFile) {
  logger.info(CATEGORIES.FILE, `ZIP 파일 열기: ${zipFile.name} (${formatSize(zipFile.size)})`);

  const zip = await JSZip.loadAsync(zipFile);
  const files = new Map();
  let draftInfo = null;
  let draftInfoPath = null;

  // ZIP 내 모든 파일 순회
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;

    const fileName = path.split('/').pop();

    if (fileName === 'draft_info.json') {
      const text = await entry.async('text');
      try {
        draftInfo = JSON.parse(text);
        draftInfoPath = path;
        logger.info(CATEGORIES.FILE, `draft_info.json 발견: ${path}`);
      } catch (e) {
        logger.error(CATEGORIES.FILE, `draft_info.json 파싱 실패: ${e.message}`);
      }
    }

    // 모든 파일을 Blob으로 저장 (나중에 재압축용)
    const blob = await entry.async('blob');
    files.set(path, blob);
  }

  if (!draftInfo) {
    throw new Error('ZIP 내에서 draft_info.json을 찾을 수 없습니다.');
  }

  // 프로젝트명 추출 (ZIP 내 최상위 폴더명 또는 ZIP 파일명)
  const projectName = draftInfoPath.includes('/')
    ? draftInfoPath.split('/')[0]
    : zipFile.name.replace('.zip', '');

  logger.info(CATEGORIES.FILE, `프로젝트 추출 완료: ${projectName}, 파일 ${files.size}개`);
  return { draftInfo, files, projectName };
}

/**
 * 폴더 파일 목록에서 추출 (File System Access API 또는 input[webkitdirectory])
 */
async function extractFromFiles(fileList) {
  const filesArray = Array.from(fileList);
  logger.info(CATEGORIES.FILE, `폴더에서 파일 ${filesArray.length}개 로드`);

  const files = new Map();
  let draftInfo = null;
  let projectName = '';

  for (const file of filesArray) {
    // webkitRelativePath에서 상대 경로 추출
    const relativePath = file.webkitRelativePath || file.name;
    files.set(relativePath, file);

    if (file.name === 'draft_info.json') {
      const text = await file.text();
      try {
        draftInfo = JSON.parse(text);
        logger.info(CATEGORIES.FILE, `draft_info.json 발견: ${relativePath}`);
      } catch (e) {
        logger.error(CATEGORIES.FILE, `draft_info.json 파싱 실패: ${e.message}`);
      }

      // 프로젝트명 = 폴더명
      if (relativePath.includes('/')) {
        projectName = relativePath.split('/')[0];
      }
    }
  }

  if (!draftInfo) {
    throw new Error('폴더 내에서 draft_info.json을 찾을 수 없습니다.');
  }

  if (!projectName) {
    projectName = 'capcut_project';
  }

  logger.info(CATEGORIES.FILE, `프로젝트 추출 완료: ${projectName}, 파일 ${files.size}개`);
  return { draftInfo, files, projectName };
}

/**
 * 수정된 프로젝트를 ZIP으로 패키징
 * @param {Map<string, Blob|File>} originalFiles - 원본 파일들
 * @param {object} modifiedDraftInfo - 수정된 draft_info.json
 * @param {string} projectName - 프로젝트 이름
 * @param {string} langSuffix - 언어 접미사 ('CN' | 'JP')
 * @returns {Promise<Blob>} ZIP Blob
 */
export async function packageProject(originalFiles, modifiedDraftInfo, projectName, langSuffix) {
  logger.info(CATEGORIES.FILE, `프로젝트 패키징 시작: ${projectName}_${langSuffix}`);

  const zip = new JSZip();
  const newProjectName = `${projectName}_${langSuffix}`;

  for (const [path, blob] of originalFiles) {
    const fileName = path.split('/').pop();

    // 경로에서 원본 프로젝트명을 새 이름으로 교체
    let newPath = path;
    if (path.startsWith(projectName + '/')) {
      newPath = newProjectName + '/' + path.slice(projectName.length + 1);
    } else if (!path.includes('/')) {
      newPath = newProjectName + '/' + path;
    }

    if (fileName === 'draft_info.json') {
      // 수정된 JSON으로 교체
      const jsonStr = JSON.stringify(modifiedDraftInfo, null, 2);
      zip.file(newPath, jsonStr);
      logger.info(CATEGORIES.FILE, `draft_info.json 교체: ${newPath}`);
    } else if (fileName === 'draft_info.json.bak') {
      // 백업 파일도 교체 (캡컷이 참조할 수 있음)
      const jsonStr = JSON.stringify(modifiedDraftInfo, null, 2);
      zip.file(newPath, jsonStr);
    } else {
      // 나머지 파일은 그대로 복사
      zip.file(newPath, blob);
    }
  }

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }, (metadata) => {
    // 진행률 콜백 (선택적)
    if (metadata.percent % 20 < 1) {
      logger.info(CATEGORIES.FILE, `압축 진행: ${Math.round(metadata.percent)}%`);
    }
  });

  logger.info(CATEGORIES.FILE, `패키징 완료: ${formatSize(zipBlob.size)}`);
  return zipBlob;
}

/**
 * Blob 다운로드
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  logger.info(CATEGORIES.FILE, `다운로드: ${filename}`);
}

/**
 * 파일 크기 포맷
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
