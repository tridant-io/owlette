/** Bytes → "95.8 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/** Strict `major.minor.patch` — no prerelease or build metadata. */
export function isValidVersion(version: string): boolean {
  const semverRegex = /^\d+\.\d+\.\d+$/;
  return semverRegex.test(version);
}

/** "512.5 / 1024.0 GB" — both values share the unit chosen from the total. */
export function formatStorageRange(usedGb: number, totalGb: number): string {
  if (totalGb >= 1000) {
    const usedTb = usedGb / 1000;
    const totalTb = totalGb / 1000;
    return `${usedTb.toFixed(1)} / ${totalTb.toFixed(1)} TB`;
  }
  return `${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB`;
}
