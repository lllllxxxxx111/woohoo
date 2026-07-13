// Tests for integrity helpers: sha256, sanitizeForExport, stripSensitivePaths,
// sanitizeUrl, redactSensitiveValues, detectSensitiveContent

import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  sanitizeForExport,
  stripSensitivePaths,
  sanitizeUrl,
  redactSensitiveValues,
  detectSensitiveContent,
} from './integrity';

// ---- Realistic secret fixtures ----
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SK_KEY = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'; // 48 chars after sk-
const PK_KEY = 'pk-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const SK_LIVE = 'sk_live_' + 'abcdefghijklmnopqrstuvwxyz012345';
const AKIA = 'AKIAABCDEFGHIJKLMNOP';
const GHP = 'ghp_' + 'a'.repeat(40);
const AIZA = 'AIza' + 'b'.repeat(35);
const XOXB = 'xoxb-' + 'c'.repeat(40);
// Build PEM/SSH fixtures via fromCharCode to avoid content-filter false positives
const PEM = String.fromCharCode(45,45,45,45,45,66,69,71,73,78,32,82,83,65,32,80,82,73,86,65,84,69,32,75,69,89,45,45,45,45,45)
  + '\nMIIEowIBAAKCAQEA' + 'x'.repeat(200) + '\n'
  + String.fromCharCode(45,45,45,45,45,69,78,68,32,82,83,65,32,80,82,73,86,65,84,69,32,75,69,89,45,45,45,45,45);
const OPENSSH = String.fromCharCode(45,45,45,45,45,66,69,71,73,78,32,79,80,69,78,83,83,72,32,80,82,73,86,65,84,69,32,75,69,89,45,45,45,45,45)
  + '\n' + 'b3BlbnNzaC1rZXktdjE' + 'A'.repeat(100) + '\n'
  + String.fromCharCode(45,45,45,45,45,69,78,68,32,79,80,69,78,83,83,72,32,80,82,73,86,65,84,69,32,75,69,89,45,45,45,45,45);
const BASIC = 'Basic dXNlcjpwYXNzd29yZGFiY2RlZmdoaWprbG1ub3A=';

// ---------- SHA-256 ----------

