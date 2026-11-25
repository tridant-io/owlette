/** @jest-environment node */

/**
 * installerStorage.server — installers on R2 behind the download host: which
 * bucket and public url each environment uses, what a presigned upload signs,
 * and the streamed size + sha256 read back at finalize.
 */

import { createHash } from 'crypto';

const mockSend = jest.fn();
const mockS3Config = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((config: unknown) => {
    mockS3Config(config);
    return { send: mockSend };
  }),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'get', input })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'put', input })),
  HeadObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'head', input })),
  CopyObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'copy', input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'delete', input })),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetSignedUrl = jest.fn();
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...a: unknown[]) => mockGetSignedUrl(...a),
}));

import logger from '@/lib/logger';
import {
  discardInstallerUpload,
  installerPublicUrl,
  installerStagingKey,
  isInstallerPublicUrl,
  isInstallerR2Configured,
  presignInstallerUpload,
  publishInstaller,
  publishedInstallerSha256,
  readInstaller,
} from '@/lib/installerStorage.server';

const ENV_KEYS = ['R2_S3_ENDPOINT', 'INSTALLER_R2_ACCESS_KEY_ID', 'INSTALLER_R2_SECRET_ACCESS_KEY', 'ROOST_ENV'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.R2_S3_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
  process.env.INSTALLER_R2_ACCESS_KEY_ID = 'key-id';
  process.env.INSTALLER_R2_SECRET_ACCESS_KEY = 'key-secret';
  process.env.ROOST_ENV = 'dev';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

describe('isInstallerR2Configured', () => {
  it('is true only with the endpoint and both halves of the key', () => {
    expect(isInstallerR2Configured()).toBe(true);
    process.env.INSTALLER_R2_SECRET_ACCESS_KEY = ' ';
    expect(isInstallerR2Configured()).toBe(false);
    process.env.INSTALLER_R2_SECRET_ACCESS_KEY = 'key-secret';
    delete process.env.R2_S3_ENDPOINT;
    expect(isInstallerR2Configured()).toBe(false);
  });
});

describe('installerPublicUrl', () => {
  it('serves dev from the staging host and prod from download.tridant.io', () => {
    expect(installerPublicUrl('Owlette-Installer-v4.1.7.exe')).toBe(
      'https://download-staging.tridant.io/owlette/Owlette-Installer-v4.1.7.exe',
    );
    process.env.ROOST_ENV = 'prod';
    expect(installerPublicUrl('Owlette-Installer-v4.1.7.exe')).toBe(
      'https://download.tridant.io/owlette/Owlette-Installer-v4.1.7.exe',
    );
  });

  it('recognises only this environment host as the download host', () => {
    expect(isInstallerPublicUrl('https://download-staging.tridant.io/owlette/x.exe')).toBe(true);
    expect(isInstallerPublicUrl('https://download.tridant.io/owlette/x.exe')).toBe(false);
    expect(isInstallerPublicUrl('https://storage.googleapis.com/b/x.exe')).toBe(false);
  });
});

describe('presignInstallerUpload', () => {
  it('signs a PUT of the named file into the environment bucket, content type included', async () => {
    mockGetSignedUrl.mockResolvedValue('https://acct.r2.cloudflarestorage.com/signed');

    const url = await presignInstallerUpload('Owlette-Installer-v4.1.7.pkg', 'application/octet-stream', 900);

    expect(url).toBe('https://acct.r2.cloudflarestorage.com/signed');
    const [, command, options] = mockGetSignedUrl.mock.calls[0];
    expect(command.input).toEqual({
      Bucket: 'owlette-downloads-staging',
      Key: 'Owlette-Installer-v4.1.7.pkg',
      ContentType: 'application/octet-stream',
    });
    expect(options.expiresIn).toBe(900);
    expect([...options.signableHeaders]).toEqual(['content-type']);
    // no checksum of the empty presign body may be signed into the url
    expect(mockS3Config).toHaveBeenCalledWith(
      expect.objectContaining({ requestChecksumCalculation: 'WHEN_REQUIRED', forcePathStyle: true }),
    );
  });
});

describe('readInstaller', () => {
  it('hashes the object as it streams and counts its bytes', async () => {
    process.env.ROOST_ENV = 'prod';
    mockSend.mockResolvedValue({ Body: chunks('hello ', 'world'), ContentType: 'application/vnd.debian.binary-package' });

    const result = await readInstaller('uploads/u1');

    expect(result).toEqual({
      size: 11,
      sha256: createHash('sha256').update('hello world').digest('hex'),
      contentType: 'application/vnd.debian.binary-package',
    });
    expect(mockSend.mock.calls[0][0].input).toEqual({ Bucket: 'owlette-downloads', Key: 'uploads/u1' });
  });

  it('returns null when nothing was uploaded', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    await expect(readInstaller('Owlette-Installer-v4.1.7.exe')).resolves.toBeNull();
  });

  it('throws on any other storage error, so finalize reports it rather than a missing file', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    );
    await expect(readInstaller('Owlette-Installer-v4.1.7.exe')).rejects.toThrow('denied');
  });
});

describe('staging and publishing', () => {
  it('stages an upload under uploads/, which the worker never serves', () => {
    expect(installerStagingKey('abc-123')).toBe('uploads/abc-123');
  });

  it('reads the sha256 a published name was copied with', async () => {
    mockSend.mockResolvedValue({ Metadata: { sha256: 'f'.repeat(64) } });
    await expect(publishedInstallerSha256('Owlette-Installer-v4.1.7.exe')).resolves.toBe('f'.repeat(64));
    expect(mockSend.mock.calls[0][0]).toEqual({
      kind: 'head',
      input: { Bucket: 'owlette-downloads-staging', Key: 'Owlette-Installer-v4.1.7.exe' },
    });
  });

  it('says null for a name that is not published, and empty for one without a recorded sha256', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    await expect(publishedInstallerSha256('Owlette-Installer-v4.1.7.exe')).resolves.toBeNull();
    mockSend.mockResolvedValueOnce({ Metadata: {} });
    await expect(publishedInstallerSha256('Owlette-Installer-v4.1.7.exe')).resolves.toBe('');
  });

  it('copies a staged upload to its public name with its sha256', async () => {
    mockSend.mockResolvedValue({});

    await publishInstaller('uploads/u1', 'Owlette-Installer-v4.1.7.pkg', 'e'.repeat(64), 'application/octet-stream');

    expect(mockSend.mock.calls[0][0]).toEqual({
      kind: 'copy',
      input: {
        Bucket: 'owlette-downloads-staging',
        Key: 'Owlette-Installer-v4.1.7.pkg',
        CopySource: 'owlette-downloads-staging/uploads/u1',
        MetadataDirective: 'REPLACE',
        ContentType: 'application/octet-stream',
        Metadata: { sha256: 'e'.repeat(64) },
      },
    });
  });

  it('drops a staging object, and only warns when it cannot', async () => {
    mockSend.mockResolvedValueOnce({});
    await discardInstallerUpload('uploads/u1');
    expect(mockSend.mock.calls[0][0]).toEqual({
      kind: 'delete',
      input: { Bucket: 'owlette-downloads-staging', Key: 'uploads/u1' },
    });

    mockSend.mockRejectedValueOnce(new Error('denied'));
    await expect(discardInstallerUpload('uploads/u2')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      '[installer] staging object not removed',
      expect.objectContaining({ data: { stagingKey: 'uploads/u2', error: 'denied' } }),
    );
  });
});
