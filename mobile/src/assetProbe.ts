export const assetProbeExpectedFiles = [
  {
    role: 'bundle_metadata',
    relativePath: 'metadata.json',
    expectedBytes: 1091,
    expectedSHA256:
      '2771755c5042bc9b400ff99c320b8689b32aa2751351fa5fa137df72208fa801',
  },
  {
    role: 'asset_metadata',
    relativePath: 'gemma4-e2b-32k-group8-rmscomposite.aimodel/metadata.json',
    expectedBytes: 406,
    expectedSHA256:
      '68bc28f74571f1617d9b888841d33351ebdb2f72be77294c255f520957ef92db',
  },
  {
    role: 'stored_main_hash',
    relativePath: 'gemma4-e2b-32k-group8-rmscomposite.aimodel/main.hash',
    expectedBytes: 32,
    expectedSHA256:
      'abbf299e92e76280e6e5ce0bde11b9cabc5ad75c6a5f94d979299d07d3b2cece',
  },
  {
    role: 'main_bytecode',
    relativePath: 'gemma4-e2b-32k-group8-rmscomposite.aimodel/main.mlirb',
    expectedBytes: 1381786497,
    expectedSHA256:
      'bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362',
  },
] as const;

export const abliteratedAssetProbeExpectedFiles = [
  {
    role: 'bundle_metadata',
    relativePath: 'metadata.json',
    expectedBytes: 1254,
    expectedSHA256:
      'b91f1f01ac034431a73ea3de2ae7cf085d0b95e42cfcf20217e0e5c6b42ad609',
  },
  {
    role: 'asset_metadata',
    relativePath:
      'gemma4-e2b-32k-group8-abliterated-rmscomposite.aimodel/metadata.json',
    expectedBytes: 541,
    expectedSHA256:
      '2aa87f8b98e2c715a0c977a6a4e4a2f39c07aaf828a1b36f87ad68b036013943',
  },
  {
    role: 'stored_main_hash',
    relativePath:
      'gemma4-e2b-32k-group8-abliterated-rmscomposite.aimodel/main.hash',
    expectedBytes: 32,
    expectedSHA256:
      'd4e97fee1fe0516e35aa445dd62c7e25b337d5d32b84543609b2edca89e177f5',
  },
  {
    role: 'main_bytecode',
    relativePath:
      'gemma4-e2b-32k-group8-abliterated-rmscomposite.aimodel/main.mlirb',
    expectedBytes: 1381786507,
    expectedSHA256:
      'a46f84f3bf569ac06da3b86eb24400c31b367da5b831566da0786987f863c8f0',
  },
] as const;

export const assetProbeIdentities = {
  'gemma4-e2b-32k-group8-rmscomposite': assetProbeExpectedFiles,
  'gemma4-e2b-32k-group8-abliterated-rmscomposite':
    abliteratedAssetProbeExpectedFiles,
} as const;
export type AssetProbeModelName = keyof typeof assetProbeIdentities;

export const assetProbeMeasurementMethods = {
  scope:
    'Hashes four pinned F16 asset files only; no Core AI APIs, inference, specialization, cache inspection or model writes',
  hash: 'SHA-256 over a 64 KiB read stream; whole model data is never retained',
  stability:
    'Directory-relative no-follow opens; regular files only; descriptor and path identity, size, mtime and ctime checked before and after',
  storedHash:
    'main.hash contains 32 raw SHA-256 bytes; compare with main.mlirb and the pinned F16 source digest',
  unverified:
    'PLE and tokenizer payloads, future file stability, Core AI readability/cache state and actual accelerator placement remain unverified',
  failure:
    'Constant safe error codes only; a pending record is the last persisted boundary, not proof of a crash',
} as const;

type AssetProbeStage = 'checking_files' | 'completed' | 'failed';
export type AssetProbeFileRole =
  (typeof assetProbeExpectedFiles)[number]['role'];
const errorCodes = [
  'E_ASSET_IDENTITY_LOCAL_ONLY',
  'E_ASSET_IDENTITY_IO',
  'E_ASSET_IDENTITY_CHANGED',
  'E_ASSET_IDENTITY_MISMATCH',
] as const;
export type AssetProbeErrorCode = (typeof errorCodes)[number];
type AssetProbeFile = {
  role: AssetProbeFileRole;
  relativePath: string;
  expectedBytes: number;
  expectedSHA256: string;
  bytesRead: number;
  sha256?: string;
  matchesExpected?: boolean;
};
export type ModelAssetProbeReport = {
  schemaVersion: 1;
  kind: 'assistModelAssetDiagnostic';
  scope: 'selected_f16_asset_identity_only_no_coreai';
  expectedModelName: AssetProbeModelName;
  contextCapacity: 32768;
  nativeBuild: string;
  osVersion: string;
  attempt: {
    id: string;
    startedAtUTC: string;
    processIdentifier: number;
    entryPoint: 'selected_f16_asset_identity_probe';
  };
  stage: AssetProbeStage;
  files: AssetProbeFile[];
  currentFileRole?: AssetProbeFileRole;
  storedMainHashMatches?: boolean;
  errorCode?: AssetProbeErrorCode;
  posixErrno?: number;
  measurementMethods: typeof assetProbeMeasurementMethods;
};

function invalid(): never {
  throw new Error('Rapport d’identité de l’asset invalide.');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function text(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    utf8Bytes(value) > maximumBytes ||
    Array.from(value).some(character => {
      const point = character.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159);
    })
  ) {
    return invalid();
  }
  return value;
}

