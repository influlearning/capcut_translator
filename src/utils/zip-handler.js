/**
 * JSZip 래퍼 — ZIP 압축/해제 + 폴더 내보내기 처리
 */

import JSZip from 'jszip';
import { logger, CATEGORIES } from '../core/logger.js';

/**
 * ZIP 파일 또는 폴더에서 draft_info.json 추출
 * @param {File|FileList|FileSystemDirectoryHandle} input
 * @returns {Promise<{ draftInfo: object, files: Map<string, Blob>, projectName: string }>}
 */
export async function extractProject(input) {
  if (input instanceof File && input.name.endsWith('.zip')) {
    return extractFromZip(input);
  } else if (input instanceof FileList || Array.isArray(input)) {
    return extractFromFiles(input);
  } else if (input?.kind === 'directory') {
    // File System Access API의 DirectoryHandle
    return extractFromDirectoryHandle(input);
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
 * 폴더 파일 목록에서 추출 (input[webkitdirectory])
 * 파일 내용을 메모리에 미리 로드하여 변환 시 접근 실패 방지
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

    // 파일 내용을 메모리로 미리 로드 (나중에 파일 접근 실패 방지)
    try {
      const arrayBuffer = await file.arrayBuffer();
      files.set(relativePath, new Blob([arrayBuffer], { type: file.type }));
    } catch (e) {
      logger.warn(CATEGORIES.FILE, `파일 로드 실패 (스킵): ${relativePath} - ${e.message}`);
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
 * File System Access API의 DirectoryHandle에서 추출
 * showDirectoryPicker()로 선택된 폴더를 재귀적으로 읽음
 */
async function extractFromDirectoryHandle(dirHandle) {
  logger.info(CATEGORIES.FILE, `폴더 열기 (File System Access): ${dirHandle.name}`);

  const files = new Map();
  let draftInfo = null;
  const projectName = dirHandle.name;

  // 재귀적 디렉토리 순회
  async function readDir(handle, prefix) {
    for await (const entry of handle.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.kind === 'file') {
        const file = await entry.getFile();

        if (entry.name === 'draft_info.json' && !draftInfo) {
          const text = await file.text();
          try {
            draftInfo = JSON.parse(text);
            logger.info(CATEGORIES.FILE, `draft_info.json 발견: ${path}`);
          } catch (e) {
            logger.error(CATEGORIES.FILE, `draft_info.json 파싱 실패: ${e.message}`);
          }
        }

        // 메모리로 미리 로드
        try {
          const arrayBuffer = await file.arrayBuffer();
          files.set(path, new Blob([arrayBuffer], { type: file.type }));
        } catch (e) {
          logger.warn(CATEGORIES.FILE, `파일 로드 실패 (스킵): ${path} - ${e.message}`);
        }
      } else if (entry.kind === 'directory') {
        await readDir(entry, path);
      }
    }
  }

  await readDir(dirHandle, projectName);

  if (!draftInfo) {
    throw new Error('폴더 내에서 draft_info.json을 찾을 수 없습니다.');
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
 * 수정된 프로젝트를 폴더로 직접 내보내기
 * File System Access API를 사용하여 선택된 디렉토리에 프로젝트 폴더 생성
 *
 * @param {FileSystemDirectoryHandle} parentDirHandle - 상위 디렉토리 핸들
 * @param {Map<string, Blob>} originalFiles - 원본 파일들
 * @param {object} modifiedDraftInfo - 수정된 draft_info.json
 * @param {string} projectName - 원본 프로젝트 이름
 * @param {string} langSuffix - 언어 접미사 ('CN' | 'JP')
 * @returns {Promise<string>} 생성된 폴더 이름
 */
export async function exportToFolder(parentDirHandle, originalFiles, modifiedDraftInfo, projectName, langSuffix) {
  const baseName = `${projectName}_${langSuffix}`;
  logger.info(CATEGORIES.FILE, `폴더 내보내기 시작: ${baseName}`);

  // 동일 폴더 있으면 숫자 붙여서 회피 (baseName → baseName_1 → baseName_2)
  let finalName = baseName;
  let counter = 0;
  while (true) {
    try {
      await parentDirHandle.getDirectoryHandle(finalName);
      // 이미 존재 → 다음 번호 시도
      counter++;
      finalName = `${baseName}_${counter}`;
    } catch {
      // 존재하지 않음 → 이 이름 사용
      break;
    }
  }

  if (finalName !== baseName) {
    logger.info(CATEGORIES.FILE, `폴더 충돌 회피: ${baseName} → ${finalName}`);
  }

  const projectDir = await parentDirHandle.getDirectoryHandle(finalName, { create: true });

  let fileCount = 0;
  for (const [path, blob] of originalFiles) {
    const fileName = path.split('/').pop();

    // 원본 경로에서 프로젝트명 부분 제거하여 상대 경로 구성
    let relativePath;
    if (path.startsWith(projectName + '/')) {
      relativePath = path.slice(projectName.length + 1);
    } else if (!path.includes('/')) {
      relativePath = path;
    } else {
      relativePath = path;
    }

    // draft_info.json은 수정된 버전으로 교체
    let content;
    if (fileName === 'draft_info.json' || fileName === 'draft_info.json.bak') {
      content = JSON.stringify(modifiedDraftInfo, null, 2);
    } else {
      content = blob;
    }

    // 하위 디렉토리 생성 + 파일 쓰기
    const parts = relativePath.split('/');
    const name = parts.pop();
    let currentDir = projectDir;
    for (const dir of parts) {
      currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
    }

    const fileHandle = await currentDir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    fileCount++;
  }

  logger.info(CATEGORIES.FILE, `폴더 내보내기 완료: ${finalName} (${fileCount}개 파일)`);
  return finalName;
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
