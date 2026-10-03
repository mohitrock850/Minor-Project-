'use strict';

/**
 * Authentication primitives.
 *
 * Tokens are HMAC-SHA256 signed, self-contained and stateless. The signing
 * secret is generated on first run and stored in app_settings, so it is unique
 * per installation and survives restarts without a config file.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');

const TOKEN_TTL_SECONDS = 12 * 60 * 60;   // a working day
const SECRET_KEY = 'auth_token_secret';

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(plain), hash);
  } catch {
    return false;
  }
}

function getSecret() {
  const row = db.get('SELECT value FROM app_settings WHERE key = ?', [SECRET_KEY]);
  if (row && row.value) return row.value;
  const secret = crypto.randomBytes(48).toString('hex');
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SECRET_KEY, secret]
  );
  return secret;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadJson) {
  return crypto.createHmac('sha256', getSecret()).update(payloadJson).digest('base64url');
}

function issueToken(user) {
  const payload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    collegeId: user.college_id || null,
    facultyId: user.faculty_id || null,
    studentId: user.student_id || null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const json = JSON.stringify(payload);
  return `${b64u(json)}.${sign(json)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  let json;
  try {
    json = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(json);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = {
  TOKEN_TTL_SECONDS,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
};