/** A pending saved marker identifies a read boundary; it never triggers another read. */
export function parseAssetProbeReport(
  json: string,
): ModelAssetProbeReport | null {
  if (json.length > 32768 || utf8Bytes(json) > 32768) {
    throw new Error('Rapport d’identité de l’asset trop volumineux.');
  }
  const decoded: unknown = JSON.parse(json);
  if (decoded === null) {
    return null;
  }
  const value = record(decoded);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'assistModelAssetDiagnostic' ||
    value.scope !== 'selected_f16_asset_identity_only_no_coreai' ||
    typeof value.expectedModelName !== 'string' ||
    !Object.prototype.hasOwnProperty.call(
      assetProbeIdentities,
      value.expectedModelName,
    ) ||
    value.contextCapacity !== 32768 ||
    typeof value.stage !== 'string' ||
    !['checking_files', 'completed', 'failed'].includes(value.stage) ||
    !Array.isArray(value.files) ||
    value.files.length !== 4
  ) {
    return invalid();
  }
  const modelName = value.expectedModelName as AssetProbeModelName;
  const expectedFiles = assetProbeIdentities[modelName];
  const attempt = record(value.attempt);
  const id = text(attempt.id, 36);
  const startedAtUTC = text(attempt.startedAtUTC, 24);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startedAtUTC) ||
    !Number.isFinite(Date.parse(startedAtUTC)) ||
    new Date(startedAtUTC).toISOString() !== startedAtUTC ||
    typeof attempt.processIdentifier !== 'number' ||
    !Number.isInteger(attempt.processIdentifier) ||
    attempt.processIdentifier < 1 ||
    attempt.processIdentifier > 2147483647 ||
    attempt.entryPoint !== 'selected_f16_asset_identity_probe'
  ) {
    return invalid();
  }
  const files = value.files.map((item, index): AssetProbeFile => {
    const file = record(item);
    const expected = expectedFiles[index];
    if (
      file.role !== expected.role ||
      file.relativePath !== expected.relativePath ||
      file.expectedBytes !== expected.expectedBytes ||
      file.expectedSHA256 !== expected.expectedSHA256 ||
      typeof file.bytesRead !== 'number' ||
      !Number.isSafeInteger(file.bytesRead) ||
      file.bytesRead < 0 ||
      file.bytesRead > expected.expectedBytes + 65536 ||
      (file.sha256 !== undefined) !== (file.matchesExpected !== undefined)
    ) {
      return invalid();
    }
    const result: AssetProbeFile = { ...expected, bytesRead: file.bytesRead };
    if (file.sha256 !== undefined) {
      const sha256 = text(file.sha256, 64);
      const matches =
        sha256 === expected.expectedSHA256 &&
        file.bytesRead === expected.expectedBytes;
      if (
        !/^[0-9a-f]{64}$/.test(sha256) ||
        file.bytesRead !== expected.expectedBytes ||
        typeof file.matchesExpected !== 'boolean' ||
        file.matchesExpected !== matches
      ) {
        return invalid();
      }
      result.sha256 = sha256;
      result.matchesExpected = matches;
    }
    return result;
  });
  const methods = record(value.measurementMethods);
  for (const key of Object.keys(assetProbeMeasurementMethods) as Array<
    keyof typeof assetProbeMeasurementMethods
  >) {
    if (methods[key] !== assetProbeMeasurementMethods[key]) {
      return invalid();
    }
  }
  const stage = value.stage as AssetProbeStage;
  if (stage === 'checking_files' && value.storedMainHashMatches !== undefined) {
    return invalid();
  }
  const result: ModelAssetProbeReport = {
    schemaVersion: 1,
    kind: 'assistModelAssetDiagnostic',
    scope: 'selected_f16_asset_identity_only_no_coreai',
    expectedModelName: modelName,
    contextCapacity: 32768,
    nativeBuild: text(value.nativeBuild, 32),
    osVersion: text(value.osVersion, 160),
    attempt: {
      id,
      startedAtUTC,
      processIdentifier: attempt.processIdentifier,
      entryPoint: 'selected_f16_asset_identity_probe',
    },
    stage,
    files,
    measurementMethods: { ...assetProbeMeasurementMethods },
  };
  if (stage === 'completed') {
    if (
      value.currentFileRole !== undefined ||
      !files.every(file => file.matchesExpected === true) ||
      value.storedMainHashMatches !== true
    ) {
      return invalid();
    }
  } else {
    const currentIndex = expectedFiles.findIndex(
      file => file.role === value.currentFileRole,
    );
    if (
      currentIndex < 0 ||
      files.some((file, index) =>
        index < currentIndex
          ? file.sha256 === undefined
          : index > currentIndex &&
            (file.bytesRead !== 0 || file.sha256 !== undefined),
      )
    ) {
      return invalid();
    }
    result.currentFileRole = expectedFiles[currentIndex].role;
  }
  if (value.storedMainHashMatches !== undefined) {
    if (
      typeof value.storedMainHashMatches !== 'boolean' ||
      !files.every(file => file.sha256 !== undefined)
    ) {
      return invalid();
    }
    result.storedMainHashMatches = value.storedMainHashMatches;
  }
  if ((stage === 'failed') !== (value.errorCode !== undefined)) {
    return invalid();
  }
  if (value.errorCode !== undefined) {
    if (!errorCodes.includes(value.errorCode as AssetProbeErrorCode)) {
      return invalid();
    }
    result.errorCode = value.errorCode as AssetProbeErrorCode;
  }
  if (value.posixErrno !== undefined) {
    if (
      stage !== 'failed' ||
      !['E_ASSET_IDENTITY_IO', 'E_ASSET_IDENTITY_CHANGED'].includes(
        result.errorCode ?? '',
      ) ||
      typeof value.posixErrno !== 'number' ||
      !Number.isInteger(value.posixErrno) ||
      value.posixErrno < 1 ||
      value.posixErrno > 4095
    ) {
      return invalid();
    }
    result.posixErrno = value.posixErrno;
  }
  return result;
}