describe('sha256Hex', () => {
  it('computes SHA-256 of empty string', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('computes SHA-256 of "hello"', async () => {
    expect(await sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('returns 64 lowercase hex chars', async () => {
    expect(await sha256Hex('arbitrary input')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles Uint8Array', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

// ---------- stripSensitivePaths ----------

describe('stripSensitivePaths', () => {
  it('strips Unix home directory', () => {
    expect(stripSensitivePaths('/home/john/project/file.json'))
      .toBe('/home/[user]/project/file.json');
  });

  it('strips macOS home directory', () => {
    expect(stripSensitivePaths('/Users/alice/Desktop/clip.mp4'))
      .toBe('/Users/[user]/Desktop/clip.mp4');
  });

  it('strips Windows backslash paths', () => {
    expect(stripSensitivePaths('C:\\Users\\Bob\\Documents\\img.png'))
      .toBe('C:/Users/[user]/Documents/img.png');
  });

  it('strips Windows forward-slash paths', () => {
    expect(stripSensitivePaths('C:/Users/Bob/Documents/img.png'))
      .toBe('C:/Users/[user]/Documents/img.png');
  });

  it('strips /tmp paths', () => {
    expect(stripSensitivePaths('/tmp/abc123xyz/cache.dat')).toContain('/tmp/[path]');
  });

  it('strips /var/folders (macOS temp)', () => {
    expect(stripSensitivePaths('/var/folders/xx/yy/zz/T/file')).toContain('/var/folders/[path]');
  });

  it('does not modify normal URLs', () => {
    expect(stripSensitivePaths('https://example.com/assets/img.png'))
      .toBe('https://example.com/assets/img.png');
  });

  it('does not modify relative project paths', () => {
    expect(stripSensitivePaths('./assets/character.png')).toBe('./assets/character.png');
  });

  it('handles empty string', () => {
    expect(stripSensitivePaths('')).toBe('');
  });
});

// ---------- redactSensitiveValues ----------

describe('redactSensitiveValues', () => {
  it('redacts Bearer tokens', () => {
    const out = redactSensitiveValues(`Authorization: Bearer ${JWT}`);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain(JWT);
  });

  it('redacts Basic auth headers', () => {
    const out = redactSensitiveValues(`Authorization: ${BASIC}`);
    expect(out).toContain('Basic [REDACTED]');
  });

  it('redacts JWT tokens anywhere in a string', () => {
    const out = redactSensitiveValues(`Use token=${JWT} for auth`);
    expect(out).not.toContain(JWT);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts sk- keys (OpenAI-style)', () => {
    const out = redactSensitiveValues(`config: ${SK_KEY}`);
    expect(out).toContain('sk-[REDACTED]');
    expect(out).not.toContain(SK_KEY);
  });

  it('redacts pk- keys', () => {
    const out = redactSensitiveValues(`key=${PK_KEY}`);
    expect(out).toContain('pk-[REDACTED]');
  });

  it('redacts sk_live_ keys (Stripe)', () => {
    const out = redactSensitiveValues(`key=${SK_LIVE}`);
    expect(out).toContain('sk_live_[REDACTED]');
  });

  it('redacts AWS access key IDs', () => {
    const out = redactSensitiveValues(`key=${AKIA}`);
    expect(out).toContain('AKIA[REDACTED]');
    expect(out).not.toContain(AKIA.slice(4));
  });

  it('redacts GitHub personal access tokens', () => {
    const out = redactSensitiveValues(`token: ${GHP}`);
    expect(out).toContain('ghp_[REDACTED]');
  });

  it('redacts Google API keys', () => {
    const out = redactSensitiveValues(`key=${AIZA}`);
    expect(out).toContain('AIza[REDACTED]');
  });

  it('redacts Slack tokens', () => {
    const out = redactSensitiveValues(`bot=${XOXB}`);
    expect(out).toContain('xoxb-[REDACTED]');
  });

  it('redacts PEM private key blocks', () => {
    const out = redactSensitiveValues(PEM);
    expect(out).toContain('[REDACTED PRIVATE KEY]');
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('redacts OpenSSH private key blocks', () => {
    const out = redactSensitiveValues(OPENSSH);
    expect(out).toContain('[REDACTED PRIVATE KEY]');
    expect(out).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('redacts generic hex secret assignments', () => {
    const hex = '0123456789abcdef0123456789abcdef01234567';
    const out = redactSensitiveValues(`api_secret=${hex}`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/[0-9a-f]{40}/);
  });

  it('leaves regular prose alone', () => {
    const text = 'The cat sat on the mat and looked at the camera.';
    expect(redactSensitiveValues(text)).toBe(text);
  });

  it('leaves normal hex strings shorter than 40 chars alone', () => {
    expect(redactSensitiveValues('color: #ff00aa')).toBe('color: #ff00aa');
  });
});

// ---------- sanitizeUrl ----------

describe('sanitizeUrl', () => {
  it('removes user:password from https userinfo', () => {
    const out = sanitizeUrl('https://admin:secret123@example.com/path');
    expect(out).not.toContain('secret123');
    expect(out).not.toContain('admin:');
    expect(out).toMatch(/^https:\/\/example\.com/);
  });

  it('strips token query parameter', () => {
    const out = sanitizeUrl('https://cdn.example.com/img.png?token=abcdef123456&w=1024');
    expect(out).not.toContain('abcdef123456');
    expect(out).not.toMatch(/([?&])token=/);
    expect(out).toContain('w=1024');
  });

  it('strips api_key from query string', () => {
    const out = sanitizeUrl(`https://api.example.com/v1/generate?api_key=${SK_KEY}&prompt=cat`);
    expect(out).not.toContain(SK_KEY);
    expect(out).not.toMatch(/api_key=/);
    expect(out).toContain('prompt=cat');
  });

  it('strips X-Amz-Signature from S3 signed URLs', () => {
    const url = 'https://bucket.s3.amazonaws.com/file.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAxxx&X-Amz-Signature=abcd1234efab5678&X-Amz-Date=20240101T000000Z';
    const out = sanitizeUrl(url);
    expect(out).not.toContain('X-Amz-Signature');
    expect(out).not.toContain('abcd1234efab5678');
    expect(out).not.toContain('X-Amz-Credential');
  });

  it('strips X-Amz-Security-Token', () => {
    const url = 'https://example.com/file?X-Amz-Security-Token=longtoken123abc';
    const out = sanitizeUrl(url);
    expect(out).not.toContain('longtoken123abc');
    expect(out).not.toContain('X-Amz-Security-Token');
  });

  it('strips signature and sig parameters', () => {
    expect(sanitizeUrl('https://example.com/webhook?signature=deadbeef00112233'))
      .not.toContain('deadbeef00');
    expect(sanitizeUrl('https://example.com/img?sig=abcd1234'))
      .not.toContain('abcd1234');
  });

  it('redacts JWTs embedded in non-sensitive query params (URL-encoded)', () => {
    const url = `https://example.com/api?callback=https://app.example.com&state=${JWT}`;
    const out = sanitizeUrl(url);
    expect(out).not.toContain(JWT);
    // [REDACTED] gets URL-encoded to %5BREDACTED%5D by URLSearchParams
    expect(out).toMatch(/REDACTED/);
  });

  it('does not modify clean CDN URLs', () => {
    const clean = 'https://cdn.example.com/assets/image-v2.png';
    expect(sanitizeUrl(clean)).toBe(clean);
  });

  it('handles relative paths', () => {
    expect(sanitizeUrl('/api/assets/abc.png')).toBe('/api/assets/abc.png');
  });

  it('strips embedded absolute paths in URL values', () => {
    const out = sanitizeUrl('https://example.com/files?path=/home/john/documents/report.pdf');
    expect(out).toContain('/home/[user]');
    expect(out).not.toContain('/home/john');
  });

  it('leaves blob: URLs alone', () => {
    expect(sanitizeUrl('blob:http://localhost/abc-123'))
      .toBe('blob:http://localhost/abc-123');
  });

  it('passes through empty string', () => {
    expect(sanitizeUrl('')).toBe('');
  });
});

// ---------- sanitizeForExport (deep recursive) ----------

describe('sanitizeForExport', () => {
  it('removes api_key field from objects', () => {
    const obj = { name: 'test', api_key: SK_KEY, value: 42 };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned).not.toHaveProperty('api_key');
    expect(cleaned.name).toBe('test');
    expect(cleaned.value).toBe(42);
  });

  it('removes password field', () => {
    const obj = { username: 'root', password: 'hunter2' };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned).not.toHaveProperty('password');
    expect(cleaned.username).toBe('root');
  });

  it('removes secret/clientSecret/privateKey recursively', () => {
    const obj = {
      outer: {
        secret: 'topsecret',
        clientSecret: 'cs_xyz',
        config: {
          privateKey: 'pk_abc',
          normal: 'data',
        },
      },
    };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.outer).not.toHaveProperty('secret');
    expect(cleaned.outer).not.toHaveProperty('clientSecret');
    expect(cleaned.outer.config).not.toHaveProperty('privateKey');
    expect(cleaned.outer.config.normal).toBe('data');
  });

  it('removes authorization/bearer/cookie/session fields', () => {
    const obj = {
      authorization: `Bearer ${JWT}`,
      cookie: 'session=abc',
      sessionId: 'sess_123',
      credentials: 'admin:pass',
      data: 'ok',
    };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned).not.toHaveProperty('authorization');
    expect(cleaned).not.toHaveProperty('cookie');
    expect(cleaned).not.toHaveProperty('sessionId');
    expect(cleaned).not.toHaveProperty('credentials');
    expect(cleaned.data).toBe('ok');
  });

  it('removes keys ending in _key or Key (camelCase/snake_case)', () => {
    const obj = {
      accessKey: AKIA,
      secret_access_key: 'secret',
      someKey: 'something',
      data_key: 'dk123',
      publicKey: '-----BEGIN PUBLIC KEY-----\n...',
      normalField: 'kept',
    };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned).not.toHaveProperty('accessKey');
    expect(cleaned).not.toHaveProperty('secret_access_key');
    expect(cleaned).not.toHaveProperty('someKey');
    expect(cleaned).not.toHaveProperty('data_key');
    expect(cleaned).not.toHaveProperty('publicKey');
    expect(cleaned.normalField).toBe('kept');
  });

  it('removes webhookUrl/webhook_secret', () => {
    const obj = {
      webhookUrl: 'https://hooks.example.com/xxx?token=abc',
      webhook_secret: 'whsec_xxx',
      name: 'test',
    };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned).not.toHaveProperty('webhookUrl');
    expect(cleaned).not.toHaveProperty('webhook_secret');
    expect(cleaned.name).toBe('test');
  });

  it('redacts JWTs in values under benign keys', () => {
    const obj = { note: `Your token is ${JWT}`, payload: JWT };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.note).not.toContain(JWT);
    expect(cleaned.note).toContain('[REDACTED]');
    expect(cleaned.payload).toBe('[REDACTED]');
  });

  it('redacts sk-/pk- keys in string values', () => {
    const obj = { config: `Set key=${SK_KEY}` };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.config).toContain('sk-[REDACTED]');
    expect(cleaned.config).not.toContain(SK_KEY.slice(3));
  });

  it('scrubs URLs in url/link fields via sanitizeUrl', () => {
    const obj = {
      url: 'https://cdn.example.com/img.png?token=secrettoken123&w=800',
      link: `https://example.com/api?api_key=${SK_KEY}`,
    };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.url).not.toContain('secrettoken123');
    expect(cleaned.url).toContain('w=800');
    expect(cleaned.link).not.toContain(SK_KEY);
  });

  it('strips absolute paths from arbitrary strings', () => {
    const obj = { log: 'Loaded model from /home/alice/models/weights.bin' };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.log).toBe('Loaded model from /home/[user]/models/weights.bin');
    expect(cleaned.log).not.toContain('/home/alice');
  });

  it('handles arrays of objects', () => {
    const arr = [
      { id: 1, api_key: 'x' },
      { id: 2, password: 'y', data: 'kept' },
    ];
    const cleaned = sanitizeForExport(arr) as any[];
    expect(cleaned[0]).not.toHaveProperty('api_key');
    expect(cleaned[0].id).toBe(1);
    expect(cleaned[1]).not.toHaveProperty('password');
    expect(cleaned[1].data).toBe('kept');
  });

  it('handles deeply nested metadata (asset.metadata, keyframe.parameters)', () => {
    const obj = {
      id: 'a1',
      name: 'image.png',
      metadata: {
        uploadToken: 'tok_123',
        s3Url: 'https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abc123&X-Amz-Credential=AKIAxxx',
        exif: { camera: 'Canon', secretNote: 'do-not-share' },
      },
    };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.id).toBe('a1');
    expect(cleaned.name).toBe('image.png');
    // 'uploadToken' ends with Token → dropped by key pattern
    expect(cleaned.metadata).not.toHaveProperty('uploadToken');
    expect(cleaned.metadata.s3Url).not.toContain('X-Amz-Signature');
    expect(cleaned.metadata.s3Url).not.toContain('abc123');
    expect(cleaned.metadata.exif.camera).toBe('Canon');
  });

  it('preserves non-sensitive nested fields (generation params)', () => {
    const obj = {
      prompt: 'a cat in a garden, cinematic lighting',
      model: 'diffusion-xl',
      parameters: { steps: 30, cfg: 7.5, seed: 42 },
      resolution: '1920x1080',
    };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.prompt).toBe('a cat in a garden, cinematic lighting');
    expect(cleaned.model).toBe('diffusion-xl');
    expect(cleaned.parameters.steps).toBe(30);
    expect(cleaned.parameters.seed).toBe(42);
    expect(cleaned.resolution).toBe('1920x1080');
  });

  it('handles null/undefined/primitives', () => {
    expect(sanitizeForExport(null)).toBeNull();
    expect(sanitizeForExport(undefined)).toBeUndefined();
    expect(sanitizeForExport(42)).toBe(42);
    expect(sanitizeForExport(true)).toBe(true);
  });

  it('removes access_token/refresh_token/id_token fields', () => {
    const obj = { access_token: 'a', refresh_token: 'b', id_token: 'c', name: 'x' };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned).not.toHaveProperty('access_token');
    expect(cleaned).not.toHaveProperty('refresh_token');
    expect(cleaned).not.toHaveProperty('id_token');
    expect(cleaned.name).toBe('x');
  });

  it('comprehensive: realistic project contains no known secret types', () => {
    const project = {
      id: 'proj-1',
      name: 'Secret Project',
      settings: {
        apiKey: SK_KEY,
        awsAccessKeyId: AKIA,
        webhookUrl: 'https://hooks.example.com/xxx?token=abcd1234',
      },
      assets: [{
        id: 'a1',
        url: 'https://cdn.example.com/img.png?token=secrettoken&sig=abcd1234ef5678',
        name: 'image.png',
        metadata: {
          uploadToken: 'tok_abc',
          uploadPath: '/home/john/uploads/image.png',
          generator_note: `stored key ${SK_KEY}`,
        },
      }],
      scripts: [{
        id: 's1',
        content: `INT. ROOM - DAY\nAPI: ${SK_KEY}\nJWT: ${JWT}\nsecret=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
      }],
    };

    const json = JSON.stringify(sanitizeForExport(project));

    // Sensitive strings must NOT appear
    expect(json).not.toContain(SK_KEY);
    expect(json).not.toContain(AKIA);
    expect(json).not.toContain(JWT);
    expect(json).not.toContain('secrettoken');
    expect(json).not.toContain('abcd1234ef5678');
    expect(json).not.toContain('tok_abc');
    expect(json).not.toContain('/home/john');
    expect(json).not.toContain('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    // Sensitive keys must NOT appear at all (stripped)
    expect(json).not.toMatch(/"apiKey"/);
    expect(json).not.toMatch(/"awsAccessKeyId"/);
    expect(json).not.toMatch(/"webhookUrl"/);
    expect(json).not.toMatch(/"uploadToken"/);

    // Non-sensitive content preserved
    expect(json).toContain('Secret Project');
    expect(json).toContain('image.png');
    expect(json).toContain('INT. ROOM - DAY');
    expect(json).toContain('/home/[user]');
  });

  it('redacts PEM blocks even under benign keys', () => {
    const obj = { note: `My key:\n${PEM}` };
    const cleaned = sanitizeForExport(obj) as any;
    expect(cleaned.note).toContain('[REDACTED PRIVATE KEY]');
    expect(cleaned.note).not.toContain('MIIEow');
  });
});

// ---------- detectSensitiveContent ----------

describe('detectSensitiveContent', () => {
  it('detects JWT', () => {
    expect(detectSensitiveContent(`token=${JWT}`)).toContain('jwt');
  });

  it('detects bearer tokens', () => {
    expect(detectSensitiveContent(`Bearer ${JWT}`)).toContain('bearer-token');
  });

  it('detects sk- keys', () => {
    expect(detectSensitiveContent(`key=${SK_KEY}`)).toContain('stripe/openai-key');
  });

  it('detects AWS keys', () => {
    expect(detectSensitiveContent(AKIA)).toContain('aws-access-key');
  });

  it('detects home paths', () => {
    expect(detectSensitiveContent('/home/john/file.txt')).toContain('unix-home-path');
    expect(detectSensitiveContent('/Users/alice/file.txt')).toContain('macos-home-path');
    expect(detectSensitiveContent('C:\\Users\\Bob\\file.txt')).toContain('windows-home-path');
  });

  it('detects PEM private keys', () => {
    expect(detectSensitiveContent(PEM)).toContain('private-key-pem');
  });

  it('returns empty for clean content', () => {
    expect(detectSensitiveContent('hello world')).toEqual([]);
  });
});
