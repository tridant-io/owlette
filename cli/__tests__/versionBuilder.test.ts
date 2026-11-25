import {
  VERSION_MEDIA_TYPE,
  VERSION_SCHEMA_VERSION,
  buildVersion,
  summariseVersion,
  uniqueHashes,
  versionIdForVersion,
} from '../src/lib/versionBuilder';

const FILES = [
  { path: 'z/last.bin', size: 10, chunks: [{ hash: 'h1'.repeat(32), size: 10 }] },
  { path: 'a/first.bin', size: 5, chunks: [{ hash: 'h2'.repeat(32), size: 5 }] },
  { path: 'middle.bin', size: 20, chunks: [{ hash: 'h1'.repeat(32), size: 20 }] },
];

describe('buildVersion', () => {
  it('returns an OCI-shape object with the fixed mediaType + schemaVersion', () => {
    const m = buildVersion(FILES);
    expect(m.schemaVersion).toBe(VERSION_SCHEMA_VERSION);
    expect(m.mediaType).toBe(VERSION_MEDIA_TYPE);
  });

  it('sorts files by path for deterministic output', () => {
    const m = buildVersion(FILES);
    expect(m.files.map((f) => f.path)).toEqual(['a/first.bin', 'middle.bin', 'z/last.bin']);
  });

  it('leaves config empty, as the dashboard uploader does', () => {
    expect(buildVersion(FILES).config).toEqual({});
  });

  it('builds identical versionIds for identical input', () => {
    const a = buildVersion(FILES);
    const b = buildVersion(FILES);
    expect(versionIdForVersion(a)).toBe(versionIdForVersion(b));
  });
});

describe('uniqueHashes', () => {
  it('dedups chunk hashes across files', () => {
    const hashes = uniqueHashes(FILES);
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain('h1'.repeat(32));
    expect(hashes).toContain('h2'.repeat(32));
  });
});

describe('summariseVersion', () => {
  it('computes file count, total bytes, total chunks, unique chunks', () => {
    const s = summariseVersion(FILES);
    expect(s.fileCount).toBe(3);
    expect(s.totalBytes).toBe(35);
    expect(s.totalChunks).toBe(3);
    expect(s.uniqueChunks).toBe(2);
  });
});
